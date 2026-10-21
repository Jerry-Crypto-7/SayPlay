import { describe, expect, it } from 'vitest';

import { HERO_PASS, heroSummary, heroTargets, heroWins, pickBest } from '../top50.mjs';

const GEN = 'LicenseRef-Worldsmith-Generated';
const asset = (assetId: string, license: string) => ({ assetId, provenance: { license } });
const top300 = ['gen-high', 'cc0-low', 'cc0-high', 'orig-low', 'gen-low', ...Array.from({ length: 60 }, (_, i) => `rest-${i}`)];
const usage = { top300 };
const judge = {
  models: {
    'gen-high': { score: 8, codex: { reason: 'fine' } },
    'cc0-low': { score: 5, claude: { reason: 'thin blades' } },
    'cc0-high': { score: 9 },
    'orig-low': { score: 7 },
    'gen-low': { score: 4 },
    ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`rest-${i}`, { score: 8 }])),
  } as Record<string, { score: number | null; claude?: { reason?: string }; codex?: { reason?: string } }>,
};
const catalog = {
  assets: [
    asset('gen-high', GEN), asset('cc0-low', 'CC0-1.0'), asset('cc0-high', 'CC0-1.0'), asset('orig-low', 'LicenseRef-Worldsmith-Original'), asset('gen-low', GEN),
    ...Array.from({ length: 60 }, (_, i) => asset(`rest-${i}`, i % 2 ? GEN : 'CC0-1.0')),
  ],
};

describe('top50 (P57 T8)', () => {
  it('targets every generated model of the top 50 and the rest only below 8', () => {
    const targets = heroTargets(judge, usage, catalog);
    expect(targets.slice(0, 4)).toEqual(['gen-high', 'cc0-low', 'orig-low', 'gen-low']);
    // Zbytek top 50 je rest-0…44: generované liché (22), CC0 s 8 přeskočí; za top 50 nic.
    expect(targets).toHaveLength(4 + 22);
    expect(targets.every((id) => top300.indexOf(id) < 50)).toBe(true);
  });

  it('picks the best readable 2x2 candidate, earlier on a tie', () => {
    expect(pickBest([{ pick: 6, k: 'a' }, { pick: null, k: 'b' }, { pick: 8, k: 'c' }, { pick: 8, k: 'd' }])).toEqual({ pick: 8, k: 'c' });
    expect(pickBest([{ pick: null }, {}])).toBeNull();
  });

  it('a round wins only at 8+ and above the old score of the same judge', () => {
    expect(heroWins(HERO_PASS, 7)).toBe(true);
    expect(heroWins(7, 3)).toBe(false);
    expect(heroWins(8, 8)).toBe(false);
    expect(heroWins(9, null)).toBe(true);
    expect(heroWins(null, 2)).toBe(false);
  });

  it('counts the whole top 50: replaced by the new score, kept and skipped by the old one', () => {
    const summary = heroSummary(usage, judge, {
      'gen-low': { result: 'replaced', newScore: 8, oldOpus: 4 },
      'cc0-low': { result: 'kept-old', newScore: 7, oldOpus: 6, reason: 'Opus: still thin' },
      'gen-high': { result: 'kept-old', newScore: 7, oldOpus: 9 },
    });
    expect(summary.of).toBe(50);
    expect(summary.below).toEqual([
      { id: 'cc0-low', score: 6, reason: 'Opus: still thin' },
      { id: 'orig-low', score: 7, reason: 'unjudged' },
    ]);
    expect(summary.atLeast8).toBe(48);
  });
});
