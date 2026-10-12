/**
 * Boss běžce (P46B T4): finále běžce je boss, který v pruzích útočí – skok do pruhu hráče a hozená překážka,
 * obojí po varování aspoň `TELEGRAPH_MIN` tiků – a padne po třech uhnutých útocích. Výhru nedá: hra se dál
 * vyhrává doběhnutím do cíle. Obtížnost hlídá jen robot, proto ji test měří na skutečných hrách běžce.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, BODY, FLAG, HEADER, RUN_STATE, bodyBase, bodyHp, nativeRule } from '../contract';
import { instantiate } from '../kernel';
import { loadRapier } from '../physics/world';
import { TELEGRAPH_MIN, behaviourPhaseOf } from '../pieces/behaviours';
import { behaviourHarness, play, refsOf, telegraphCheck } from '../pieces/behaviours/__tests__/harness';
import { BOSS } from '../pieces/behaviours/boss';
import type { PacingRuleParams } from '../pieces/pacing';
import { RUNNER_FOES } from '../pieces/pacing-parts';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

interface BossRun {
  /** `RUN_STATE` na konci záznamu. */
  readonly outcome: number;
  readonly end: number;
  /** Zásahy bosse, tik, kdy zmizel (−1 = do konce ne), a varování před každým útokem. */
  readonly hits: number;
  readonly gone: number;
  readonly warnings: readonly number[];
}

/** Přehraje vstupy a sleduje první živé tělo bosse (spawn předlohy `template`, nebo tělo `fixed` úrovně). */
function bossRun(world: ArcadeWorld, inputs: Parameters<typeof play>[1], template: number, fixed?: number): BossRun {
  let body = -1;
  let hits = 0;
  let gone = -1;
  let end = 0;
  let warned = 0;
  let last = 'idle';
  const warnings: number[] = [];
  const final = play(world, inputs, (state, tick, effects: readonly ArcadeEffect[]) => {
    end = tick;
    for (let b = fixed ?? (state[HEADER.spawnBase] as number); body < 0 && b < (state[HEADER.bodyCount] as number); b += 1) {
      const same = (slot: number): boolean => state[bodyBase(b) + slot] === state[bodyBase(template) + slot];
      if ((b === fixed || (fixed === undefined && same(BODY.kind) && same(BODY.w))) && ((state[bodyBase(b) + BODY.flags] as number) & FLAG.alive) !== 0) body = b;
    }
    if (body < 0 || gone >= 0) return;
    const phase = behaviourPhaseOf(state, body);
    if (phase === 'telegraph') warned += 1;
    if (phase === 'act' && last !== 'act') warnings.push(warned);
    if (phase !== 'telegraph') warned = phase === 'act' ? warned : 0;
    last = phase;
    for (const effect of effects) {
      if (effect.kind === 'hit' && effect.body === body) hits += 1;
      if (effect.kind === 'despawn' && effect.body === body) gone = tick;
    }
  });
  return { outcome: final[HEADER.runState] as number, end, hits, gone, warnings };
}

/** Běžec bez a se střelbou; `+chase_me` hraje na semínkách 1–20 totéž co bez něj (měření T4). */
const runnerSpecs = liveCells().filter((cell) => cell.id === 'runner.default' || cell.id === 'runner.default+shoot_at').map((cell) => ({ id: cell.id, spec: compileRecipe(assemblyOfCell(cell)) }));

