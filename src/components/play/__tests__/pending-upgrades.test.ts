/**
 * Rozpracované AI verze v `localStorage` (P27C T3): nejvýš 5, hodina života,
 * a úložiště, které vyhazuje (Safari private, plná kvóta), stránku neshodí.
 */

import { describe, expect, it } from 'vitest';

import { forgetPending, MAX_PENDING, PENDING_KEY, PENDING_TTL_MS, pendingUpgrades, rememberPending } from '../pending-upgrades';

function memoryStore(): Pick<Storage, 'getItem' | 'setItem'> & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

const NOW = 1_800_000_000_000;
const entry = (n: number, startedAt = NOW) => ({ draftId: `d${n}`, sentence: `game ${n}`, startedAt });

describe('pending upgrades', () => {
  it('zapamatuje práci a vrátí nejnovější první', () => {
    const store = memoryStore();
    rememberPending(entry(1, NOW - 2_000), NOW, store);
    rememberPending(entry(2, NOW - 1_000), NOW, store);
    expect(pendingUpgrades(NOW, store).map((known) => known.draftId)).toEqual(['d2', 'd1']);
  });

  it('drží nejvýš 5 položek', () => {
    const store = memoryStore();
    for (let n = 1; n <= 7; n += 1) rememberPending(entry(n), NOW, store);
    const kept = pendingUpgrades(NOW, store);
    expect(kept).toHaveLength(MAX_PENDING);
    expect(kept.map((known) => known.draftId)).toEqual(['d7', 'd6', 'd5', 'd4', 'd3']);
    expect(JSON.parse(store.items.get(PENDING_KEY)!)).toHaveLength(MAX_PENDING);
  });

  it('starší než hodina se zahodí', () => {
    const store = memoryStore();
    rememberPending(entry(1, NOW - PENDING_TTL_MS), NOW, store);
    rememberPending(entry(2, NOW - PENDING_TTL_MS + 1), NOW, store);
    expect(pendingUpgrades(NOW, store).map((known) => known.draftId)).toEqual(['d2']);
  });

  it('návrat práci neomladí a zapomenutí ji smaže', () => {
    const store = memoryStore();
    rememberPending(entry(1, NOW - 50_000), NOW, store);
    rememberPending(entry(1, NOW), NOW, store);
    expect(pendingUpgrades(NOW, store)).toEqual([entry(1, NOW - 50_000)]);
    forgetPending('d1', NOW, store);
    expect(pendingUpgrades(NOW, store)).toEqual([]);
  });

  it('nečitelný obsah je prázdný seznam', () => {
    const store = memoryStore();
    store.items.set(PENDING_KEY, '{not json');
    expect(pendingUpgrades(NOW, store)).toEqual([]);
    store.items.set(PENDING_KEY, JSON.stringify([{ draftId: '../x', sentence: 's', startedAt: NOW }, { draftId: 'ok', sentence: 1 }, entry(3)]));
    expect(pendingUpgrades(NOW, store)).toEqual([entry(3)]);
  });

  it('úložiště, které vyhazuje (Safari private), nic neshodí', () => {
    const throwing = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(() => rememberPending(entry(1), NOW, throwing)).not.toThrow();
    expect(() => forgetPending('d1', NOW, throwing)).not.toThrow();
    expect(pendingUpgrades(NOW, throwing)).toEqual([]);
  });

  it('bez localStorage (server, zakázané úložiště) je seznam prázdný', () => {
    expect(pendingUpgrades(NOW)).toEqual([]);
    expect(() => rememberPending(entry(1), NOW)).not.toThrow();
  });
});
