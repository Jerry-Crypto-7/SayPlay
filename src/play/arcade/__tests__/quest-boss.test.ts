/**
 * Finále úkolu v prostoru (P47A T4, jen `genre.v4`): místo neporazitelného strážce (`GUARDIAN_BOSS`) přijde
 * s posledním kolem boss v rovině (chování `boss`, pravidlo `boss_beat`), který nese cíle posledního kola:
 * do jeho pádu jsou jen předlohou (`boss_beat.drop` s předlohou cíle kol) a padlý boss je vydá na místě.
 * Výhru dál dává `interact` – vyhrává se se všemi živými cíli, takže cíl, který by ležel už před pádem,
 * by dal výhru s živým bossem. Uložené `genre.v3` hry mají dál strážce.
 *
 * Co by vypadalo dobře a bylo špatně: boss přijde, ale cíle posledního kola leží na zemi a robot vyhraje
 * kolem něj; boss bez `boss_beat` se nedá porazit a výhra nikdy nepřijde; hodiny z věty boss nestihne.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { arcadeWorldOf, compileArcade } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, FLAG, HEADER, type PieceRef, ROLE, bodyBase, bodyHp, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { type BehaviourRef, behaviourBodies } from '../pieces/behaviours';
import { play } from '../pieces/behaviours/__tests__/harness';
import { FIELD, FINALE_GENRE_VERSION, GUARDIAN_BOSS } from '../pieces/pacing-parts';
import { type WaveParams, waveOf } from '../pieces/waves';
import { loadRapier } from '../physics/world';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const BAND_SEEDS = Array.from({ length: 20 }, (_, k) => k + 1);
const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === id)!));
const draft = (text: string): GameSpecV1 => draftGameSpecWithMeta(text, 1).spec;
const withVersion = (spec: GameSpecV1, version: string): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: version } });
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const ruleOf = (world: Pick<ArcadeWorld, 'rules'>, id: string): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === id);
const pacedRefs = (world: ArcadeWorld): readonly BehaviourRef[] => (chain(world.control).find((ref) => ref.id === 'pacing_control')?.params.behaviours ?? []) as BehaviourRef[];
const finaleOf = (world: ArcadeWorld): string | undefined => (ruleOf(world, 'pacing')?.params as { finale?: string } | undefined)?.finale;
const wavesOf = (world: ArcadeWorld): WaveParams => ruleOf(world, 'arena_waves')!.params as WaveParams;
interface Beat { readonly boss: number; readonly drop?: { readonly template: number; readonly count: number } }
const beatOf = (world: ArcadeWorld): Beat | undefined => ruleOf(world, 'boss_beat')?.params as Beat | undefined;
const liveTargets = (state: Int32Array): number =>
  Array.from({ length: state[HEADER.bodyCount] as number }, (_, body) => body).filter((body) => state[bodyBase(body) + BODY.role] === ROLE.target && ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0).length;

/** Úkol v prostoru: buňka a věty dev sady P47A (q01–q05). */
const QUEST_GAMES: readonly [string, () => GameSpecV1][] = [
  ['cell quest.spatial', () => cellSpec('quest.spatial')],
  ['q01 lighthouse', () => draft('A lighthouse keeper lights every lamp along the stormy coast')],
  ['q02 firefighter', () => draft('A firefighter waters burning trees in a forest')],
  ['q03 greenhouse', () => draft('Water the thirsty plants in a greenhouse')],
  ['q04 fences', () => draft('Paint every fence in the neighborhood before sunset')],
  ['q05 mars', () => draft('A robot plants seeds across a dusty Mars colony')],
];

/**
 * Průběh výhry: tik pádu bosse (−1 = nepadl), největší počet živých cílů v posledním kole, dokud boss stál,
 * a živé cíle hned po pádu.
 */
function finaleTrace(world: ArcadeWorld, inputs: Parameters<typeof play>[1]): { fell: number; heldBack: number; released: number; won: number } {
  const boss = pacedRefs(world).find((ref) => ref.id === 'boss')!;
  const last = wavesOf(world).waves.length;
  let seen = false;
  let fell = -1;
  let heldBack = 0;
  let released = -1;
  let won = -1;
  play(world, inputs, (state, tick) => {
    const alive = behaviourBodies(state, state[HEADER.player] as number, [boss]).length > 0;
    if (alive) seen = true;
    if (seen && !alive && fell < 0) {
      fell = tick;
      released = liveTargets(state);
    }
    if (fell < 0 && waveOf(state) >= last) heldBack = Math.max(heldBack, liveTargets(state));
    if (state[HEADER.runState] === 1) won = tick;
  });
  return { fell, heldBack, released, won };
}

beforeAll(async () => {
  await loadRapier();
});

