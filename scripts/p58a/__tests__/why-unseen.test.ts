/**
 * Proč slovo věty soudce neviděl (P58A T2). Třída rozhoduje, která úloha slovo opraví – role (T6), model (T6/T7),
 * velikost (T3), záběr (T4), vzhled – a špatná třída pošle práci jinam, i když tabulka vypadá věrohodně.
 */

import { describe, expect, it } from 'vitest';

import { carrierOf, classify, heightShare, onScreen, rankMissing, thresholdOf } from '../why-unseen.mjs';

const box = (minY: number, maxY: number, extra: Record<string, unknown> = {}) => ({ x: 0, y: (minY + maxY) / 2, minX: -0.1, maxX: 0.1, minY, maxY, widthPx: 0, heightPx: 0, sizePx: 0, behind: false, ...extra });

describe('why-unseen', () => {
  it('finds the role that carries a noun by its singular or its head word', () => {
    const roles = [{ id: 'p', kind: 'player', label: 'giant yeti' }, { id: 'a', kind: 'collectible', label: 'flies' }, { id: 'b', kind: 'enemy', label: 'robot' }];
    expect(carrierOf('yeti', true, roles)?.id).toBe('p');
    expect(carrierOf('fly', false, roles)?.id).toBe('a');
    expect(carrierOf('crocodile', false, roles)).toBeNull();
    // Hrdina se hledá jen v hráči, protivník nikdy v hráči.
    expect(carrierOf('robot', true, roles)).toBeNull();
    expect(carrierOf('yeti', false, roles)).toBeNull();
  });

  it('measures the on-canvas part of the box and drops boxes behind or outside the camera', () => {
    expect(heightShare(box(-0.5, 0.5))).toBeCloseTo(0.5);
    expect(heightShare(box(0.8, 1.6))).toBeCloseTo(0.1);
    expect(onScreen(box(-0.2, 0.2))).toBe(true);
    expect(onScreen(box(-0.2, 0.2, { behind: true }))).toBe(false);
    expect(onScreen(box(1.1, 1.4))).toBe(false);
    expect(onScreen(null)).toBe(false);
  });

  it('puts each unseen noun into exactly one class, in the order role, model, screen, size, look', () => {
    const threshold = 0.2;
    expect(classify({ carrier: null, level: null, box: null, threshold })).toBe('no-role');
    expect(classify({ carrier: { label: 'robot' }, level: 'fallback', box: box(-0.5, 0.5), threshold })).toBe('no-model');
    expect(classify({ carrier: { label: 'cat' }, level: 'identity', box: null, threshold })).toBe('off-screen');
    expect(classify({ carrier: { label: 'cat' }, level: 'identity', box: box(-0.05, 0.05), threshold })).toBe('too-small');
    expect(classify({ carrier: { label: 'cat' }, level: 'near', box: box(-0.3, 0.3), threshold })).toBe('look');
  });

  it('takes the size threshold that best splits seen from unseen nouns', () => {
    const points = [0.02, 0.04, 0.05, 0.07].map((share) => ({ share, visible: false })).concat([0.12, 0.2, 0.3].map((share) => ({ share, visible: true })), [{ share: 0.09, visible: true }]);
    const split = thresholdOf(points);
    expect(split.threshold).toBeGreaterThan(0.07);
    expect(split.threshold).toBeLessThanOrEqual(0.09);
    expect(split.correct).toBe(8);
    expect(thresholdOf([]).threshold).toBeNull();
  });

  it('ranks missing nouns by sentence count and keeps only the ones without an exact model', () => {
    const rows = [{ noun: 'okapi', sentences: 1 }, { noun: 'cat', sentences: 9 }, { noun: 'kraken', sentences: 4 }, { noun: 'axolotl', sentences: 4 }];
    const ranked = rankMissing(rows, (noun: string) => (noun === 'cat' ? { level: 'identity', model: 'cat' } : { level: 'class', model: 'lizard' }));
    expect(ranked.map((row) => row.noun)).toEqual(['axolotl', 'kraken', 'okapi']);
    expect(ranked[0]).toMatchObject({ noun: 'axolotl', sentences: 4, level: 'class', model: 'lizard' });
  });
});
