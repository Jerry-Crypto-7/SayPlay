/** Fáze z křivky napětí (P45C T11): úvod 90 %, stupňování 100 %, vrchol 115 %, finále 125 %. */

import { describe, expect, it } from 'vitest';

import { TENSION_CURVE } from '@/play/arcade/pieces/pacing';

import { phasesFromCurve, phasesSchema } from '../progression';

describe('phasesFromCurve', () => {
  it('turns the four sections of the tension curve into valid phases', () => {
    const phases = phasesFromCurve(TENSION_CURVE);
    expect(phases).toEqual([
      { start: 0, speedPercent: 90 },
      { start: 200, speedPercent: 100 },
      { start: 650, speedPercent: 115 },
      { start: 850, speedPercent: 125 },
    ]);
    expect(phasesSchema.safeParse(phases).success).toBe(true);
  });

  it('rejects a curve with another number of sections', () => {
    expect(() => phasesFromCurve([[0, 700], [500, 900], [1000, 900]])).toThrow(/4 sections/);
  });
});
