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
import { BODY, type BodyInit, type ControlPiece, NO_INPUT, UNIT, bodyBase, rampMarks, rampedSpeed, stateSize } from '../contract';
import { FLAP, checkFlapLevel, flapControl } from '../pieces/flap';
import { RUNNER_TRACK, SPEED, checkRunnerLevel, runnerControl } from '../pieces/runner';
import { STEER, STEER_TRACK, checkSteerLevel, lateralReach, steerControl } from '../pieces/steer';

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

  // Kontrola úrovně je poslední pojistka vyhratelnosti: úsek, který by při stálé
  // rychlosti prošel akorát, musí za značkou rampy odmítnout. Úroveň je ručně
  // postavená přesně na hraně; ostatní nálezy (start, cíl) se tu nesoudí. Bez
  // značek je `[]` – `undefined` by vzal výchozí značky trati.
  const body = (fields: Partial<BodyInit>): BodyInit => ({ role: 'obstacle', kind: 'box', x: 0, y: 0, z: 0, w: UNIT, h: UNIT, d: UNIT, ...fields }) as BodyInit;
  const length = 300 * UNIT; // značky na 100 a 200 m
  const edge = 210 * UNIT; // za druhou značkou: +20 %

  it('the runner check spaces rows for the ramped speed past a mark', () => {
    const gap = RUNNER_TRACK.minGapTicks * SPEED.normal;
    const level = { length, bodies: [body({ role: 'player' }), body({ z: edge }), body({ z: edge + gap })] };
    const tooClose = (ramp?: readonly number[]) => checkRunnerLevel(level, 'normal', ramp).filter((issue) => issue.includes('closer than'));
    expect(tooClose([])).toEqual([]);
    expect(tooClose(rampMarks(length))).toHaveLength(1);
  });

  it('the flap check lets the pipes climb less where the bird flies faster', () => {
    const span = 5 * UNIT;
    const climb = Math.floor(FLAP.climbPerUnit * span);
    const pipes = (z: number, bottom: number) => [body({ z, y: 0, h: bottom }), body({ z, y: FLAP.ceiling, h: UNIT })];
    const level = { length, bodies: [body({ role: 'player' }), ...pipes(edge, UNIT), ...pipes(edge + span, UNIT + climb)] };
    const tooFar = (ramp?: readonly number[]) => checkFlapLevel(level, ramp).filter((issue) => issue.includes('too far to follow'));
    expect(tooFar([])).toEqual([]);
    expect(tooFar(rampMarks(length))).toHaveLength(1);
  });

  it('the steer check sizes a bend for the car ramped past a mark', () => {
    const segment = STEER_TRACK.segment;
    const walls = (near: number, center: number, width: number) =>
      [-1, 1].map((side) => body({ kind: 'tire-barrier', z: near + segment / 2, d: segment, w: STEER.wallW, x: center + side * (width / 2 + STEER.wallW / 2) }));
    const reach = (speed: number) => lateralReach(segment, speed) - STEER.clearance;
    const base = reach(STEER.topSpeed + STEER.boost);
    // Předpoklad testu: za značkou je dosah doopravdy menší.
    expect(reach(rampedSpeed(STEER.topSpeed, edge, rampMarks(length)) + STEER.boost)).toBeLessThan(base);
    const width = 8 * UNIT;
    const level = { length, bodies: [body({ role: 'player' }), ...walls(edge, 0, width), ...walls(edge + segment, 0, width), ...walls(edge + 2 * segment, base, width)] };
    const tooSharp = (ramp?: readonly number[]) => checkSteerLevel(level, STEER.topSpeed, ramp).filter((issue) => issue.includes('can steer only'));
    expect(tooSharp([])).toEqual([]);
    expect(tooSharp(rampMarks(length))).toHaveLength(1);
  });

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
