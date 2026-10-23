/**
 * Mutátory řetězu (P56C T15): druhá vrstva kola – stejná mikrohra s jedním zvratem („Mirror!“ pod slovesem).
 * Kde jde zvrat napsat parametrem žánru nebo pravidlem specu, žije ve specu (`mutatedSpec`); co spec neumí
 * (osa ovládání, velikost těl, životy, rychlost, drolení), dělá úprava hotového světa (`mutateWorld`)
 * – svět se ukládá celý (`ChainRound.world`), takže replay i Dare na serveru hrají totéž. `spotlight` je jen
 * obraz kolem hrdiny (kreslí klient řetězu) a hash nemění.
 *
 * Které páry (mutátor, mikrohra) hrají, neříká nikdo ručně: `mutator-compat.json` zapisuje
 * `evals/play/p56c/mutator-compat.measure.ts` podle `mutatorPairIssue` a test ji ověřuje znovu.
 */

import { arcadeWorldOf } from '../arcade/compile';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeWorld, BODY, COUNTER, HEADER, HP_MAX, ROLE, bodyBase, bodyHp, setBodyHp } from '../arcade/contract';
import { replay } from '../arcade/kernel';
import { ARCADE_LIBRARY } from '../arcade/library';
import { runBot } from '../arcade/verify';
import { draftGenreFor } from '../draft/draft';
import { COUNT_PARAMS, type CountRole } from '../genre/contract';
import { GENRE_MODULES } from '../genre/modules';
import type { GameSpecV1 } from '../spec';
import compat from './mutator-compat.json';
import { type MicroEntry, type MicroKey, genreModeOf, microSpec } from './micro';
import { roundSeeds } from './run';

/**
 * Jedenáct z plánovaných dvanácti: `magnet_start` vypadl – sbírané věci má jen plošinovka a poletování, běžec
 * na jednom semínku žádnou nemine do okruhu 4–10 jednotek a chytání se přitahováním rozbije (`mutator-compat.md`).
 */
export const MUTATOR_IDS = ['mirror', 'vanishing_floor', 'hero_grows', 'tiny_hero', 'giant_foes', 'extra_foes', 'rush', 'one_hit', 'double_speed', 'shield_start', 'spotlight'] as const;
export type MutatorId = (typeof MUTATOR_IDS)[number];

interface Mutator {
  /** Karta pod slovesem, anglicky (`docs/brand/docs/11-voice-copy.md`). */
  readonly card: string;
  /** Jen obraz: svět i hash beze změny. */
  readonly visual?: true;
}

export const MUTATORS: Readonly<Record<MutatorId, Mutator>> = {
  mirror: { card: 'Mirror!' },
  vanishing_floor: { card: 'Keep moving!' },
  hero_grows: { card: 'Big hero!' },
  tiny_hero: { card: 'Tiny hero!' },
  giant_foes: { card: 'Giant foes!' },
  extra_foes: { card: 'More foes!' },
  rush: { card: 'Hurry!' },
  one_hit: { card: 'One hit KO!' },
  double_speed: { card: 'Double speed!' },
  shield_start: { card: 'Shield up!' },
  spotlight: { card: 'Lights out!', visual: true },
};

/** Semínka tabulky: z AC T15 a z celého rozsahu, jaký losuje řetěz (malá dávají „šťastné“ úrovně, T7). */
export const COMPAT_SEEDS: readonly number[] = [1, 2, 8, 9, 13, 20, ...roundSeeds(7, 6)];
export const COMPAT_SENTENCE = 'a fox in a forest';

/** Páry, které změřil `mutator-compat.measure.ts`: mutátor → mikrohry, kde robot vyhraje a nečinný prohraje. */
export const MUTATOR_COMPAT = compat.pairs as Readonly<Record<MutatorId, readonly MicroKey[]>>;

