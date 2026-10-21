import { describe, expect, it } from 'vitest';

import { fitScale, MAX_SPREAD, MAX_STRETCH, oldOpusOf, resultOf, targets, winnerOf } from '../regen.mjs';

// Výměna, která projde se 6 proti staré 7 od téhož soudce, vypadá v katalogu jako zlepšení.
describe('P57 T6 regeneration rules', () => {
  it('replaces only at 6 or more AND above the old score, best candidate first', () => {
    expect(winnerOf([{ score: 6 }], 5)).toEqual({ score: 6 });
    expect(winnerOf([{ score: 6 }], 6)).toBeNull();
    expect(winnerOf([{ score: 5 }], 3)).toBeNull();
    expect(winnerOf([{ score: null }, { score: 7 }, { score: 8 }], 5)).toEqual({ score: 8 });
  });

  it('compares against the Opus score of the old model when T4 had one', () => {
    expect(oldOpusOf({ score: 4.5, codex: { score: 5 }, claude: { score: 4 } })).toBe(4);
    expect(oldOpusOf({ score: 5, codex: { score: 5 } })).toBeNull();
  });

  it('scales uniformly when the shape fits ±10 %, stretches onto the old box up to MAX_STRETCH, else refuses', () => {
    expect(fitScale([2, 2, 2], [1, 1, 1])).toEqual([0.5, 0.5, 0.5]);
    const [scale] = fitScale([1.1, 1, 1], [1, 1, 1]) as number[];
    for (const ratio of [1.1 * scale, scale]) expect(Math.abs(ratio - 1)).toBeLessThanOrEqual(0.1);
    const stretched = fitScale([1.3, 1, 2], [1, 1, 1.6]) as number[];
    [1, 1, 1.6].forEach((old, axis) => expect([1.3, 1, 2][axis] * stretched[axis]).toBeCloseTo(old));
    expect(fitScale([MAX_STRETCH * 1.01, 1, 1], [1, 1, 1])).toBeNull();
    expect(MAX_STRETCH).toBeGreaterThan(MAX_SPREAD);
  });

  it('names a size refusal rejected-bounds and everything else kept-old', () => {
    expect(resultOf([{ fit: 'bounds' }, { fit: 'bounds' }], undefined)).toBe('rejected-bounds');
    expect(resultOf([{ fit: 'bounds' }, { fit: 'ok', score: 4 }], undefined)).toBe('kept-old');
    expect(resultOf([{ fit: 'ok', score: 7 }], 'bounds: x 1.000 -> 1.200 m (+20 %), over ±10 %')).toBe('rejected-bounds');
    expect(resultOf([{ fit: 'ok', score: 7 }], 'lod1: 900 triangles, the replaced model had 600')).toBe('kept-old');
  });

  it('leaves the top 50 to T8', () => {
    const usage = { top300: ['a', ...Array.from({ length: 49 }, (_, i) => `t${i}`), 'b'] };
    expect(targets({ below6: ['a', 'b', 'c'] }, usage)).toEqual(['b', 'c']);
  });
});
