/**
 * Žebříček hry (P44B T4): na hráče jen nejlepší ověřený běh podle `bestRank`, nejvýš
 * `BOARD_KEPT` hráčů, denní strop zápisů na hráče. Stejně nad pamětí, souborem
 * (i po restartu) a Upstash přes falešný REST. Horší běh, který přepíše lepší,
 * by vypadal jako platný žebříček – proto každé tvrzení jede nad všemi třemi.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BOARD_DAILY_CAP_PER_PLAYER,
  BOARD_KEPT,
  BOARD_READ_MAX,
  DEFAULT_WRITE_LIMITS,
  fileVersionStore,
  httpVersionStore,
  memoryVersionStore,
  type VersionStore,
  VersionStoreUnavailable,
} from '../store';
import { fakeUpstash } from './fake-upstash';

const GAME = 'game-board';
const T0 = Date.parse('2026-10-07T10:00:00Z');
const DAY_MS = 24 * 3600 * 1000;

/** Id hráče ve tvaru z cookie (22 znaků base64url). */
const player = (n: number): string => `p${String(n).padStart(21, '0')}`;
const dare = (n: number): string => n.toString(16).padStart(32, '0');

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'play-board-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stores(clock: () => number): [string, VersionStore][] {
  return [
    ['memory', memoryVersionStore(DEFAULT_WRITE_LIMITS, clock)],
    ['file', fileVersionStore(freshDir(), DEFAULT_WRITE_LIMITS, clock)],
    ['upstash', httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS, now: clock }, fakeUpstash(new Map(), new Map()))],
  ];
}

