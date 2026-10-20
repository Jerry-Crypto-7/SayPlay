import { describe, expect, it } from 'vitest';

import { createSnapshotCache } from '../snapshot-cache';

/** `objectURL` jako počitadlo: kolik se vytvořilo a které se uvolnily. */
function urls() {
  let made = 0;
  const revoked: string[] = [];
  return { revoked, create: () => `blob:shot-${String((made += 1))}`, revoke: (href: string) => void revoked.push(href) };
}

const blob = new Blob(['x']);

describe('snapshot-cache', () => {
  it('drží nejvýš limit snímků a vyřadí ten, ze kterého hráč odešel nejdřív', () => {
    const fake = urls();
    const cache = createSnapshotCache(3, fake);
    for (const id of ['a', 'b', 'c', 'd']) cache.put(id, blob);
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(['b', 'c', 'd'].map((id) => cache.get(id))).toEqual(['blob:shot-2', 'blob:shot-3', 'blob:shot-4']);
    expect(fake.revoked).toEqual(['blob:shot-1']);
  });

  it('nový snímek téže hry uvolní starý a posune hru na konec fronty', () => {
    const fake = urls();
    const cache = createSnapshotCache(3, fake);
    for (const id of ['a', 'b', 'c']) cache.put(id, blob);
    expect(cache.put('a', blob)).toBe('blob:shot-4');
    expect(fake.revoked).toEqual(['blob:shot-1']);
    cache.put('d', blob);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('blob:shot-4');
    expect(fake.revoked).toEqual(['blob:shot-1', 'blob:shot-2']);
  });

  it('po 50 odchodech přes 25 her drží 20 živých URL a každé vyřazené uvolní právě jednou', () => {
    const fake = urls();
    const cache = createSnapshotCache(undefined, fake);
    for (let i = 0; i < 50; i += 1) cache.put(`g${String(i % 25)}`, blob);
    expect(cache.size).toBe(20);
    expect(fake.revoked).toHaveLength(30);
    expect(new Set(fake.revoked).size).toBe(30);
  });
});
