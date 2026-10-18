/**
 * Skládaná aréna a finále běžce (P51 T5).
 * - Boss nové hry (`genre.v5`) přijde i do plného `maxActors`: běžec s hejnem těsně před bossem (P47A h024) finále
 *   neměl, protože hejno vzalo poslední místo a boss „se nevešel“. Pin na ručně postaveném světě s plným stropem.
 * - Aréna se sbíráním s díly P42 (`assemblyParts`) dostane ve `genre.v5` průběh s bossem; robot dílů v ní obchází
 *   dopadlou překážku dílu (`HAZARD_SKIRT`), jinak u ní s bossem a chováními ztrácel životy. Díl `chaser` a uložená
 *   `genre.v4` hra průběh nedostanou. Brány na větách dev sady P51 (12 semínek): nečinný nevyhraje, přehrání = hash,
 *   intermediate ≥ 0,8 a jeho výhry mají finále.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

import type { ArcadeParts } from '../addons';
import { arcadeWorldOf, generatorOf, preloadPhysics } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, BODY, type BodyInit, type BotPiece, type ControlPiece, FLAG, HEADER, NO_INPUT, bodyBase, nativeRule } from '../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, step } from '../kernel';
import { loadRapier } from '../physics/world';
import { PACING, type PacingRuleParams, makePacingBot, makePacingControl, pacingRule, withPacing } from '../pieces/pacing';
import { funMetrics, traceRun } from '../telemetry';
import { runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

beforeAll(async () => {
  await loadRapier();
});

describe('P51 T5: a new game boss comes in past a full actor cap', () => {
  const still: ControlPiece<Record<string, never>> = { id: 'still', params: z.object({}).strict(), roles: ['player'], cost: () => ({ bodies: 1, rules: 0 }), step: () => undefined };
  const idle: BotPiece<Record<string, never>> = { id: 'idle', params: z.object({}).strict(), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT };
  const library: ArcadeLibrary = { controls: { pacing_control: makePacingControl({ still }) as ControlPiece }, rules: { pacing: pacingRule as never }, generators: {}, bots: { pacing_bot: makePacingBot({ idle }) as BotPiece } };
  const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 800, h: 1000, d: 800, solid: false };
  const foe = (kind: string): BodyInit => ({ role: 'enemy', kind, x: 0, y: 0, z: 0, w: 800, h: 800, d: 800, solid: false, kinematic: true });

  /** Svět, kde rozvrh před bossem zaplní `maxActors` a nic nezemře (hráč stojí); vrátí předlohu bosse, spawny a živá těla při jeho kroku. */
  const runFull = (room: boolean): { boss: number; spawned: number[]; aliveAtBoss: number } => {
    const base: ArcadeParts = { control: { id: 'still', params: {} }, bot: { id: 'idle', params: {} }, level: { bodies: [player], length: 0, spawnSlots: 40 }, rules: [] };
    const parts = withPacing(base, { seed: 5, goal: { by: 'time', need: 1200, limit: 1200 }, space: 'plane', spots: [-9000, 0, 9000, 0, 0, 9000, 0, -9000], behaviours: [{ body: foe('a') }, { body: foe('b') }], budget: 14, boss: { body: foe('boss'), at: 999, ...(room ? { room: true as const } : {}) } });
    const made = buildWorld({ seed: 5, ...parts }, library);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const params = parts.rules.at(-1)?.params as PacingRuleParams;
    const boss = params.schedule.at(-1)?.template as number;
    expect(params.schedule.at(-1)?.atPermille).toBe(999);
    const program = loadProgram(made.world, library);
    const state = instantiate(made.world);
    const keeper = bodyBase(params.keeper);
    const spawned: number[] = [];
    let aliveAtBoss = -1;
    for (let tick = 0; tick < 1300; tick += 1) {
      const before = state[keeper + BODY.aux0] as number;
      if (aliveAtBoss < 0 && before >= 990) {
        aliveAtBoss = 0;
        for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) if (((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0) aliveAtBoss += 1;
      }
      step(state, NO_INPUT, program, (_rule: number, effect: ArcadeEffect) => { if (effect.kind === 'spawn') spawned.push(effect.template); });
    }
    return { boss, spawned, aliveAtBoss };
  };

  it('a stored world keeps the cap: with every actor slot taken the boss does not come', () => {
    const run = runFull(false);
    expect(run.aliveAtBoss).toBe(PACING.maxActors);
    expect(run.spawned).not.toContain(run.boss);
  });

  it('a genre.v5 boss (bossRoom) comes into a full field on its own extra slot', () => {
    const run = runFull(true);
    expect(run.aliveAtBoss).toBe(PACING.maxActors);
    expect(run.spawned.filter((template) => template === run.boss)).toHaveLength(1);
  });
});