describe('putBoardEntry / board', () => {
  it('drží na hráče jen nejlepší běh: 100 → 80 → 120 skončí na 120 s během té stodvacítky', async () => {
    for (const [label, store] of stores(() => T0)) {
      const ada = player(1);
      expect(await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(1), score: 100, ticks: 900 }), label).toEqual({ raised: true, place: 1, of: 1 });
      expect(await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(2), score: 80, ticks: 500 }), label).toEqual({ raised: false, place: 1, of: 1 });
      expect(await store.board(GAME, 10), label).toEqual([{ playerId: ada, dareId: dare(1), score: 100, ticks: 900, place: 1 }]);
      expect(await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(3), score: 120, ticks: 1200 }), label).toEqual({ raised: true, place: 1, of: 1 });
      expect(await store.board(GAME, 10), label).toEqual([{ playerId: ada, dareId: dare(3), score: 120, ticks: 1200, place: 1 }]);
    }
  });

  it('při shodě skóre vyhrává kratší čas; stejně dobrý běh první zápis nepřepíše', async () => {
    for (const [label, store] of stores(() => T0)) {
      const ada = player(1);
      await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(1), score: 50, ticks: 800 });
      expect(await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(2), score: 50, ticks: 800 }), label).toEqual({ raised: false, place: 1, of: 1 });
      expect((await store.board(GAME, 1))[0]?.dareId, label).toBe(dare(1));
      expect(await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(3), score: 50, ticks: 700 }), label).toEqual({ raised: true, place: 1, of: 1 });
      expect(await store.board(GAME, 1), label).toEqual([{ playerId: ada, dareId: dare(3), score: 50, ticks: 700, place: 1 }]);
    }
  });

  it('řadí hráče sestupně s místy od 1 a čte nejvýš BOARD_READ_MAX řádků', async () => {
    for (const [label, store] of stores(() => T0)) {
      for (let n = 0; n < 25; n++) await store.putBoardEntry(GAME, { playerId: player(n), dareId: dare(n + 1), score: 10 + n, ticks: 100 });
      const rows = await store.board(GAME, 100);
      expect(rows, label).toHaveLength(BOARD_READ_MAX);
      expect(rows.map(({ place }) => place), label).toEqual(Array.from({ length: BOARD_READ_MAX }, (_, i) => i + 1));
      expect(rows.map(({ score }) => score), label).toEqual(Array.from({ length: BOARD_READ_MAX }, (_, i) => 34 - i));
      expect(rows[0], label).toEqual({ playerId: player(24), dareId: dare(25), score: 34, ticks: 100, place: 1 });
      expect(await store.board(GAME, 3), label).toHaveLength(3);
      expect(await store.board('game-nobody-played', 10), label).toEqual([]);
    }
  });

  it(`drží nejvýš ${String(BOARD_KEPT)} hráčů: slabší nováček se nevejde, silnější vytlačí nejslabšího`, async () => {
    for (const [label, store] of stores(() => T0)) {
      for (let n = 0; n < BOARD_KEPT; n++) await store.putBoardEntry(GAME, { playerId: player(n), dareId: dare(n + 1), score: 10 + n, ticks: 100 });
      expect(await store.putBoardEntry(GAME, { playerId: player(900), dareId: dare(900), score: 5, ticks: 100 }), label).toEqual({ raised: false, place: null, of: BOARD_KEPT });
      expect(await store.putBoardEntry(GAME, { playerId: player(901), dareId: dare(901), score: 500, ticks: 100 }), label).toEqual({ raised: true, place: 1, of: BOARD_KEPT });
      // Nejslabší (skóre 10) odešel: hráč se skóre 11 je teď poslední.
      expect(await store.putBoardEntry(GAME, { playerId: player(1), dareId: dare(2), score: 11, ticks: 100 }), label).toEqual({ raised: false, place: BOARD_KEPT, of: BOARD_KEPT });
      expect(await store.putBoardEntry(GAME, { playerId: player(0), dareId: dare(1), score: 10, ticks: 100 }), label).toEqual({ raised: false, place: null, of: BOARD_KEPT });
    }
  });

  it(`nad ${String(BOARD_DAILY_CAP_PER_PLAYER)} zápisů hráče za den vrátí quota a žebříček nechá; další den zase píše`, async () => {
    let now = T0;
    for (const [label, store] of stores(() => now)) {
      now = T0;
      const ada = player(1);
      for (let n = 1; n <= BOARD_DAILY_CAP_PER_PLAYER; n++) expect(await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(n), score: n, ticks: 100 }), label).not.toBe('quota');
      expect(await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(99), score: 999, ticks: 100 }), label).toBe('quota');
      expect((await store.board(GAME, 1))[0]?.score, label).toBe(BOARD_DAILY_CAP_PER_PLAYER);
      // Strop je na hráče: jiný hráč téhož dne píše.
      expect(await store.putBoardEntry(GAME, { playerId: player(2), dareId: dare(100), score: 1, ticks: 100 }), label).toEqual({ raised: true, place: 2, of: 2 });
      now = T0 + DAY_MS;
      expect(await store.putBoardEntry(GAME, { playerId: ada, dareId: dare(99), score: 999, ticks: 100 }), label).toEqual({ raised: true, place: 1, of: 2 });
    }
  });

  it('žebříček žije jako hra od posledního zápisu', async () => {
    let now = T0;
    const ttlMs = DEFAULT_WRITE_LIMITS.ttlSeconds * 1000;
    for (const [label, store] of stores(() => now).slice(0, 2)) {
      now = T0;
      await store.putBoardEntry(GAME, { playerId: player(1), dareId: dare(1), score: 10, ticks: 100 });
      now = T0 + ttlMs - 1;
      await store.putBoardEntry(GAME, { playerId: player(2), dareId: dare(2), score: 20, ticks: 100 });
      now = T0 + ttlMs + 1;
      expect(await store.board(GAME, 10), label).toHaveLength(2);
      now = T0 + 2 * ttlMs;
      expect(await store.board(GAME, 10), label).toEqual([]);
    }
    const ttl = new Map<string, number>();
    const upstash = httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS, now: () => T0 }, fakeUpstash(new Map(), ttl));
    await upstash.putBoardEntry(GAME, { playerId: player(1), dareId: dare(1), score: 10, ticks: 100 });
    expect(ttl.get(`test:play:board:${GAME}`)).toBe(DEFAULT_WRITE_LIMITS.ttlSeconds);
  });

  it('souborové úložiště žebříček po restartu přečte zpět', async () => {
    const dir = freshDir();
    const before = fileVersionStore(dir, DEFAULT_WRITE_LIMITS, () => T0);
    await before.putBoardEntry(GAME, { playerId: player(1), dareId: dare(1), score: 30, ticks: 300 });
    await before.putBoardEntry(GAME, { playerId: player(2), dareId: dare(2), score: 40, ticks: 300 });
    await before.putBoardEntry(GAME, { playerId: player(1), dareId: dare(3), score: 20, ticks: 300 });
    const after = fileVersionStore(dir, DEFAULT_WRITE_LIMITS, () => T0);
    expect(await after.board(GAME, 10)).toEqual([
      { playerId: player(2), dareId: dare(2), score: 40, ticks: 300, place: 1 },
      { playerId: player(1), dareId: dare(1), score: 30, ticks: 300, place: 2 },
    ]);
  });

  it('výpadek úložiště je VersionStoreUnavailable při zápisu i čtení, ne prázdný žebříček', async () => {
    const down: typeof fetch = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const store = httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS }, down);
    await expect(store.putBoardEntry(GAME, { playerId: player(1), dareId: dare(1), score: 10, ticks: 100 })).rejects.toBeInstanceOf(VersionStoreUnavailable);
    await expect(store.board(GAME, 10)).rejects.toBeInstanceOf(VersionStoreUnavailable);
  });
});
