/**
 * Řetěz mikroher z jedné věty (P56C T7). Kola se berou v pořadí: slovesa věty (`VERB_MICROS`), svět věty
 * (`WORLD_MICROS`), výplň z `MICRO` losem ze streamu `chain`; žádné ovládání dvakrát, boss na konec.
 * Každé kolo je návrh žánru téže věty (`draftGenreFor`) se stejným hrdinou, místem a vzhledem, pak `microSpec`.
 * Stavba bere jen kola, která robot vyhraje (`runBot`); plnou bránu dělá `verifyChain` u volajícího (publikace, měření).
 */

import { arcadeWorldOf } from '../arcade/compile';
import { replay } from '../arcade/kernel';
import { ARCADE_LIBRARY } from '../arcade/library';
import { lookFor, type LookId } from '../arcade/look';
import { runBot } from '../arcade/verify';
import { draftGenreFor } from '../draft/draft';
import { CAST_MAX, FOE_DOES, type GenreSpec } from '../genre/contract';
import type { VerbClass } from '../read/schema';
import { createStreams, nextInt } from '../../sim/rng';
import { CARD_TICKS, type ChainWorld } from './contract';
import { MICRO, type MicroEntry, type MicroKey, genreModeOf, microSpec } from './micro';
import type { SentenceRead } from './read';
import { chainFromSpecs, type RoundPlan, roundRate } from './run';
import { CHAIN_SECONDS, chainLengthSec } from './verify';

/** Kola včetně bosse: 4 kola vycházejí těsně nad 30 s, krátká kola (načasování, střelba) potřebují 5 (T6). */
export const CHAIN_ROUNDS = 5;

/** Semínka na kolo, než stavba vezme jinou mikrohru (plošinovka s obsazením věty: robot vyhraje 5–10 z 12 rozložení). */
const SEED_TRIES = 4;

/** Které mikrohry sloveso hraje, první = nejvěrnější. `idle` a `sandbox` kolo nedají. */
export const VERB_MICROS: Readonly<Record<VerbClass, readonly MicroKey[]>> = {
  tap_go: ['hop.default'],
  runner: ['runner.default', 'hop.default'],
  platform: ['platformer.default'],
  flap: ['flap.default'],
  steer: ['runner.default', 'crowd.default'],
  aim_shoot: ['shooter.default'],
  throw: ['shooter.default', 'whack.default'],
  timing: ['timing.precision', 'timing.stack'],
  rhythm: ['rhythm.default'],
  melee: ['duel.default', 'whack.default'],
  move_free: ['catch.default', 'platformer.default'],
  manipulate: ['whack.default', 'timing.stack'],
  build_place: ['timing.stack', 'defense.default'],
  idle: [],
  sandbox: [],
};

/** Kola, která svět dodá, když je věta nejmenuje. */
export const WORLD_MICROS: Readonly<Record<LookId, readonly MicroKey[]>> = {
  meadow: ['hop.default', 'catch.default', 'runner.default'],
  city: ['runner.default', 'crowd.default', 'shooter.default'],
  mall: ['catch.default', 'runner.default', 'crowd.default'],
  supermarket: ['catch.default', 'runner.default', 'whack.default'],
  living_room: ['whack.default', 'timing.stack', 'rhythm.default'],
  factory: ['timing.stack', 'defense.default', 'runner.default'],
  forest: ['hop.default', 'catch.default', 'platformer.default'],
  jungle: ['platformer.default', 'hop.default', 'runner.default'],
  desert: ['runner.default', 'shooter.default', 'hop.default'],
  beach: ['catch.default', 'flap.default', 'timing.stack'],
  ocean: ['catch.default', 'flap.default', 'hop.default'],
  underwater: ['flap.default', 'catch.default', 'shooter.default'],
  snow: ['runner.default', 'hop.default', 'catch.default'],
  volcano: ['runner.default', 'platformer.default', 'defense.default'],
  cave: ['platformer.default', 'flap.default', 'whack.default'],
  space: ['shooter.default', 'flap.default', 'runner.default'],
  castle: ['defense.default', 'duel.default', 'platformer.default'],
  graveyard: ['whack.default', 'runner.default', 'defense.default'],
};

/** Boss, kterého sloveso volá; ostatní slovesa berou bosse losem. */
const VERB_BOSS: Partial<Readonly<Record<VerbClass, MicroKey>>> = {
  aim_shoot: 'shooter.default.boss',
  throw: 'shooter.default.boss',
  melee: 'duel.default.boss',
  build_place: 'defense.default.boss',
};

const entryOf = (key: MicroKey): MicroEntry => MICRO.find((entry) => entry.key === key)!;

