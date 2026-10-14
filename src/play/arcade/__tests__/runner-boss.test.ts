/**
 * Boss běžce (P46B T4): finále běžce je boss, který v pruzích útočí – skok do pruhu hráče a hozená překážka,
 * obojí po varování aspoň `TELEGRAPH_MIN` tiků – a padne po třech uhnutých útocích. Výhru nedá: hra se dál
 * vyhrává doběhnutím do cíle. Obtížnost hlídá jen robot, proto ji test měří na skutečných hrách běžce.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, RUN_STATE, bodyBase, bodyHp, nativeRule } from '../contract';
import { instantiate } from '../kernel';
import { loadRapier } from '../physics/world';
import { TELEGRAPH_MIN, behaviourMemoOf, behaviourPhaseOf } from '../pieces/behaviours';
import { behaviourHarness, play, refsOf, telegraphCheck } from '../pieces/behaviours/__tests__/harness';
import { BOSS, bossOpen } from '../pieces/behaviours/boss';
import type { PacingRuleParams } from '../pieces/pacing';
import { RUNNER_FOES } from '../pieces/pacing-parts';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

/** Hozená překážka startuje ≥ `BOSS.track.near` (8 m) před hráčem a blíží se nejvýš ~370/tik: dřív než za 10 tiků ho minout nemůže. */
const FLIGHT_MIN = 10;

interface BossRun {
  /** `RUN_STATE` na konci záznamu. */
  readonly outcome: number;
  readonly end: number;
  /** Zásahy bosse, tik, kdy zmizel (−1 = do konce ne), a varování před každým útokem. */
  readonly hits: number;
  readonly gone: number;
  readonly warnings: readonly number[];
  /** Skoky, během nichž hráči ubyl život, a kolik z nich přesto bossovi ubralo život. */
  readonly hurtLeaps: number;
  readonly hurtBlows: number;
  /** Zásahy za hozenou překážku dřív, než mohla hráče minout, zásahy bez skoku i bez minulé překážky, a tiky otevřeného okna. */
  readonly earlyThrows: number;
  readonly stray: number;
  readonly open: number;
}

/** Přehraje vstupy a sleduje první živé tělo bosse (spawn předlohy `template`, nebo tělo `fixed` úrovně). */
function bossRun(world: ArcadeWorld, inputs: Parameters<typeof play>[1], template: number, fixed?: number): BossRun {
  const shot = refsOf(world).find((ref) => ref.id === 'boss')?.shot;
  let body = -1;
  let gone = -1;
  let end = 0;
  let warned = 0;
  let last = 'idle';
  let armed = 0;
  let armedAt = -1;
  let thrownAt = -1;
  const count = { hits: 0, hurtLeaps: 0, hurtBlows: 0, earlyThrows: 0, stray: 0, open: 0 };
  const warnings: number[] = [];
  const final = play(world, inputs, (state, tick, effects: readonly ArcadeEffect[]) => {
    end = tick;
    for (let b = fixed ?? (state[HEADER.spawnBase] as number); body < 0 && b < (state[HEADER.bodyCount] as number); b += 1) {
      const same = (slot: number): boolean => state[bodyBase(b) + slot] === state[bodyBase(template) + slot];
      if ((b === fixed || (fixed === undefined && same(BODY.kind) && same(BODY.w))) && ((state[bodyBase(b) + BODY.flags] as number) & FLAG.alive) !== 0) body = b;
    }
    if (body < 0 || gone >= 0) return;
    const health = state[HEADER.counters + COUNTER.health] as number;
    const phase = behaviourPhaseOf(state, body);
    if (phase === 'telegraph' && last !== 'telegraph') [armed, armedAt] = [health, tick];
    if (phase === 'telegraph') warned += 1;
    if (phase === 'act' && last !== 'act') warnings.push(warned);
    if (phase !== 'telegraph') warned = phase === 'act' ? warned : 0;
    if (bossOpen(state, body, phase, behaviourMemoOf(state, body))) count.open += 1;
    const isShot = (b: number): boolean => shot !== undefined && b !== body && state[bodyBase(b) + BODY.kind] === state[bodyBase(shot) + BODY.kind];
    if (effects.some((effect) => effect.kind === 'spawn' && effect.template === shot)) thrownAt = tick;
    const blows = effects.filter((effect) => effect.kind === 'hit' && effect.body === body).length;
    const passed = Math.min(blows, effects.filter((effect) => effect.kind === 'despawn' && isShot(effect.body)).length);
    // Skok skončí prvním tikem `recover` útoku, ve kterém boss nic nehodil.
    const leapEnd = phase === 'recover' && last !== 'recover' && thrownAt < armedAt;
    const leapBlow = leapEnd && blows > passed ? 1 : 0;
    if (leapEnd && health < armed) [count.hurtLeaps, count.hurtBlows] = [count.hurtLeaps + 1, count.hurtBlows + leapBlow];
    if (passed > 0 && tick - thrownAt < FLIGHT_MIN) count.earlyThrows += passed;
    count.stray += blows - passed - leapBlow;
    count.hits += blows;
    last = phase;
    if (effects.some((effect) => effect.kind === 'despawn' && effect.body === body)) gone = tick;
  });
  return { outcome: final[HEADER.runState] as number, end, gone, warnings, ...count };
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
    // Boss na trati s pravidlem zásahu (dotek ve skoku zraní): hráč, který stojí, nepadne mu. Skok, který ho zranil,
    // bossovi život nebere; hozená překážka ho stojícího zasáhne, nemine.
    const harness = behaviourHarness('track', 'boss', 1, { extra: (parts) => ({ ...parts, rules: [...parts.rules, { id: 'boss_beat', params: { boss: parts.level.bodies.findIndex((body) => body.template === true && body.kind === 'boss') } }] }) });
    const idle = bossRun(harness.world, [], harness.body, harness.body);
    expect(idle.warnings.length).toBeGreaterThanOrEqual(2);
    for (const warned of idle.warnings) expect(warned).toBeGreaterThanOrEqual(TELEGRAPH_MIN);
    expect(idle.hurtLeaps).toBeGreaterThan(0);
    expect(idle).toMatchObject({ hurtBlows: 0, earlyThrows: 0, stray: 0, open: 0, gone: -1 });
    expect(idle.hits).toBeLessThan(idle.warnings.length);
    // Robot, který uhýbá plánovačem pruhů, ho uhnutými útoky porazí; na trati se okno zásahu nikdy neotevře.
    const bot = runBot(harness.world);
    const dodged = bossRun(harness.world, bot.inputs, harness.body, harness.body);
    // Tělo harnessu je výchozí boss (`BOSS.hp`), ne boss běžce.
    expect(dodged.hits).toBe(BOSS.hp);
    expect(dodged.gone).toBeGreaterThan(0);
    expect(dodged).toMatchObject({ hurtBlows: 0, earlyThrows: 0, stray: 0, open: 0 });
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
          const fight = bossRun(world, run.inputs, boss.template);
          expect(fight.hits, `${id}: boss hits`).toBeGreaterThanOrEqual(3);
          expect(fight.hurtBlows, `${id}: a leap that hurt the player`).toBe(0);
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
