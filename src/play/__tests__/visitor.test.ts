/**
 * Id návštěvníka (P63 T5): náhodné UUID v `localStorage`, jedno na prohlížeč. Id, které se nedrží, by každou
 * návštěvu počítalo jako nového hráče a D1/D7 by tiše klesly k nule – proto bez úložiště žádné id.
 */

import { describe, expect, it } from 'vitest';

import { VISITOR_KEY, VISITOR_PATTERN, visitorId } from '../visitor';

function memoryStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

describe('visitorId', () => {
  it('creates a random UUID once and then keeps it', () => {
    const storage = memoryStorage();
    const first = visitorId(() => storage);
    expect(first).toMatch(VISITOR_PATTERN);
    expect(storage.items.get(VISITOR_KEY)).toBe(first);
    expect(visitorId(() => storage)).toBe(first);
    expect(visitorId(() => memoryStorage())).not.toBe(first);
  });

  it('replaces a stored value that is not a UUID', () => {
    const storage = memoryStorage({ [VISITOR_KEY]: 'john.doe@example.com' });
    const id = visitorId(() => storage);
    expect(id).toMatch(VISITOR_PATTERN);
    expect(storage.items.get(VISITOR_KEY)).toBe(id);
  });

  it('gives no id when storage is blocked or full, and never throws', () => {
    expect(visitorId(() => { throw new DOMException('denied', 'SecurityError'); })).toBeNull();
    const full = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(visitorId(() => full)).toBeNull();
  });
});