/** Nepřátel o polovinu víc, v mezích parametru modulu. */
const MORE = { num: 3, den: 2 } as const;
/** Hodiny přežití o čtvrtinu kratší. */
const RUSH = { num: 3, den: 4 } as const;
const HARM: ReadonlySet<number> = new Set([ROLE.obstacle, ROLE.chaser, ROLE.hazard, ROLE.enemy]);
/** Mizející podlaha: drolení po 40 tikách stání, hrdina spadne po 81–120 tikách. */
const CRUMBLE_PERIOD = 40;

/**
 * Spec kola s mutátorem, nebo `null`, když mutátor na tuhle mikrohru nejde (žánr nemá počet nepřátel, kolo
 * nemá hodiny přežití). Mutátory, které žijí jen ve světě, dostanou spec kola beze změny.
 */
export function mutatedSpec(draft: Parameters<typeof microSpec>[0], entry: MicroEntry, round: number, id: MutatorId): GameSpecV1 | null {
  if (id === 'extra_foes') {
    const { genre, mode } = genreModeOf(entry);
    const key = (COUNT_PARAMS[genre] as Readonly<Record<string, Readonly<Partial<Record<CountRole, string>>> | undefined>>)[mode]?.enemy;
    const now = key === undefined ? undefined : (entry.params?.[key] ?? draft.params?.[key]);
    if (key === undefined || now === undefined) return null;
    const most = GENRE_MODULES[genre].paramBounds[key]?.max ?? now;
    const more = Math.min(most, Math.ceil((now * MORE.num) / MORE.den));
    return more === now ? null : microSpec(draft, { ...entry, params: { ...entry.params, [key]: more } }, round);
  }
  const spec = microSpec(draft, entry, round);
  if (id !== 'rush') return spec;
  if (entry.kind !== 'survive') return null;
  // Hodiny přežití jsou celé čtvrtiny sekundy (5–8 s), takže tři čtvrtiny jsou celé tiky.
  return { ...spec, rules: (spec.rules ?? []).map((rule) => (rule.id === 'micro_clock' && 'every' in rule.when ? { ...rule, when: { every: (rule.when.every * RUSH.num) / RUSH.den } } : rule)) };
}

/** Úprava těl v počátečním stavu; `null`, když se nezměnilo nic. */
function editBodies(world: ArcadeWorld, edit: (state: Int32Array, body: number) => void): ArcadeWorld | null {
  const state = Int32Array.from(world.initial);
  const count = state[HEADER.bodyCount] as number;
  for (let body = 0; body < count; body += 1) edit(state, body);
  return state.some((value, index) => value !== world.initial[index]) ? { ...world, initial: Array.from(state) } : null;
}

const scale = (state: Int32Array, body: number, num: number, den: number): void => {
  const base = bodyBase(body);
  for (const slot of [BODY.w, BODY.h, BODY.d]) state[base + slot] = Math.max(1, Math.round(((state[base + slot] as number) * num) / den));
};

const isHarm = (state: Int32Array, body: number): boolean => HARM.has(state[bodyBase(body) + BODY.role] as number);

/**
 * Svět kola s mutátorem; `null`, když mutátor ve světě nemá co změnit (žádný nepřítel s více životy,
 * plná pravidla). Hráč je tělo 0.
 */
