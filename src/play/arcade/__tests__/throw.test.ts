import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type ArcadeInput, type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, bodyBase } from '../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import {
  THROW,
  THROW_DIFFICULTIES,
  THROW_GOALS,
  type ThrowDifficulty,
  type ThrowPlan,
  boxesOfLevel,
  checkThrowLevel,
  launchVelocity,
  simulateThrow,
  solveThrow,
  throwField,
  throwRules,
  throwSpeed,
} from '../pieces/throw';
import { throwBot } from '../pieces/throw-bot';
import { runBot, verifyArcade } from '../verify';

const params = (difficulty: ThrowDifficulty, extra: Record<string, unknown> = {}) => throwField.params.parse({ difficulty, ...extra });

const idle = { id: 'idle', params: z.object({}), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT };
const library: ArcadeLibrary = { ...ARCADE_LIBRARY, bots: { ...ARCADE_LIBRARY.bots, idle } };

function worldOf(level: ArcadeLevel): ArcadeWorld {
  const built = buildWorld({ seed: 1, control: { id: 'throw', params: {} }, rules: throwRules(), bot: { id: 'idle', params: {} }, level }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Záznam jednoho hodu od tiku `at`: držení `charge` tiků s úhlem, pak puštění. */
function throwInputs(at: number, plan: ThrowPlan): InputEvent[] {
  const events: InputEvent[] = [];
  for (let k = 0; k < plan.charge; k += 1) events.push({ tick: at + k, buttons: BUTTON.HOLD, axis: plan.aim });
  events.push({ tick: at + plan.charge, buttons: BUTTON.TAP, axis: plan.aim });
  return events;
}

const counter = (state: Int32Array, name: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[name]] as number;

describe('hod – generátor', () => {
  it('50 semínek × 3 obtížnosti × 3 druhy cíle mají řešení', () => {
    for (const difficulty of THROW_DIFFICULTIES) {
      for (const goal of THROW_GOALS) {
        for (let seed = 1; seed <= 50; seed += 1) {
          const level = throwField.generate(seed, params(difficulty, { goal }));
          expect(checkThrowLevel(level), `${difficulty}/${goal}/${seed}`).toEqual([]);
          expect(level.bodies.filter((b) => b.role === 'target').length, `${difficulty}/${goal}/${seed}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('bez druhu cíle vybere semínko; „hard“ staví zeď, přes kterou se hází obloukem', () => {
    const goals = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) goals.add(throwField.generate(seed, params('normal')).bodies.find((b) => b.role === 'target')?.kind ?? '');
    expect(goals.size).toBe(3);
    for (let seed = 1; seed <= 10; seed += 1) {
      expect(throwField.generate(seed, params('hard')).bodies.some((b) => b.kind === 'wall')).toBe(true);
      expect(throwField.generate(seed, params('easy')).bodies.some((b) => b.kind === 'wall')).toBe(false);
    }
  });

  it('řešení je skutečné: simulace i jádro trefí stejný cíl', () => {
    const level = throwField.generate(4, params('normal', { goal: 'target' }));
    const target = level.bodies.findIndex((b) => b.role === 'target');
    const plan = solveThrow(boxesOfLevel(level.bodies), target);
    expect(plan).not.toBeNull();
    expect(simulateThrow(boxesOfLevel(level.bodies), plan as ThrowPlan)).toBe(target);
    const state = instantiate(worldOf(level));
    const program = loadProgram(worldOf(level), library);
    const events = throwInputs(0, plan as ThrowPlan);
    for (let t = 0; t < 200; t += 1) step(state, events.find((e) => e.tick === t) ?? NO_INPUT, program);
    expect(((state[bodyBase(target) + BODY.flags] as number) & FLAG.alive)).toBe(0);
    expect(counter(state, 'score')).toBe(1);
  });

  it('kontrola odhalí cíl za zdí, přes kterou žádný hod nedoletí', () => {
    const level = throwField.generate(2, params('easy', { goal: 'target' }));
    const blocked: ArcadeLevel = { ...level, bodies: [...level.bodies, { role: 'obstacle', kind: 'wall', x: 0, y: 0, z: 5000, w: 4000, h: 30_000, d: 400, solid: true }] };
    expect(checkThrowLevel(blocked).join()).toMatch(/cannot be hit by any throw/);
  });
});

describe('hod – ovládání a pravidla', () => {
  it('držení nabíjí sílu jen do meze, puštění hodí a hod ubere', () => {
    const level = throwField.generate(1, params('easy', { goal: 'target' }));
    const w = worldOf(level);
    const program = loadProgram(w, library);
    const state = instantiate(w);
    const p = bodyBase(0);
    for (let t = 0; t < 500; t += 1) step(state, { buttons: BUTTON.HOLD, axis: 300 }, program);
    expect(state[p + BODY.aux1]).toBe(THROW.maxCharge);
    const throws = counter(state, 'ammo');
    step(state, { buttons: BUTTON.TAP, axis: 300 }, program);
    const ball = bodyBase(state[HEADER.spawnBase] as number);
    expect([state[ball + BODY.vy], state[ball + BODY.vz]]).toEqual([launchVelocity(300, THROW.maxCharge).vy, launchVelocity(300, THROW.maxCharge).vz]);
    expect(Math.hypot(state[ball + BODY.vy] as number, state[ball + BODY.vz] as number)).toBeLessThanOrEqual(THROW.maxSpeed);
    expect(throwSpeed(10_000)).toBe(THROW.maxSpeed);
    expect(throwSpeed(-5)).toBe(throwSpeed(1));
    expect(counter(state, 'ammo')).toBe(throws - 1);
    // Po puštění nabíjení začíná od nuly; puštění v rozestupu hodů se zahodí.
    step(state, NO_INPUT, program);
    expect(state[p + BODY.aux1]).toBe(0);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(counter(state, 'ammo')).toBe(throws - 1);
  });

  it('všechny cíle trefené = výhra; hody došly a cíl zbyl = prohra; nečinný hráč nevyhraje', () => {
    const level = throwField.generate(6, params('normal', { goal: 'hoop' }));
    const boxes = boxesOfLevel(level.bodies);
    const targets = level.bodies.flatMap((b, i) => (b.role === 'target' ? [i] : []));
    const inputs: InputEvent[] = [];
    let at = 0;
    for (const target of targets) {
      // Koše na sebe nestíní: řešení nad počátečním polem platí i po předchozích trefách.
      const plan = solveThrow(boxes, target) as ThrowPlan;
      inputs.push(...throwInputs(at, plan));
      at += plan.charge + 200;
    }
    expect(replay(worldOf(level), inputs, library).outcome).toBe('won');

    // Hody jen do země: když dojdou a poslední míček dopadne, je konec.
    const misses: InputEvent[] = [];
    for (let k = 0; k < (level.counters?.ammo ?? 0); k += 1) misses.push(...throwInputs(k * 60, { aim: -1000, charge: 1 }));
    const lost = replay(worldOf(level), misses, library);
    expect(lost.outcome).toBe('lost');

    expect(replay(worldOf(level), [], library).outcome).not.toBe('won');
  });

  it('věž: trefa horního bloku ho shodí, spodní stojí dál na zemi', () => {
    const level = throwField.generate(3, params('easy', { goal: 'tower' }));
    const tower = level.bodies.flatMap((b, i) => (b.role === 'target' ? [i] : [])).slice(-2);
    const [bottom, top] = tower as [number, number];
    const w = worldOf(level);
    const state = instantiate(w);
    const program = loadProgram(w, library);
    const plan = solveThrow(boxesOfLevel(level.bodies), top) as ThrowPlan;
    const events = throwInputs(0, plan);
    let input: ArcadeInput = NO_INPUT;
    for (let t = 0; t < 250; t += 1) {
      input = events.find((e) => e.tick === t) ?? NO_INPUT;
      step(state, input, program);
    }
    expect(((state[bodyBase(top) + BODY.flags] as number) & FLAG.alive)).toBe(0);
    expect(((state[bodyBase(bottom) + BODY.flags] as number) & FLAG.alive)).not.toBe(0);
    expect(state[bodyBase(bottom) + BODY.y]).toBe(0);
  });
});

describe('hod – robot a ověření', () => {
  const botWorld = (level: ArcadeLevel): ArcadeWorld => {
    const built = buildWorld({ seed: 1, control: { id: 'throw', params: {} }, rules: throwRules(), bot: { id: 'throw_bot', params: {} }, level }, ARCADE_LIBRARY);
    if (!built.ok) throw new Error(built.issues.join('; '));
    return built.world;
  };

  it('robot reaguje se zpožděním 8 tiků', () => {
    expect(throwBot.reactionTicks).toBe(8);
  });

  it('30 semínek × 3 obtížnosti projde ověřením: robot vyhraje, nečinný ne, přehrání sedí', () => {
    for (const difficulty of THROW_DIFFICULTIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const verdict = verifyArcade(botWorld(throwField.generate(seed * 7919, params(difficulty))));
        expect(verdict.failures, `${difficulty}/${seed}`).toEqual([]);
        // Hod nemá časový limit: nečinný hráč neprohraje, ale nikdy nevyhraje.
        expect(verdict.idle.outcome, `${difficulty}/${seed}`).not.toBe('won');
      }
    }
  });

  it('robot hází jen tolikrát, kolik je cílů: na míček ve vzduchu počká', () => {
    const level = throwField.generate(5, params('normal', { goal: 'tower', spareThrows: 0 }));
    const run = runBot(botWorld(level));
    expect(run.outcome).toBe('won');
    expect(run.inputs.filter((input) => (input.buttons & BUTTON.TAP) !== 0)).toHaveLength(level.bodies.filter((b) => b.role === 'target').length);
  });

  it('cíl za nepřekonatelnou zdí: hra neprojde a kontrola řekne proč', () => {
    const level = throwField.generate(2, params('easy', { goal: 'target' }));
    const blocked: ArcadeLevel = { ...level, bodies: [...level.bodies, { role: 'obstacle', kind: 'wall', x: 0, y: 0, z: 5000, w: 4000, h: 30_000, d: 400, solid: true }] };
    const verdict = verifyArcade(botWorld(blocked));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures.join()).toMatch(/bot_wins/);
    expect(checkThrowLevel(blocked).join()).toMatch(/cannot be hit by any throw/);
  });

  it('pole bez cílů vyhraje i nečinný hráč – ověřením neprojde', () => {
    const level = throwField.generate(3, params('easy'));
    const empty: ArcadeLevel = { ...level, bodies: level.bodies.filter((b) => b.role !== 'target') };
    const verdict = verifyArcade(botWorld(empty));
    expect(verdict.idle.outcome).toBe('won');
    expect(verdict.failures.join()).toMatch(/idle_loses/);
    expect(verdict.publishEligible).toBe(false);
  });
});