describe('spatial quest: the finale boss carries the last round and can be beaten (genre.v4)', () => {
  it('v4 has a beatable plane boss whose drop is the last round; the same game stored as v3 keeps the guardian', () => {
    for (const [id, make] of QUEST_GAMES) {
      const spec = make();
      expect(spec.genre?.compilerVersion, id).toBe(FINALE_GENRE_VERSION);
      for (const seed of SEEDS.slice(0, 3)) {
        const world = worldOf(spec, seed);
        const stored = worldOf(withVersion(spec, 'genre.v3'), seed);
        expect(finaleOf(world), `${id} seed ${seed}`).toBe('boss');
        const boss = pacedRefs(world).at(-1)!;
        expect(boss.id, `${id} seed ${seed}`).toBe('boss');
        expect(bodyHp(instantiate(world), boss.template), `${id} seed ${seed}`).toBe(FIELD.questBossHp);
        const beat = beatOf(world);
        expect(beat?.boss, `${id} seed ${seed}`).toBe(boss.template);
        // Boss nese všechny cíle posledního kola: předloha cíle kol, kolik jich kolo ve v3 položí; poslední kolo samo žádný.
        const storedLast = wavesOf(stored).waves.at(-1)!.items!;
        expect(beat?.drop, `${id} seed ${seed}`).toEqual({ template: wavesOf(world).item, count: storedLast.length / 2 });
        expect(wavesOf(world).waves.at(-1)!.items, `${id} seed ${seed}`).toBeUndefined();
        expect(wavesOf(world).waves.slice(0, -1)).toEqual(wavesOf(stored).waves.slice(0, -1));
        // v3: strážce, bez zásahu a pádu.
        const guardian = pacedRefs(stored).at(-1)!;
        expect(guardian.id, `${id} v3`).toBe('guardian');
        expect(beatOf(stored), `${id} v3`).toBeUndefined();
        expect([BODY.w, BODY.h, BODY.d].map((slot) => stored.initial[bodyBase(guardian.template) + slot])).toEqual([GUARDIAN_BOSS.w, GUARDIAN_BOSS.h, GUARDIAN_BOSS.d]);
      }
    }
  });

  it('the last targets appear only once the boss falls, in every intermediate win; the bands hold on 20 seeds', () => {
    const spec = cellSpec('quest.spatial');
    let wins = 0;
    let novice = 0;
    for (const seed of BAND_SEEDS) {
      const world = worldOf(spec, seed);
      if (runBot(world, ARCADE_LIBRARY, { profile: 'novice' }).outcome === 'won') novice += 1;
      const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      if (bot.outcome !== 'won') continue;
      wins += 1;
      const { fell, heldBack, released, won } = finaleTrace(world, bot.inputs);
      expect(fell, `seed ${seed}: the win came without the boss falling`).toBeGreaterThanOrEqual(0);
      expect(heldBack, `seed ${seed}: a last-round target lay on the floor before the boss fell`).toBe(0);
      expect(released, `seed ${seed}`).toBe(beatOf(world)!.drop!.count);
      expect(won, `seed ${seed}`).toBeGreaterThan(fell);
      expect(funMetrics(traceRun(world, bot.inputs)).finale.why, `seed ${seed}`).toBe('boss');
    }
    expect(wins, 'intermediate wins of 20').toBeGreaterThanOrEqual(16);
    expect(novice, 'novice wins of 20').toBeGreaterThanOrEqual(6);
    expect(novice, 'novice wins of 20').toBeLessThanOrEqual(14);
  }, 600_000);

  it('dev sentences: intermediate wins at least 7 of 8 and the boss fell in every win', () => {
    for (const [id, make] of QUEST_GAMES.slice(1)) {
      const spec = make();
      let wins = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
        if (bot.outcome !== 'won') continue;
        wins += 1;
        const { fell, heldBack } = finaleTrace(world, bot.inputs);
        expect(fell, `${id} seed ${seed}: the win came without the boss falling`).toBeGreaterThanOrEqual(0);
        expect(heldBack, `${id} seed ${seed}`).toBe(0);
      }
      expect(wins, `${id}: intermediate wins`).toBeGreaterThanOrEqual(7);
    }
  }, 600_000);

  // Hodiny 30 a 45 s (`quest-rounds.test.ts`) dají jedno kolo bez průběhu; kola a s nimi bosse mají až delší.
  // „within 90 seconds“ hodiny drží na stropu 80 s.
  it('a clock from the sentence (timer onEnd lose) still fits the boss: the publication bot wins in time on every seed', () => {
    let bossed = 0;
    for (const [sentence, seconds] of [['light all the lanterns in the temple within 90 seconds', 80], ['paint every fence in the neighborhood within 75 seconds', 75]] as const) {
      const spec = draft(sentence);
      expect(spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params, sentence).toMatchObject({ seconds, onEnd: 'lose' });
      for (const seed of derivedSeeds(seedFrom(sentence))) {
        const compiled = compileArcade(spec, seed);
        if (!compiled.ok) throw new Error(`${sentence} @${String(seed)}: ${compiled.issues.join('; ')}`);
        const { arcade: world, winsAtTick } = compiled.value;
        expect(winsAtTick, `${sentence} @${String(seed)}`).not.toBeNull();
        expect(winsAtTick!, `${sentence} @${String(seed)}`).toBeLessThan(seconds * ARCADE_HZ);
        if (beatOf(world!) === undefined) continue;
        bossed += 1;
        expect(finaleTrace(world!, runBot(world!, ARCADE_LIBRARY).inputs).fell, `${sentence} @${String(seed)}`).toBeGreaterThanOrEqual(0);
      }
    }
    // Hry s hodinami mají kola a s nimi bosse na každém semínku publikace – jinak test nic neměří.
    expect(bossed).toBe(2 * derivedSeeds(1).length);
  }, 600_000);
});
