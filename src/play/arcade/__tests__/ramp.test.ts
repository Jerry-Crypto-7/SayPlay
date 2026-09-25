/**
 * Rampa rychlosti uvnitř běhu (P28C T6): runner, flap a steer zrychlí o 10 %
 * na třetině a o dalších 10 % na dvou třetinách trati. Pin je rychlost hráče
 * před a za značkou, svět bez značek (každý dřív zkompilovaný) beze změny a
 * tvrdá podmínka úlohy: žádná hra nepřestane být vyhratelná – robot vyhraje
 * každou kombinaci parametrů hned na prvním semínku (dveře publikace mají čtyři).
 */

import { describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '@/play/spec';

import flap from '../__fixtures__/flap.json';
import runner from '../__fixtures__/runner.json';
import steer from '../__fixtures__/steer.json';
import { arcadeWorldOf, compileArcade } from '../compile';
import { BODY, type ControlPiece, NO_INPUT, bodyBase, rampMarks, rampedSpeed, stateSize } from '../contract';
import { FLAP, flapControl } from '../pieces/flap';
import { runnerControl } from '../pieces/runner';
import { STEER, steerControl } from '../pieces/steer';

const MARKS: [number, number] = [100_000, 200_000];

function specOf(fixture: unknown, controlParams: Record<string, unknown> = {}): GameSpecV1 {
  const read = readGameSpec({ ...(fixture as object), controlParams: { ...(fixture as GameSpecV1).controlParams, ...controlParams } });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

/** Rychlost vpřed po `ticks` krocích ovládání s hráčem v místě `z` (z se nehýbe – měří se strop v tom místě). */
function speedAt<P>(control: ControlPiece<P>, raw: unknown, z: number, ticks = 1, vz = 0): number {
  const params = control.params.parse(raw) as P;
  const state = new Int32Array(stateSize(1));
  const p = bodyBase(0);
  state[p + BODY.vz] = vz;
  for (let t = 0; t < ticks; t += 1) {
    state[p + BODY.z] = z;
    control.step(state, 0, NO_INPUT, params);
  }
  return state[p + BODY.vz] as number;
}

describe('speed ramp inside a run (P28C T6)', () => {
  it('adds 10 % past each mark at one and two thirds of the track', () => {
    expect(rampMarks(300_000)).toEqual(MARKS);
    expect(rampedSpeed(200, 99_999, MARKS)).toBe(200);
    expect(rampedSpeed(200, 100_000, MARKS)).toBe(220);
    expect(rampedSpeed(200, 250_000, MARKS)).toBe(240);
    expect(rampedSpeed(200, 250_000, undefined)).toBe(200);
  });

  it('the runner and the flap fly faster past each mark; without marks they keep one speed', () => {
    const cases = [
      [runnerControl, { speed: 'normal' }, speedAt(runnerControl, { speed: 'normal' }, 0)],
      [flapControl, {}, FLAP.speed],
    ] as const;
    for (const [control, params, base] of cases) {
      const at = (z: number, ramp?: [number, number]) => speedAt(control as ControlPiece<unknown>, { ...params, ...(ramp === undefined ? {} : { ramp }) }, z);
      expect([at(50_000, MARKS), at(150_000, MARKS), at(250_000, MARKS)]).toEqual([base, Math.floor(base * 1.1), Math.floor(base * 1.2)]);
      expect([at(50_000), at(150_000), at(250_000)]).toEqual([base, base, base]);
    }
  });

  it('the car tops out higher past each mark; without marks the ceiling stays', () => {
    const top = (z: number, ramp?: [number, number]) => speedAt(steerControl, { topSpeed: STEER.topSpeed, ...(ramp === undefined ? {} : { ramp }) }, z, 200);
    expect([top(50_000, MARKS), top(150_000, MARKS), top(250_000, MARKS)]).toEqual([STEER.topSpeed, Math.floor(STEER.topSpeed * 1.1), Math.floor(STEER.topSpeed * 1.2)]);
    expect(top(250_000)).toBe(STEER.topSpeed);
  });

  it.each([
    ['runner', runner],
    ['flap', flap],
    ['steer', steer],
  ])('a compiled %s world carries the marks for its own track', (control, fixture) => {
    const made = arcadeWorldOf(specOf(fixture), 7);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(made.world.control.params.ramp).toEqual(rampMarks(made.world.length));
    // Robot, který rychlost předpovídá, musí znát tytéž značky.
    if (control !== 'runner') expect(made.world.bot.params.ramp).toEqual(rampMarks(made.world.length));
  });

  // [ovládání, fixtura, parametry ovládání k proložení]
  const grid: readonly (readonly [string, unknown, readonly Record<string, unknown>[]])[] = [
    ['runner', runner, ['slow', 'normal', 'fast'].flatMap((speed) => ['low', 'normal', 'high'].map((density) => ({ speed, density, lengthM: 500 })))],
    ['flap', flap, ['easy', 'normal', 'hard'].flatMap((difficulty) => [150, 250].map((lengthM) => ({ difficulty, lengthM })))],
    ['steer', steer, ['easy', 'normal', 'hard'].flatMap((difficulty) => [450, 800].map((lengthM) => ({ difficulty, lengthM })))],
  ];

  // Naměřeno při zavedení: 630/630 kompilací (30 semínek × každé nastavení) vyhraných hned na prvním semínku.
  it.each(grid)('%s: the bot wins every setting on its first seed', (_control, fixture, settings) => {
    const lost: string[] = [];
    for (const setting of settings) {
      const spec = specOf(fixture, setting);
      for (let seed = 1; seed <= 5; seed += 1) {
        const made = compileArcade(spec, seed * 7919);
        if (!made.ok) lost.push(`${JSON.stringify(setting)} seed ${seed * 7919}: ${made.reason} ${made.issues?.[0] ?? ''}`);
      }
    }
    expect(lost).toEqual([]);
  });
});
