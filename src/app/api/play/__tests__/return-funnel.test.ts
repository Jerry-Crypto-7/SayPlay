/**
 * Návrat hráče v trychtýři (P63 T5): návštěvník se počítá jednou za den, první den je „nový“, návrat až
 * v pozdější den, a z nových toho dne D1 a D7. Nikdo se na tato čísla nedívá, dokud je nechce investor –
 * dvojí počet nebo návrat už první den by vypadaly jako skvělá retence. Proto nad pamětí i Upstash přes falešný REST.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FunnelDay, retention } from '@/play/funnel';
import { readLoopEvent } from '@/play/loop-events';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { DEFAULT_WRITE_LIMITS, httpVersionStore, memoryVersionStore, type VersionStore } from '@/play/version/store';
import { fakeUpstash } from '@/play/version/__tests__/fake-upstash';
import { resetRateWindows } from '@/server/rate-limit';

import { POST as sendEvent } from '../events/route';

const T0 = Date.parse('2026-10-08T10:00:00Z');
const DAY_MS = 24 * 3600 * 1000;
const ANNA = '6f1c2b9e-3d4a-4f8b-9c1d-2e3f4a5b6c7d';
const BOB = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CYRIL = 'f0e1d2c3-b4a5-4968-a7b6-c5d4e3f2a1b0';

function stores(clock: () => number): [string, VersionStore][] {
  return [
    ['memory', memoryVersionStore(DEFAULT_WRITE_LIMITS, clock)],
    ['upstash', httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS, now: clock }, fakeUpstash(new Map(), new Map(), new Map()))],
  ];
}

const visitorsOf = async (store: VersionStore, days: number) => (await store.funnel(days)).map((day) => day.visitors);

describe('countVisitor / funnel visitors', () => {
  it('a first day is new, never a return – however often the visitor comes back that day', async () => {
    for (const [label, store] of stores(() => T0)) {
      for (let n = 0; n < 3; n += 1) await store.countVisitor(ANNA);
      await store.countVisitor(BOB);
      expect(await visitorsOf(store, 1), label).toEqual([{ first: 2, return: 0, d1: 0, d7: 0 }]);
    }
  });

  it('a later day is one return per visitor, and feeds D1 and D7 of the first day only on day 1 and day 7', async () => {
    let now = T0;
    for (const [label, store] of stores(() => now)) {
      now = T0;
      await store.countVisitor(ANNA);
      await store.countVisitor(BOB);
      await store.countVisitor(CYRIL);
      now = T0 + DAY_MS;
      await store.countVisitor(ANNA);
      await store.countVisitor(ANNA);
      now = T0 + 3 * DAY_MS;
      await store.countVisitor(BOB);
      now = T0 + 7 * DAY_MS;
      await store.countVisitor(ANNA);
      await store.countVisitor(BOB);
      const days = await visitorsOf(store, 8);
      expect(days[0], label).toEqual({ first: 3, return: 0, d1: 1, d7: 2 });
      expect(days[1], label).toEqual({ first: 0, return: 1, d1: 0, d7: 0 });
      expect(days[3], label).toEqual({ first: 0, return: 1, d1: 0, d7: 0 });
      expect(days[7], label).toEqual({ first: 0, return: 2, d1: 0, d7: 0 });
    }
  });

  it('a store outage swallows the count', async () => {
    const down = httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS }, () => Promise.reject(new Error('down')));
    await expect(down.countVisitor(ANNA)).resolves.toBeUndefined();
  });
});

describe('retention', () => {
  const day = (index: number, first: number, d1: number, d7: number): FunnelDay => ({
    day: `2026-10-${String(index + 1).padStart(2, '0')}`,
    counts: { say: 0, play: 0, finish: 0, share: 0, open: 0, beat: 0, remix: 0 },
    visitors: { first, return: 0, d1, d7 },
  });

  it('counts only first days whose day 1 or day 7 is over', () => {
    // Deset dní, poslední je dnešek: D1 z dnů 0–7, D7 z dnů 0–1.
    const days = [day(0, 10, 4, 2), day(1, 10, 2, 1), ...Array.from({ length: 5 }, (_, n) => day(n + 2, 0, 0, 0)), day(7, 5, 1, 0), day(8, 20, 9, 0), day(9, 7, 0, 0)];
    expect(retention(days, 1)).toEqual({ hit: 7, of: 25 });
    expect(retention(days, 7)).toEqual({ hit: 3, of: 20 });
  });

  it('is null without a finished first day', () => {
    expect(retention([day(0, 10, 0, 0)], 1)).toBeNull();
    expect(retention([day(0, 0, 0, 0), day(1, 0, 0, 0), day(2, 3, 0, 0)], 1)).toBeNull();
  });
});

describe('POST /api/play/events with a visitor', () => {
  let dir = '';
  beforeEach(() => {
    resetRateWindows();
    dir = mkdtempSync(join(tmpdir(), 'play-return-'));
    vi.stubEnv('PLAY_EVENTS_DIR', dir);
    __resetProcessVersionStore();
  });
  afterEach(() => {
    __resetProcessVersionStore();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown) => sendEvent(new Request('http://play.test/api/play/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.63' }, body: JSON.stringify(body) }));
  const event = { name: 'impression', versionId: 'a1b2c3d4e5f60718', session: 'k3j2h1g0f9e8d7c6' };

  it('counts the visitor the event carries, and an event without one counts nobody', async () => {
    expect((await post({ ...event, visitor: ANNA })).status).toBe(204);
    expect((await post({ ...event, name: 'first_input', visitor: ANNA })).status).toBe(204);
    expect((await post(event)).status).toBe(204);
    expect((await versionStoreFromEnv(process.env).funnel(1))[0]?.visitors).toEqual({ first: 1, return: 0, d1: 0, d7: 0 });
    // Záznam událostí id návštěvníka nenese (na Vercelu je to řádek logu vedle adresy volajícího).
    const log = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8')).join('');
    expect(log).toContain('"impression"');
    expect(log).not.toContain(ANNA);
  });

  it.each([
    ['free text', 'john.doe@example.com'],
    ['a session id', 'k3j2h1g0f9e8d7c6'],
    ['an upper-case UUID', ANNA.toUpperCase()],
    ['a number', 42],
  ])('refuses a visitor that is %s', async (_why, visitor) => {
    expect(readLoopEvent({ ...event, visitor })).toBeNull();
    expect((await post({ ...event, visitor })).status).toBe(400);
  });

  it('keeps share extras next to a visitor', () => {
    expect(readLoopEvent({ ...event, name: 'share', withClip: true, visitor: BOB })).toEqual({ ...event, name: 'share', withClip: true, visitor: BOB });
  });
});
