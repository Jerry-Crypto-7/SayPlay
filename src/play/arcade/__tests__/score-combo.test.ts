/**
 * Skóre, které rozhoduje (P36A T5): kombo za sebrání v řadě, zásah ho shodí,
 * bonus na konci výhry a cílové skóre. Svět je ruční: hráč jede stálou
 * rychlostí vpřed a sbírá mince, které leží v cestě – kdy na ni narazí, určuje
 * jen její `z`.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compileArcade } from '../compile';
import {
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  type BodyInit,
  COMBO,
  COUNTER,
  type ControlPiece,
  HEADER,
  HIT_GRACE,
  NO_INPUT,
  type PieceRef,
  RUN_STATE,
  SCORE_BONUS,
  bodyBase,
} from '../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, step } from '../kernel';
import { RULES } from '../pieces/rules';
import { draftGameSpecWithMeta, readTargetScore } from '../../draft';

/** Stálý běh vpřed, 100 jednotek za tik: mince `n` tiků za předchozí leží o `n × 100` dál. */
const SPEED = 100;
const forward: ControlPiece<Record<string, never>> = {
  id: 'forward',
  params: z.object({}).strict() as never,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player) => {
    state[bodyBase(player) + BODY.vz] = SPEED;
  },
};
const library: ArcadeLibrary = { controls: { forward }, rules: RULES, generators: {}, bots: { none: { id: 'none', params: z.object({}).strict() as never, roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT } } };

const thing = (role: BodyInit['role'], z: number): BodyInit => ({ role, kind: role, x: 0, y: 0, z, w: 800, h: 1000, d: 400, solid: false });
const hero: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 600, h: 1600, d: 500, solid: false };

/** Mince na tikách `ticks` (první dotyk), za nimi volitelně cíl. */
const coinsAt = (ticks: readonly number[]): BodyInit[] => ticks.map((tick) => thing('collectible', 450 + tick * SPEED));

interface Run {
  readonly score: number;
  readonly runState: number;
  readonly tick: number;
  readonly multipliers: readonly number[];
}

