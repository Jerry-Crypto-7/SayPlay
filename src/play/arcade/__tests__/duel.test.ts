import { describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '../../spec';
import flapFixture from '../__fixtures__/flap.json';
import { arcadeWorldOf } from '../compile';
import { type ArcadeWorld, BODY, BUTTON, COUNTER, HEADER, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { DUEL, DUEL_COUNTER, DUEL_DIFFICULTIES, DUEL_FOE, DUEL_PHASE, type DuelAttack, checkDuelPattern, duelArena, duelPattern } from '../pieces/duel';
import { judgeRules } from '../pieces/timing';
import { runBot, verifyArcade } from '../verify';

// Spec souboje na šabloně poletování – kompilátor čte jen `control`, parametry a mechaniky.
const duelSpec = (controlParams: Record<string, unknown>, health?: number): GameSpecV1 => ({
  ...(flapFixture as GameSpecV1),
  control: 'duel',
  controlParams,
  mechanics: [...(flapFixture as GameSpecV1).mechanics, ...(health === undefined ? [] : [{ id: 'health' as const, params: { max: health } }])],
});

/** Svět s ručním vzorcem (bez kontroly kompilátoru). */
function worldWith(pattern: DuelAttack[], foeHealth = 3): ArcadeWorld {
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'duel', params: { pattern, foeHealth } },
      rules: judgeRules(foeHealth, DUEL.lives),
      bot: { id: 'duel_bot', params: {} },
      level: duelArena.generate(1, duelArena.params.parse({})),
      health: DUEL.lives,
    },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const still = { buttons: 0, axis: 0 };

describe('souboj – vzorec a generátor', () => {
  it('vzorec je ze semínka: stejné semínko = stejný vzorec; 30 semínek × 3 obtížnosti projde kontrolou', () => {
    expect(duelPattern(3, { difficulty: 'hard' })).toEqual(duelPattern(3, { difficulty: 'hard' }));
    const seen = new Set<string>();
    for (const difficulty of DUEL_DIFFICULTIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const pattern = duelPattern(seed, { difficulty });
        expect(checkDuelPattern(pattern), `${difficulty}/${seed}`).toEqual([]);
        seen.add(JSON.stringify(pattern));
      }
    }
    expect(seen.size).toBeGreaterThan(60);
  });

  it('kontrola odhalí soupeře bez mezery a nápřah kratší než reakce', () => {
    expect(checkDuelPattern([{ windup: 30, recover: 0 }]).join()).toMatch(/leaves 0 ticks between attacks – a strike needs more than 10/);
    expect(checkDuelPattern([{ windup: 6, recover: 40 }]).join()).toMatch(/winds up for 6 ticks – a dodge needs more than 10/);
  });
});

describe('souboj – ovládání a pravidla', () => {
  const pattern: DuelAttack[] = [{ windup: 30, recover: 30 }];

  it('úder v mezeře zasáhne soupeře, úder v nápřahu vykryje a hráč se zapotácí', () => {
    const w = worldWith(pattern);
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const foe = bodyBase(DUEL_FOE);
    // Náběh + nápřah: v tiku lead začne nápřah, o 30 tiků později úder.
    for (let tick = 0; tick <= DUEL.lead; tick += 1) step(state, still, program);
    expect(state[foe + BODY.aux0]).toBe(DUEL_PHASE.windup);
    // Úder deset tiků před koncem nápřahu: potácení (24 tiků) ho přečká.
    while ((state[foe + BODY.aux1] as number) > 10) step(state, still, program);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[bodyBase(0) + BODY.aux1]).toBe(-DUEL.stagger);
    // Potácející se hráč neuhne: úder na konci nápřahu vezme život.
    while (state[foe + BODY.aux0] === DUEL_PHASE.windup) step(state, { buttons: BUTTON.DOWN, axis: 0 }, program);
    expect(state[HEADER.counters + COUNTER.health]).toBe(DUEL.lives - 1);
    expect(state[foe + BODY.aux0]).toBe(DUEL_PHASE.open);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[HEADER.counters + COUNTER.score]).toBe(1);
    expect(state[HEADER.counters + DUEL_COUNTER.foeHealth]).toBe(2);
    expect(state[foe + BODY.aux0]).toBe(DUEL_PHASE.struck);
    // Jednou za mezeru.
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[HEADER.counters + COUNTER.score]).toBe(1);
  });

  it('úhyb v nápřahu úder přečká; úhyb nejde držet donekonečna', () => {
    const w = worldWith(pattern);
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const foe = bodyBase(DUEL_FOE);
    for (let tick = 0; tick <= DUEL.lead + 20; tick += 1) step(state, still, program);
    step(state, { buttons: BUTTON.DOWN, axis: 0 }, program);
    expect(state[bodyBase(0) + BODY.h]).toBe(DUEL.crouchH);
    while (state[foe + BODY.aux0] === DUEL_PHASE.windup) step(state, still, program);
    expect(state[HEADER.counters + COUNTER.health]).toBe(DUEL.lives);
    // Držený úhyb: po `dodge` tiků přijde zotavení a další úder zasáhne.
    const held = replay(w, Array.from({ length: 1200 }, (_, tick) => ({ tick, buttons: BUTTON.HOLD, axis: 0 })), ARCADE_LIBRARY);
    expect(held.outcome).toBe('lost');
  });

  it('nečinný hráč prohraje, zásah do nuly soupeřových životů vyhraje', () => {
    const w = worldWith(pattern, 2);
    expect(replay(w, [], ARCADE_LIBRARY).outcome).toBe('lost');
    const bot = runBot(w);
    expect(bot.outcome).toBe('won');
    expect(bot.inputs.filter((input) => input.buttons === BUTTON.TAP)).toHaveLength(2);
  });

  it('soupeř bez mezery mezi útoky neprojde: kontrola i robot', () => {
    const verdict = verifyArcade(worldWith([{ windup: 30, recover: 0 }]));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.bot.outcome).not.toBe('won');
  });
});

describe('souboj – robot a ověření', () => {
  it('robot se zpožděním 8 tiků vyhraje 30 semínek × 3 obtížnosti, nečinný prohraje, přehrání sedí', () => {
    for (const difficulty of DUEL_DIFFICULTIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const made = arcadeWorldOf(duelSpec({ difficulty }, seed % 3 === 0 ? 5 : undefined), seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const verdict = verifyArcade(made.world);
        expect(verdict.failures, `${difficulty}/${seed}`).toEqual([]);
        expect(verdict.bot.outcome).toBe('won');
        expect(verdict.idle.outcome).toBe('lost');
      }
    }
  });

  it('bez mechaniky health má hráč tři životy; spec pustí jen obtížnost', () => {
    const made = arcadeWorldOf(duelSpec({}), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(made.world.initial[HEADER.counters + COUNTER.health]).toBe(DUEL.lives);
    expect(readGameSpec(duelSpec({ difficulty: 'hard' })).ok).toBe(true);
    expect(readGameSpec(duelSpec({ pattern: [] })).ok).toBe(false);
  });
});