describe('runner boss', () => {
  it('ends the runner with a boss: the last behaviour, three lives, its own hit rule, arriving at 760 ‰', () => {
    const made = arcadeWorldOf(runnerSpecs.find((cell) => cell.id === 'runner.default')!.spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const refs = refsOf(made.world);
    const boss = refs[refs.length - 1]!;
    expect(boss.id).toBe('boss');
    const rule = nativeRule(made.world.rules, 'pacing')?.params as PacingRuleParams;
    expect(rule.finale).toBe('boss');
    expect(rule.schedule.find((entry) => entry.template === boss.template)?.atPermille).toBe(RUNNER_FOES.bossAt);
    expect(bodyHp(instantiate(made.world), boss.template)).toBe(BOSS.track.hp);
    expect(nativeRule(made.world.rules, 'boss_beat')?.params).toMatchObject({ boss: boss.template });
    expect(nativeRule(made.world.rules, 'boss_beat')?.params).not.toHaveProperty('drop');
  });

  it('warns at least TELEGRAPH_MIN ticks before every attack and loses a life only to an attack the player dodged', () => {
    // Boss na trati s pravidlem zásahu (dotek ve skoku zraní): hráč, který stojí, nepadne mu. Zásah mu dá jen útok,
    // který hráče zastihl v milosti po předchozím zásahu (život neubyl) – nikdy všechny.
    const harness = behaviourHarness('track', 'boss', 1, { extra: (parts) => ({ ...parts, rules: [...parts.rules, { id: 'boss_beat', params: { boss: parts.level.bodies.findIndex((body) => body.template === true && body.kind === 'boss') } }] }) });
    const idle = bossRun(harness.world, [], harness.body, harness.body);
    expect(idle.warnings.length).toBeGreaterThanOrEqual(2);
    for (const warned of idle.warnings) expect(warned).toBeGreaterThanOrEqual(TELEGRAPH_MIN);
    expect(idle.hits).toBeLessThan(idle.warnings.length);
    expect(idle.gone).toBe(-1);
    // Robot, který uhýbá plánovačem pruhů, ho třemi uhnutými útoky porazí.
    const bot = runBot(harness.world);
    const dodged = bossRun(harness.world, bot.inputs, harness.body, harness.body);
    // Tělo harnessu je výchozí boss (`BOSS.hp`), ne boss běžce.
    expect(dodged.hits).toBe(BOSS.hp);
    expect(dodged.gone).toBeGreaterThan(0);
    for (const warned of dodged.warnings) expect(warned).toBeGreaterThanOrEqual(TELEGRAPH_MIN);
  });

  it('keeps runner difficulty in band with the boss: novice 0.3–0.7, intermediate ≥ 0.8, each intermediate win beats the boss before the finish, idle never wins', async () => {
    for (const { id, spec } of runnerSpecs) {
      await preloadPhysics(spec, loadRapier);
      const worlds = SEEDS.map((seed) => {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        return made.world;
      });
      const wins = { novice: 0, intermediate: 0 };
      for (const world of worlds) {
        // Předloha bosse je za tělesy úrovně – každé semínko má jiný počet překážek.
        const boss = refsOf(world).find((ref) => ref.id === 'boss')!;
        expect(boss, id).toBeDefined();
        for (const profile of ['novice', 'intermediate'] as const) {
          const run = runBot(world, undefined, { profile });
          if (run.outcome !== 'won') continue;
          wins[profile] += 1;
          if (profile === 'novice') {
            expect(telegraphCheck(world, run.inputs).violations, id).toEqual([]);
            continue;
          }
          // Měřidlo finále: hrozba s ≥ 3 zásahy, která do konce zmizí – a výhru přinesl až cíl, ne pád bosse.
          const fight = bossRun(world, run.inputs, boss.template);          expect(fight.hits, `${id}: boss hits`).toBeGreaterThanOrEqual(3);
          expect(fight.gone, `${id}: boss gone`).toBeGreaterThan(0);
          expect(fight.gone, `${id}: boss falls before the finish`).toBeLessThan(fight.end);
        }
        expect(bossRun(world, [], boss.template).outcome, `${id}: idle`).not.toBe(RUN_STATE.won);
      }
      expect(wins.intermediate / SEEDS.length, `${id}: intermediate`).toBeGreaterThanOrEqual(0.8);
      expect(wins.novice / SEEDS.length, `${id}: novice`).toBeGreaterThanOrEqual(0.3);
      expect(wins.novice / SEEDS.length, `${id}: novice`).toBeLessThanOrEqual(0.7);
    }
  }, 600_000);
});
