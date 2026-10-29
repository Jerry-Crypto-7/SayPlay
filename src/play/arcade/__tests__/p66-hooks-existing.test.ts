/**
 * Háčky dosavadních žánrů (P66 T10). Hra `genre.v6` dostane bez klíčů nabídku svého žánru (`genreHookOffer`
 * v `pieces/pacing-parts.ts`): souboj, sběr arény, střelnice a obrana kola s výběrem 1 ze 3 mezi vlnami, běžec,
 * skákačka, chytání a plavba vzácnost sebraných věcí, každá hra létající skóre a hlášky komba.
 *
 * Drží:
 * - uložená hra `genre.v5` háčky nemá (otisk bit po bitu drží `p66-hash.test.ts`);
 * - hra `genre.v6` dotčených žánrů: robot vyhraje, nečinný prohraje, dvě přehrání záznamu robota dají týž hash –
 *   na buňkách `evals/play/p58a/framing-cells.json` (sběr arény a plavba z věty, buňku nemají), otisk
 *   v `evals/play/p66/hash-v6.json`;
 * - pomalá volba (hráč nechá dojít celou přestávku, bere se karta 0): střelnice a obrana dohrají, protože pochod
 *   a vlny jdou podle tiku světa bez přestávek (`worldTickOf`).
 *
 * `P66_V6_WRITE=1` otisk znovu vyrobí.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';
import { compileGenre, GENRE_MODULES, readGenreSpec } from '@/play/genre/index';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import { arcadeWorldOf, compileArcade } from '../compile';
import { type ArcadeWorld, type BotPiece, NO_INPUT, RUN_STATE, HEADER, bodyBase } from '../contract';
import { foundOf, hooksOf, inBreak } from '../hooks';
import { ROUNDS, UPGRADE_OFFER } from '../hooks/contract';
import { CLOCK_SLOTS } from '../hooks/rounds';
import { ofKind, play } from '../hooks/__tests__/harness';
import { hashArcade, instantiate, replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { type BotProfile, runBot } from '../verify';

const PINNED = 'evals/play/p66/hash-v6.json';
const SEED = 1;

interface Run {
  readonly tick: number;
  readonly outcome: string;
  readonly hash: string;
}
interface Cell {
  readonly id: string;
  readonly seed: number;
  readonly spec: unknown;
  readonly initial: string;
  readonly bot: Run;
  readonly idle: Run;
}
interface Pinned {
  readonly compilerVersion: string;
  readonly cells: readonly Cell[];
}

/** Co hra žánru od háčků dostane: kola, výběr vylepšení, vzácnost. */
const EXPECTED: Readonly<Record<string, { readonly rounds: number; readonly clear: string; readonly upgrades: boolean; readonly rarity: boolean }>> = {
  'arena:fight': { rounds: 5, clear: 'wave', upgrades: true, rarity: false },
  'arena:collect': { rounds: 3, clear: 'goal', upgrades: true, rarity: false },
  shooter: { rounds: 3, clear: 'goal', upgrades: true, rarity: false },
  defense: { rounds: 3, clear: 'goal', upgrades: true, rarity: false },
  runner: { rounds: 1, clear: 'wave', upgrades: false, rarity: true },
  platformer: { rounds: 1, clear: 'wave', upgrades: false, rarity: true },
  catch: { rounds: 1, clear: 'wave', upgrades: false, rarity: true },
  voyage: { rounds: 1, clear: 'wave', upgrades: false, rarity: true },
};

/** Hra žánru přeložená teď (`genre.v6`) z `GenreSpec` – pro žánry bez buňky `framing-cells`. */
function compiled(genre: 'arena' | 'voyage', sentence: string, params: Readonly<Record<string, number>> = {}): GameSpecV1 {
  const read = readGenreSpec({ hero: 'fox', ...(GENRE_MODULES[genre].draftFill(sentence, null) as object), params });
  if (!read.ok) throw new Error(`${genre}: ${read.issues.join('; ')}`);
  return compileGenre(read.value);
}