/** Pořadí `keys` zamíchané streamem (Fisher–Yates); stejné semínko = stejné pořadí. */
function shuffled<T>(keys: readonly T[], stream: ReturnType<typeof createStreams>['chain']): T[] {
  const out = [...keys];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = nextInt(stream, 0, index);
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

/** Návrh kola se stejným hrdinou, místem a vzhledem; boss dostane protivníka věty do obsazení. */
function sameWorld(draft: GenreSpec, shared: Pick<GenreSpec, 'hero' | 'setting' | 'palette'>, foe: string | null): GenreSpec {
  const { palette: _own, ...rest } = draft;
  const spec = { ...rest, ...shared } as GenreSpec;
  if (foe === null || spec.cast?.some((member) => member.label === foe)) return spec;
  return { ...spec, cast: [{ label: foe, does: FOE_DOES[spec.genre] }, ...(spec.cast ?? [])].slice(0, CAST_MAX) } as GenreSpec;
}

interface Built {
  readonly plan: RoundPlan;
  readonly control: MicroEntry['control'];
  readonly ticks: number;
}

const draftOf = (sentence: string, entry: MicroEntry): GenreSpec | null => {
  const { genre, mode } = genreModeOf(entry);
  return draftGenreFor(sentence, genre, mode);
};

export function buildChain(sentence: string, read: SentenceRead, seed: number): { readonly ok: true; readonly chain: ChainWorld } | { readonly ok: false; readonly issues: readonly string[] } {
  // Výběr i semínka kol z jednoho streamu `chain`; `chainFromSpecs` pak los nepotřebuje.
  const stream = createStreams(seed).chain;
  const plain = shuffled(MICRO.filter((entry) => entry.boss !== true).map((entry) => entry.key), stream);
  const bosses = shuffled(MICRO.filter((entry) => entry.boss === true).map((entry) => entry.key), stream);
  const order = [...new Set([...read.verbs.flatMap((verb) => VERB_MICROS[verb.class]), ...(read.look === null ? [] : WORLD_MICROS[read.look]), ...plain])].map(entryOf);

  const first = order.map((entry) => draftOf(sentence, entry)).find((draft) => draft !== null);
  if (first === undefined) return { ok: false, issues: ['the sentence drafts no microgame'] };
  const palette = read.look ?? first.palette ?? lookFor(first.setting) ?? undefined;
  const shared = { hero: read.hero ?? first.hero, setting: first.setting, ...(palette === undefined ? {} : { palette }) };

  /**
   * Kolo, které robot vyhraje a nečinný prohraje: některá rozložení robot do hodin nestihne (nebo je nečinný vyhraje),
   * tak zkusí další semínko, pak jinou mikrohru. `ticks` = robotův běh, z něj délka řetězu.
   */
  const roundOf = (entry: MicroEntry, round: number): Built | null => {
    const draft = draftOf(sentence, entry);
    if (draft === null) return null;
    const spec = microSpec(sameWorld(draft, shared, entry.boss === true ? read.foe : null), entry, round);
    for (let attempt = 0; attempt < SEED_TRIES; attempt += 1) {
      const world = nextInt(stream, 1, 0x7fffffff);
      const made = arcadeWorldOf(spec, world);
      if (!made.ok) continue;
      const bot = runBot(made.world);
      if (bot.outcome === 'won' && replay(made.world, [], ARCADE_LIBRARY).outcome !== 'won') {
        return { plan: { spec, key: entry.key, card: entry.card, boss: entry.boss === true, seed: world }, control: entry.control, ticks: bot.tick };
      }
    }
    return null;
  };

  const rounds: Built[] = [];
  const taken = (entry: MicroEntry): boolean => rounds.some((round) => round.control === entry.control);
  for (const entry of order) {
    if (rounds.length > 0) break;
    const lead = roundOf(entry, 0);
    if (lead !== null) rounds.push(lead);
  }
  let found: Built | null = null;
  for (const entry of [...read.verbs.flatMap((verb) => VERB_BOSS[verb.class] ?? []), ...bosses].map(entryOf)) {
    if (found === null && !taken(entry)) found = roundOf(entry, CHAIN_ROUNDS - 1);
  }
  if (found === null) return { ok: false, issues: ['no boss round the bot wins'] };
  const boss = found;
  const spare = order.filter((entry) => entry.control !== boss.control);
  for (const entry of spare) {
    if (rounds.length === CHAIN_ROUNDS - 1) break;
    if (taken(entry)) continue;
    const round = roundOf(entry, rounds.length);
    if (round !== null) rounds.push(round);
  }
  if (rounds.length < CHAIN_ROUNDS - 1) return { ok: false, issues: [`only ${rounds.length} rounds the bot wins before the boss`] };

  // Krátká kola (střelba, dav ~4 s) a tempo 1300 stáhnou řetěz pod 30 s: nejkratší kolo mimo první vymění za delší.
  const lengthOf = (): number => chainLengthSec({ cardTicks: CARD_TICKS, rounds: [...rounds, boss].map((_, index) => ({ rate: roundRate(index) })) }, [...rounds, boss].map((round) => round.ticks));
  for (const entry of spare) {
    if (lengthOf() >= CHAIN_SECONDS.min) break;
    if (taken(entry)) continue;
    const shortest = rounds.reduce((best, round, index) => (index > 0 && round.ticks < rounds[best]!.ticks ? index : best), 1);
    const longer = roundOf(entry, shortest);
    if (longer !== null && longer.ticks > rounds[shortest]!.ticks) rounds[shortest] = longer;
  }
  return chainFromSpecs(seed, [...rounds, boss].map((round) => round.plan));
}
