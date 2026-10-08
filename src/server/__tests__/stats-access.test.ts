/**
 * Brána interní stránky `/play/stats` (P44B T13): na veřejném nasazení pustí jen správný
 * `?key=`, bez klíče jen lokální demo. Otevřená brána vypadá pro majitele s klíčem stejně
 * jako zavřená, proto každý směr pinuje vlastní případ.
 */

import * as crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const { STATS_KEY_MIN_CHARS, statsAccess } = await import('../stats-access');

const KEY = 'test-stats-key-not-a-secret-0001';
const LOCAL = {};
const VERCEL = { VERCEL: '1' };

afterEach(() => {
  vi.mocked(crypto.timingSafeEqual).mockClear();
});

describe('statsAccess', () => {
  it('lets a local run without a key in (the demo)', () => {
    expect(statsAccess({}, LOCAL)).toBe(true);
    expect(statsAccess({}, { PLAY_STATS_KEY: '' })).toBe(true);
  });

  it('keeps a hosted run without a key closed, however it is recognised', () => {
    expect(statsAccess({}, VERCEL)).toBe(false);
    expect(statsAccess({ key: 'anything' }, VERCEL)).toBe(false);
    expect(statsAccess({}, { VERCEL: '1', PLAY_STATS_KEY: '' })).toBe(false);
    // Přepínač „Automatically expose System Environment Variables“ zháší `VERCEL`;
    // sdílené úložiště samo prozradí víc instancí (stejné pravidlo jako tajemství identity).
    expect(statsAccess({}, { KV_REST_API_URL: 'https://example.invalid', KV_REST_API_TOKEN: 'fake' })).toBe(false);
    expect(statsAccess({}, { WORLDSMITH_SPEND_STORE_URL: 'https://example.invalid', WORLDSMITH_SPEND_STORE_TOKEN: 'fake' })).toBe(false);
  });

  it('opens with the exact key, on Vercel and locally', () => {
    expect(statsAccess({ key: KEY }, { ...VERCEL, PLAY_STATS_KEY: KEY })).toBe(true);
    expect(statsAccess({ key: KEY }, { PLAY_STATS_KEY: KEY })).toBe(true);
  });

  it('refuses a wrong key of the same length, one char more or less, and no key', () => {
    const env = { ...VERCEL, PLAY_STATS_KEY: KEY };
    const sameLength = `${KEY.slice(0, -1)}2`;
    expect(sameLength).toHaveLength(KEY.length);
    expect(statsAccess({ key: sameLength }, env)).toBe(false);
    expect(statsAccess({ key: `${KEY}x` }, env)).toBe(false);
    expect(statsAccess({ key: KEY.slice(0, -1) }, env)).toBe(false);
    expect(statsAccess({}, env)).toBe(false);
    expect(statsAccess({ key: '' }, env)).toBe(false);
    // Nastavený klíč platí i lokálně: kdo ho dal, chce stránku zavřenou.
    expect(statsAccess({}, { PLAY_STATS_KEY: KEY })).toBe(false);
  });

  it('refuses a repeated ?key= even when one copy is right', () => {
    expect(statsAccess({ key: [KEY, KEY] }, { ...VERCEL, PLAY_STATS_KEY: KEY })).toBe(false);
  });

  it('treats a key shorter than the minimum as misconfigured and stays closed', () => {
    const short = KEY.slice(0, STATS_KEY_MIN_CHARS - 1);
    expect(STATS_KEY_MIN_CHARS).toBe(24);
    expect(statsAccess({ key: short }, { ...VERCEL, PLAY_STATS_KEY: short })).toBe(false);
    expect(statsAccess({ key: short }, { PLAY_STATS_KEY: short })).toBe(false);
    const exact = KEY.slice(0, STATS_KEY_MIN_CHARS);
    expect(statsAccess({ key: exact }, { ...VERCEL, PLAY_STATS_KEY: exact })).toBe(true);
  });

  it('compares in constant time over equal-length digests', () => {
    const env = { ...VERCEL, PLAY_STATS_KEY: KEY };
    expect(statsAccess({ key: `${KEY}-longer-than-the-real-one` }, env)).toBe(false);
    expect(statsAccess({ key: KEY }, env)).toBe(true);
    const calls = vi.mocked(crypto.timingSafeEqual).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [left, right] of calls) {
      expect((left as Buffer).length).toBe(32);
      expect((right as Buffer).length).toBe(32);
    }
  });
});