/** Buňky: `framing-cells` přeložené jako `genre.v6`, sběr arény a plavba s turbem z věty. Jen pro `P66_V6_WRITE=1`. */
function sources(): readonly (readonly [string, GameSpecV1])[] {
  const framing = JSON.parse(readFileSync('evals/play/p58a/framing-cells.json', 'utf8')) as Record<string, { readonly spec: GameSpecV1 }>;
  const v6 = (id: string): GameSpecV1 => ({ ...framing[id]!.spec, genre: { ...framing[id]!.spec.genre!, compilerVersion: GENRE_COMPILER_VERSION } });
  return [
    ['arena:fight', v6('arena')],
    ['arena:collect', compiled('arena', 'a squirrel collects acorns in the park')],
    ['shooter', v6('shooter')],
    ['defense', v6('defense')],
    ['runner', v6('runner')],
    ['platformer', v6('platformer')],
    ['catch', v6('catch')],
    ['voyage', compiled('voyage', 'a pirate ship races between islands to the treasure', { turbo: 1 })],
  ];
}

function worldOf(spec: unknown, seed: number, version?: string): ArcadeWorld {
  const raw = spec as GameSpecV1;
  const read = readGameSpec(version === undefined ? raw : { ...raw, genre: { ...raw.genre!, compilerVersion: version } });
  if (!read.ok) throw new Error(read.issues.join('; '));
  const made = arcadeWorldOf(read.value, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

function measure(id: string, spec: unknown, seed: number): Cell {
  const world = worldOf(spec, seed);
  const bot = runBot(world);
  const idle = replay(world, [], ARCADE_LIBRARY);
  return {
    id,
    seed,
    spec,
    initial: hashArcade(instantiate(world)),
    bot: { tick: bot.tick, outcome: bot.outcome, hash: bot.hash },
    idle: { tick: idle.tick, outcome: idle.outcome, hash: idle.hash },
  };
}

// Fyzikální tělesa chtějí Rapier před prvním tikem – už při sběru testů v režimu zápisu.
await loadRapier();

if (process.env.P66_V6_WRITE === '1') {
  const cells = sources().map(([id, spec]) => measure(id, spec, SEED));
  writeFileSync(PINNED, `${JSON.stringify({ compilerVersion: GENRE_COMPILER_VERSION, cells } satisfies Pinned, null, 1)}\n`);
}

const pinned = (existsSync(PINNED) ? JSON.parse(readFileSync(PINNED, 'utf8')) : { compilerVersion: '', cells: [] }) as Pinned;
const cells = pinned.cells.map((cell) => [cell.id, cell] as const);

describe('existing genres offer the hooks from genre.v6 (P66 T10)', () => {
  it('pins one genre.v6 game of every genre T10 touches', () => {
    expect(pinned.cells.map((cell) => cell.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const cell of pinned.cells) expect((cell.spec as GameSpecV1).genre?.compilerVersion).toBe('genre.v6');
  });

  it.each(cells)('%s: the hooks of the genre – rounds with picks between waves, or rarity', (id, cell) => {
    const want = EXPECTED[id]!;
    const hooks = hooksOf(worldOf(cell.spec, cell.seed).rules);
    expect(hooks).not.toBeNull();
    expect({ rounds: hooks!.rounds, clear: hooks!.clear, upgrades: hooks!.upgrades !== undefined, rarity: hooks!.rarity !== undefined }).toEqual(want);
  });

  it.each(cells)('%s: the same game saved as genre.v5 has no hooks', (_, cell) => {
    const world = worldOf(cell.spec, cell.seed, 'genre.v5');
    expect(hooksOf(world.rules)).toBeNull();
    expect(world.bot.id).not.toBe('hooks_bot');
  });

  it.each(cells)('%s: the robot wins, the idle player loses, two replays agree – and all as pinned', (id, cell) => {
    const now = measure(id, cell.spec, cell.seed);
    expect(now.bot.outcome).toBe('won');
    expect(now.idle.outcome).toBe('lost');
    const world = worldOf(cell.spec, cell.seed);
    const inputs = runBot(world).inputs;
    const first = replay(world, inputs, ARCADE_LIBRARY);
    const second = replay(world, inputs, ARCADE_LIBRARY);
    expect(second).toEqual(first);
    expect(first.hash).toBe(now.bot.hash);
    expect({ initial: now.initial, bot: now.bot, idle: now.idle }).toEqual({ initial: cell.initial, bot: cell.bot, idle: cell.idle });
  });

  it.each(cells)('%s: the robot run shows the hooks – an offer at every round break, finds by rarity', (id, cell) => {
    const want = EXPECTED[id]!;
    const world = worldOf(cell.spec, cell.seed);
    const played = play(world, runBot(world).inputs);
    expect(played.state[HEADER.runState]).toBe(RUN_STATE.won);
    expect(ofKind(played, 'round_clear')).toHaveLength(want.rounds === 1 ? 0 : want.rounds);
    expect(ofKind(played, 'upgrade_offer')).toHaveLength(want.upgrades ? want.rounds - 1 : 0);
    expect(ofKind(played, 'upgrade_pick')).toHaveLength(want.upgrades ? want.rounds - 1 : 0);
    const found = foundOf(played.state, hooksOf(world.rules)!.keeper as number);
    if (want.rarity) expect(found.common + found.rare + found.epic).toBeGreaterThan(0);
    else expect(found).toEqual({ common: 0, rare: 0, epic: 0 });
  });

  // Výběr nesmí hru zlehčit mimo pásmo (`compose/__tests__/difficulty.test.ts`): s +1 životem navíc vyhrával
  // začátečník 1,0 ve všech čtyřech, proto `extra_life` jen vrací ztracený život (`lifeCap`). Střelnice žánru je
  // lehká už bez háčků (začátečník 0,95), tam se hlídá jen spodek.
  it.each(cells.filter(([id]) => EXPECTED[id]!.upgrades))('%s: the picks keep the difficulty band on 20 seeds', (id, cell) => {
    const seeds = Array.from({ length: 20 }, (_, k) => k + 1);
    const rate = (profile: BotProfile): number => seeds.filter((seed) => runBot(worldOf(cell.spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / seeds.length;
    const novice = rate('novice');
    expect(novice, `${id} novice`).toBeGreaterThanOrEqual(0.3);
    expect(novice, `${id} novice`).toBeLessThanOrEqual(id === 'shooter' ? 1 : 0.7);
    expect(rate('intermediate'), `${id} intermediate`).toBeGreaterThanOrEqual(0.8);
    expect(hooksOf(worldOf(cell.spec, SEED).rules)!.lifeCap).toBe(3);
  }, 300_000);

  it.each([2, 3])('seed %i: the robot still wins every genre with picks', (seed) => {
    for (const [id, cell] of cells) {
      if (!EXPECTED[id]!.upgrades) continue;
      expect([id, runBot(worldOf(cell.spec, seed)).outcome]).toEqual([id, 'won']);
    }
  });
});

/** Robot háčků, který kartu nikdy nevybere: každá přestávka dojde celá a vezme se karta 0. */
type HooksBotParams = { readonly base: unknown; readonly keeper: number };
const hooksBot = ARCADE_LIBRARY.bots.hooks_bot as unknown as BotPiece<HooksBotParams>;
const slowBot: BotPiece<HooksBotParams> = {
  ...hooksBot,
  decide: (observation, params) => (inBreak(observation.state, params.keeper) ? NO_INPUT : hooksBot.decide(observation, params)),
};
const SLOW_LIBRARY = { ...ARCADE_LIBRARY, bots: { ...ARCADE_LIBRARY.bots, hooks_bot: slowBot as unknown as BotPiece } };

describe('a slow pick does not cost the march (world clock, P66 T10)', () => {
  it.each(cells.filter(([id]) => id === 'shooter' || id === 'defense'))('%s: every break runs out, card 0 is taken, the game still plays to a win', (_, cell) => {
    const world = worldOf(cell.spec, cell.seed);
    const hooks = hooksOf(world.rules)!;
    const slow = runBot(world, SLOW_LIBRARY);
    expect(slow.outcome).toBe('won');
    const played = play(world, slow.inputs);
    expect(played.state[HEADER.runState]).toBe(RUN_STATE.won);
    const offers = ofKind(played, 'upgrade_offer');
    const picks = ofKind(played, 'upgrade_pick');
    expect(picks.map((pick) => pick.card)).toEqual(offers.map(() => UPGRADE_OFFER.defaultCard));
    expect(picks.map((pick, k) => pick.tick - offers[k]!.tick)).toEqual(offers.map(() => UPGRADE_OFFER.pickTicks));
    // Hodiny světa stojí celou přestávku: tiky přestávek jsou právě nabídky × doba volby.
    expect(hooks.clock).toBe(true);
    expect(played.state[bodyBase(hooks.keeper as number) + CLOCK_SLOTS.paused]).toBe(offers.length * UPGRADE_OFFER.pickTicks);
    expect(hooks.rounds).toBeLessThanOrEqual(ROUNDS.max);
  });
});

/**
 * Recenze Fáze 3, F1 a F2: hra `genre.v6` s cílovým skóre („… score 500 points“, `targetScore` režiséra).
 * F1 – sonda dosažitelného cíle staví svět s cílem 0; háčky podle zkompilovaného cíle by sondě daly vzácnost a
 * finálnímu světu ne, robot by na cíl nedosáhl (UNWINNABLE). F2 – výhra na skóre před posledním kolem by kolo zasekla.
 * Nabídka se proto řídí cílem ze specu: s cílem žádná kola ani vzácnost, sonda i finální svět stejné.
 */
describe('a genre.v6 game with a score target compiles and the bot wins (P66 Phase 3 review F1, F2)', () => {
  const golden = JSON.parse(readFileSync('evals/play/p41/golden/genres.json', 'utf8')) as { readonly variants: readonly { readonly id: string; readonly spec: GameSpecV1 }[] };
  const CASES: readonly (readonly [string, number | null])[] = [
    ['runner.default/depth:targetScore', 500],
    ['arena.collect/depth:targetScore', 10],
    ['shooter.default/depth:targetScore', 20],
    ['arena.fight/depth:targetScore', null],
    ['platformer.default/depth:targetScore', null],
    ['voyage.race/depth:targetScore', null],
  ];
  for (const [id, target] of CASES) {
    it(`${id}${target === null ? '' : ` target ${String(target)}`}`, () => {
      const base = golden.variants.find((variant) => variant.id === id)!.spec;
      const spec = { ...base, genre: { ...base.genre!, compilerVersion: 'genre.v6' }, scoring: { ...base.scoring, target: target ?? base.scoring?.target ?? 0 } } as GameSpecV1;
      expect(spec.scoring?.target ?? 0, id).toBeGreaterThan(0);
      for (const seed of [1, 2, 3]) {
        const made = compileArcade(spec, seed);
        expect(made.ok, `${id} seed ${String(seed)}: ${made.ok ? '' : `${made.reason} ${made.issues.join(' | ')}`}`).toBe(true);
        if (!made.ok) continue;
        const world = made.value.arcade!;
        const hooks = hooksOf(world.rules);
        expect(hooks?.rounds ?? 1, `${id} seed ${String(seed)}`).toBe(1);
        expect(hooks?.rarity, `${id} seed ${String(seed)}`).toBeUndefined();
        expect(runBot(world).outcome, `${id} seed ${String(seed)}`).toBe('won');
      }
    });
  }
});