/** Věty dev sady P51 (`evals/play/p51/dev.json`): aréna se sbíráním, díly z padající kořisti, soupeře a překážky. */
const SENTENCES = [
  { id: 'a01', text: 'a farmer catches falling eggs with a basket in the henhouse', parts: ['catch', 'hazard'] },
  { id: 'a03', text: 'a goalkeeper catches falling stars in a magic meadow', parts: ['rival', 'catch', 'hazard'] },
];

const worldOf = (spec: GameSpecV1, seed: number): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const assembled = (kind: string): GameSpecV1 =>
  compileRecipe({ preset: 'assembled', move: 'roam', actions: [], objective: 'reach', threats: kind === 'chaser' ? ['chaser'] : [], content: { genre: 'arena', mode: 'collect', hero: 'robot', setting: 'forest' }, parts: [{ kind, role: 'part_0', label: 'bear', phase: 0, motion: 'fall' }] } as never);

describe('P51 T5: collect arenas built from P42 parts get pacing with a boss', () => {
  for (const { id, text, parts } of SENTENCES) {
    it(`${id}: paced with a boss finale; idle never wins, replay equal, intermediate ≥ 0.8 with a finale`, async () => {
      const spec = draftGameSpecWithMeta(text, 1).spec;
      expect(generatorOf(spec)).toBe('arena_collect');
      expect(spec.genre?.compilerVersion).toBe('genre.v5');
      expect(spec.assemblyParts?.map((part) => part.kind)).toEqual(parts);
      await preloadPhysics(spec, loadRapier);
      let intermediate = 0;
      let finales = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        expect((nativeRule(world.rules, 'pacing')?.params as PacingRuleParams | undefined)?.finale, `${id} seed ${seed}: finale`).toBe('boss');
        expect(nativeRule(world.rules, 'assembly_part'), `${id} seed ${seed}: the parts still play`).toBeDefined();
        const verdict = verifyArcade(world);
        expect(verdict.idle.outcome, `${id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual, `${id} seed ${seed}: replay`).toBe(true);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        if (bot.outcome === 'won') {
          intermediate += 1;
          if (funMetrics(traceRun(world, bot.inputs)).finale.why === 'boss') finales += 1;
        }
      }
      expect(intermediate / SEEDS.length, `${id}: intermediate`).toBeGreaterThanOrEqual(0.8);
      expect(finales, `${id}: every win ends on the boss`).toBe(intermediate);
    }, 300_000);
  }

  it('a chaser part and a stored genre.v4 arena with parts stay unpaced', () => {
    const chaser = assembled('chaser');
    const hazard = assembled('hazard');
    expect(hazard.genre?.compilerVersion).toBe('genre.v5');
    expect(nativeRule(worldOf(hazard, 1).rules, 'pacing')).toBeDefined();
    const stored: GameSpecV1 = { ...hazard, genre: { ...(hazard.genre as NonNullable<GameSpecV1['genre']>), compilerVersion: 'genre.v4' } };
    for (const spec of [chaser, stored]) expect(nativeRule(worldOf(spec, 1).rules, 'pacing')).toBeUndefined();
  });
});
