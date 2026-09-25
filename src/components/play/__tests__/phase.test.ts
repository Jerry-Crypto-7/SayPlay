/**
 * Fáze světla v HUD (P25D T1 nález): hra „červená–zelená“ musí barvu ukázat,
 * jinak hráč nemá jak poznat, kdy stát. Hra bez fází řádek nedostane.
 */

import { describe, expect, it } from 'vitest';

import collectExit from '@/play/__fixtures__/collect_exit.json';
import { draftGameSpec } from '@/play/draft';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';
import type { RuntimeSnapshot } from '@/worldstream/runtime-controller';

import { TICKS_PER_SECOND, phaseLine, progressLine } from '../Hud';
import { timerLeft } from '../timer';

const snapshot = (values: Record<string, number>): Pick<RuntimeSnapshot, 'values'> => ({ values });

function specOf(fixture: unknown): GameSpecV1 {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.reason);
  return spec.value;
}

describe('phaseLine', () => {
  const redLight = draftGameSpec('red light green light like squid game');

  it('names the timer flag the compiler writes and follows it', () => {
    const timer = redLight.mechanics.find((mechanic) => mechanic.id === 'timer');
    expect(timer?.params.phases).toBeDefined();
    const flag = `${String(timer?.params.id)}_red`;
    expect(phaseLine(redLight, snapshot({ [`f:${flag}`]: 1 }))).toBe('RED – freeze');
    expect(phaseLine(redLight, snapshot({ [`f:${flag}`]: 0 }))).toBe('GREEN – go');
  });

  it('says nothing for a game without a light', () => {
    expect(phaseLine(specOf(collectExit), snapshot({}))).toBeNull();
  });
});

/** Časovač od AI (P26 T8): audit viděl „tick 9“ místo odpočtu, hra pak skončila bez varování. */
describe('timer countdown', () => {
  const timed = specOf({ ...collectExit, mechanics: [...collectExit.mechanics, { id: 'timer', params: { id: 'clock', seconds: 30, onEnd: 'lose' } }] });

  it('counts the timer down next to the objective counter and stops at zero', () => {
    expect(timerLeft(timed, 12)).toBe('18s left');
    expect(timerLeft(timed, 45)).toBe('0s left');
    expect(progressLine(timed, { tick: 12 * TICKS_PER_SECOND, values: {} })).toBe('0 / 5 · 18s left');
  });

  it('shows no clock for a game without a timer', () => {
    expect(timerLeft(specOf(collectExit), 12)).toBeNull();
    expect(progressLine(specOf(collectExit), { tick: 0, values: {} })).toBe('0 / 5');
  });
});