/** Postaví svět s počítadlem komba za tělesy a odjede ho bez vstupu. */
function play(bodies: readonly BodyInit[], opts: { health?: number; bonus?: { lives: number; target: number }; ticks?: number } = {}): Run {
  const keeper = 1 + bodies.length;
  const counter: BodyInit = { ...thing('thing', 0), kind: 'player', template: true };
  const level: ArcadeLevel = { bodies: [hero, ...bodies, counter], length: 100_000 };
  const rules: PieceRef[] = [
    { id: 'pickup', params: { combo: keeper } },
    { id: 'hit', params: opts.health === undefined ? { role: 'obstacle', effect: 'lose' } : { role: 'obstacle', effect: 'damage', grace: HIT_GRACE } },
    { id: 'finish', params: {} },
  ];
  if (opts.bonus !== undefined) rules.push({ id: 'score_bonus', params: { lives: opts.bonus.lives, limit: 90 * 60, target: opts.bonus.target } });
  const built = buildWorld({ seed: 1, control: { id: 'forward', params: {} }, rules, bot: { id: 'none', params: {} }, level, ...(opts.health === undefined ? {} : { health: opts.health }) }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const program = loadProgram(built.world, library);
  const state = instantiate(built.world);
  const multipliers: number[] = [];
  for (let tick = 0; tick < (opts.ticks ?? 1200) && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
    for (const effect of step(state, NO_INPUT, program) as ArcadeEffect[]) if (effect.kind === 'combo') multipliers.push(effect.multiplier);
  }
  return { score: state[HEADER.counters + COUNTER.score] as number, runState: state[HEADER.runState] as number, tick: state[HEADER.tick] as number, multipliers };
}

describe('combo multiplier', () => {
  it('scores coins taken in a row higher than the same coins with gaps', () => {
    const inRow = play(coinsAt([20, 50, 80, 110]));
    const gapped = play(coinsAt([20, 20 + COMBO.window + 30, 20 + 2 * (COMBO.window + 30), 20 + 3 * (COMBO.window + 30)]));
    expect(inRow.multipliers).toEqual([1, 2, 3, 4]);
    expect(inRow.score).toBe(1 + 2 + 3 + 4);
    expect(gapped.multipliers).toEqual([1, 1, 1, 1]);
    expect(gapped.score).toBe(4);
  });

  it('stops rising at the cap', () => {
    const run = play(coinsAt([20, 40, 60, 80, 100, 120, 140]));
    expect(run.multipliers).toEqual([1, 2, 3, 4, 5, 5, 5]);
    expect(run.score).toBe(1 + 2 + 3 + 4 + 5 + 5 + 5);
  });

  it('drops back to ×1 after a lost life', () => {
    const obstacle: BodyInit = { ...thing('obstacle', 450 + 65 * SPEED), solid: true };
    const run = play([...coinsAt([20, 50]), obstacle, ...coinsAt([80, 110])], { health: 3 });
    expect(run.multipliers).toEqual([1, 2, 1, 2]);
    expect(run.score).toBe(1 + 2 + 1 + 2);
  });

  it('pickup without a counter scores like before', () => {
    const level: ArcadeLevel = { bodies: [hero, ...coinsAt([20, 50, 80])], length: 100_000 };
    const built = buildWorld({ seed: 1, control: { id: 'forward', params: {} }, rules: [{ id: 'pickup', params: {} }], bot: { id: 'none', params: {} }, level }, library);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const program = loadProgram(built.world, library);
    const state = instantiate(built.world);
    const kinds = new Set<string>();
    for (let tick = 0; tick < 200; tick += 1) for (const effect of step(state, NO_INPUT, program)) kinds.add(effect.kind);
    expect(state[HEADER.counters + COUNTER.score]).toBe(3);
    expect(kinds.has('combo')).toBe(false);
  });
});

describe('end bonus and target score', () => {
  const finishAt = (tick: number): BodyInit => thing('goal', 450 + tick * SPEED);

  it('adds lives, no-hit and time under the limit to the score of a win', () => {
    // Tik výhry je poslední tik běhu (`tick` stavu už je o jeden dál).
    const timeBonus = (run: Run): number => SCORE_BONUS.perSecond * Math.floor((90 * 60 - (run.tick - 1)) / 60);
    const clean = play([finishAt(200)], { health: 3, bonus: { lives: 3, target: 0 } });
    expect(clean.runState).toBe(RUN_STATE.won);
    expect(clean.score).toBe(3 * SCORE_BONUS.perLife + SCORE_BONUS.noHit + timeBonus(clean));
    // Ztracený život: o život a o bonus bez zásahu méně (překážka zmizí, běh jede dál).
    const hit = play([{ ...thing('obstacle', 450 + 100 * SPEED), solid: true }, finishAt(200)], { health: 3, bonus: { lives: 3, target: 0 } });
    expect(hit.runState).toBe(RUN_STATE.won);
    expect(hit.score).toBe(2 * SCORE_BONUS.perLife + timeBonus(hit));
  });

  it('wins as soon as the target score is reached', () => {
    const run = play([...coinsAt([20, 50]), finishAt(400)], { health: 3, bonus: { lives: 3, target: 3 } });
    expect(run.runState).toBe(RUN_STATE.won);
    expect(run.tick - 1).toBeLessThan(60);
  });

  it('turns a win below the target into a loss', () => {
    const run = play([...coinsAt([20, 50]), finishAt(200)], { health: 3, bonus: { lives: 3, target: 9999 } });
    expect(run.runState).toBe(RUN_STATE.lost);
    expect(run.tick - 1).toBeGreaterThanOrEqual(200);
  });
});

describe('target score from the sentence', () => {
  it('reads points and bare scores, not counted nouns', () => {
    expect(readTargetScore('A fox runs through the forest and must score 100 points')).toBe(100);
    expect(readTargetScore('get 500 before time runs out')).toBe(500);
    expect(readTargetScore('reach a score of 300.')).toBe(300);
    expect(readTargetScore('get 5 coins and reach the door')).toBeNull();
    expect(readTargetScore('a cat jumps over boxes')).toBeNull();
  });

  it('a drafted game carries the target and the bot reaches what the world asks', () => {
    const { spec } = draftGameSpecWithMeta('A rabbit runs through a meadow collecting carrots and must score 100 points', 1);
    expect(spec.scoring?.target).toBe(100);
    const compiled = compileArcade(spec, 1);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok || compiled.value.arcade === undefined) return;
    const bonus = compiled.value.arcade.rules.find((ref) => ref.id === 'score_bonus')?.params as { readonly target: number } | undefined;
    expect(bonus?.target).toBeGreaterThanOrEqual(10);
    expect(bonus?.target).toBeLessThanOrEqual(100);
  });
});