export function mutateWorld(world: ArcadeWorld, id: MutatorId): ArcadeWorld | null {
  switch (id) {
    case 'mirror':
      return { ...world, control: { id: 'mirror_control', params: { base: world.control } }, bot: { id: 'mirror_bot', params: { base: world.bot } } };
    case 'vanishing_floor':
      return world.rules.length >= ARCADE_LIMITS.maxRules ? null : { ...world, rules: [...world.rules, { id: 'vanishing_floor', params: { period: CRUMBLE_PERIOD } }], bot: { id: 'vanishing_floor_bot', params: { base: world.bot } } };
    case 'hero_grows':
      return editBodies(world, (state, body) => body === 0 && scale(state, body, 3, 2));
    case 'tiny_hero':
      return editBodies(world, (state, body) => body === 0 && scale(state, body, 2, 3));
    case 'giant_foes':
      return editBodies(world, (state, body) => body > 0 && isHarm(state, body) && scale(state, body, 3, 2));
    case 'one_hit':
      return editBodies(world, (state, body) => body > 0 && bodyHp(state, body) > 1 && setBodyHp(state, body, 1));
    case 'double_speed':
      return editBodies(world, (state, body) => {
        if (body === 0) return;
        const base = bodyBase(body);
        for (const slot of [BODY.vx, BODY.vy, BODY.vz]) state[base + slot] = (state[base + slot] as number) * 2;
      });
    case 'shield_start': {
      // Štít = jeden zásah navíc. Power-up štít (`POWERUPS`) má jen běžec a plošinovka, mikrohry ostatních ne.
      const health = world.initial[HEADER.counters + COUNTER.health] as number;
      if (health <= 0 || health >= HP_MAX) return null;
      const initial = [...world.initial];
      initial[HEADER.counters + COUNTER.health] = health + 1;
      return { ...world, initial };
    }
    case 'extra_foes':
    case 'rush':
    case 'spotlight':
      return world;
  }
}

/** Svět kola `entry` s mutátorem `id`, nebo `null`, když mutátor nejde. */
export function mutatedWorld(draft: Parameters<typeof microSpec>[0], entry: MicroEntry, round: number, id: MutatorId, seed: number): ArcadeWorld | null {
  const spec = mutatedSpec(draft, entry, round, id);
  if (spec === null) return null;
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) return null;
  return mutateWorld(made.world, id);
}

/** Kola, kam mutátor v řetězu jde (kola 2 až N−1, tedy indexy 1–3); přežití se zkracuje, proto obě krajní. */
export const mutatorRounds = (entry: MicroEntry): readonly number[] => (entry.kind === 'survive' ? [1, 3] : [1]);

/**
 * Co na páru (mutátor, mikrohra) neplatí, nebo `null`: robot vyhraje za 3–8 s, nečinný prohraje, dvě přehrání
 * shodná a mutátor změní hashovaný stav (vstupy robota bez mutátoru dají jiný hash) – kromě `spotlight`.
 */
export function mutatorPairIssue(sentence: string, entry: MicroEntry, id: MutatorId, seeds: readonly number[]): string | null {
  const { genre, mode } = genreModeOf(entry);
  const draft = draftGenreFor(sentence, genre, mode);
  if (draft === null) return 'no draft';
  const most = (entry.boss === true ? 15 : 8) * ARCADE_HZ;
  for (const round of mutatorRounds(entry)) {
    for (const seed of seeds) {
      const at = `round ${String(round)} seed ${String(seed)}`;
      const world = mutatedWorld(draft, entry, round, id, seed);
      if (world === null) return 'not applicable';
      const bot = runBot(world);
      if (bot.outcome !== 'won') return `${at}: bot ${bot.outcome}`;
      if (bot.tick < 3 * ARCADE_HZ || bot.tick > most) return `${at}: bot wins at tick ${String(bot.tick)}`;
      if (replay(world, [], ARCADE_LIBRARY).outcome !== 'lost') return `${at}: idle does not lose`;
      if (replay(world, bot.inputs, ARCADE_LIBRARY).hash !== bot.hash) return `${at}: replay differs`;
      const plain = arcadeWorldOf(microSpec(draft, entry, round), seed);
      if (!plain.ok) return `${at}: ${plain.issues.join('; ')}`;
      const before = runBot(plain.world);
      const changed = replay(world, before.inputs, ARCADE_LIBRARY).hash !== before.hash;
      if (changed === (MUTATORS[id].visual === true)) return `${at}: ${changed ? 'visual mutator moved the hash' : 'hashed state unchanged'}`;
    }
  }
  return null;
}
