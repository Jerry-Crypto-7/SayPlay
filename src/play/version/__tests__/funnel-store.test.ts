/**
 * Trychtýř v úložišti (P44B T12): stupeň se na relaci a hru počítá nejvýš jednou za den, nová hra
 * jednou (`say` / `remix`, ne vestavěná ani autorská verze od AI), `funnel(days)` vrátí denní čísla
 * a výpadek úložiště počítání nezdrží. Dvojí počítání by konverzi nafouklo a čísla by vypadala skvěle –
 * proto nad pamětí, souborem i Upstash přes falešný REST, kde se počítají i příkazy na jednu hru.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FUNNEL_MAX_DAYS, type FunnelStage } from '@/play/funnel';

import builtinGames from '../builtin-games.json';
import { DEFAULT_WRITE_LIMITS, fileVersionStore, httpVersionStore, memoryVersionStore, type VersionStore, VersionStoreUnavailable } from '../store';
import type { PublishedGame } from '../version';
import { fakeUpstash } from './fake-upstash';

const T0 = Date.parse('2026-10-08T10:00:00Z');
const DAY_MS = 24 * 3600 * 1000;
const GAME = 'a'.repeat(32);

const games = builtinGames as unknown as PublishedGame[];
const builtin = games[0]!;
const said: PublishedGame = { ...builtin, version: { ...builtin.version, versionId: 'b'.repeat(32), parentId: null } };
const remixed: PublishedGame = { ...builtin, version: { ...builtin.version, versionId: 'c'.repeat(32), parentId: said.version.versionId } };
const upgraded: PublishedGame = { ...remixed, version: { ...remixed.version, versionId: 'd'.repeat(32) }, relation: 'upgrade' };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stores(clock: () => number, requests?: { url: string; body: unknown }[]): [string, VersionStore][] {
  const dir = mkdtempSync(join(tmpdir(), 'play-funnel-'));
  dirs.push(dir);
  return [
    ['memory', memoryVersionStore(DEFAULT_WRITE_LIMITS, clock)],
    ['file', fileVersionStore(dir, DEFAULT_WRITE_LIMITS, clock)],
    [
      'upstash',
      httpVersionStore(
        { url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS, now: clock },
        fakeUpstash(new Map(), new Map(), new Map(), requests === undefined ? {} : { requests }),
      ),
    ],
  ];
}

const today = async (store: VersionStore): Promise<Record<FunnelStage, number>> => (await store.funnel(1))[0]!.counts;

describe('countFunnel / funnel (P44B T12)', () => {
  it('dvě stejné události jedné relace → 1; jiná relace nebo jiná hra → další', async () => {
    for (const [label, store] of stores(() => T0)) {
      await store.countFunnel('play', GAME, 'session-a');
      await store.countFunnel('play', GAME, 'session-a');
      expect((await today(store)).play, label).toBe(1);
      await store.countFunnel('play', GAME, 'session-b');
      await store.countFunnel('play', 'e'.repeat(32), 'session-a');
      await store.countFunnel('finish', GAME, 'session-a');
      expect(await today(store), label).toEqual({ say: 0, play: 3, finish: 1, share: 0, open: 0, beat: 0, remix: 0 });
    }
  });

  it('nový den počítá znovu; funnel(days) vrátí dny od nejstaršího a strop 30 dní', async () => {
    let now = T0;
    for (const [label, store] of stores(() => now)) {
      now = T0;
      await store.countFunnel('share', GAME, 'session-a');
      now = T0 + DAY_MS;
      await store.countFunnel('share', GAME, 'session-a');
      await store.countFunnel('share', GAME, 'session-b');
      const days = await store.funnel(3);
      expect(days.map(({ day, counts }) => [day, counts.share]), label).toEqual([
        ['2026-10-07', 0],
        ['2026-10-08', 1],
        ['2026-10-09', 2],
      ]);
      expect(await store.funnel(365), label).toHaveLength(FUNNEL_MAX_DAYS);
      expect(await store.funnel(0), label).toEqual([]);
    }
  });

  it('put počítá novou hru jednou: say bez rodiče, remix s rodičem; vestavěná ani upgrade ne', async () => {
    for (const [label, store] of stores(() => T0)) {
      expect(await store.put(builtin), label).toBe('stored');
      expect(await store.put(said), label).toBe('stored');
      expect(await store.put(said), label).toBe('exists');
      expect(await store.put(remixed), label).toBe('stored');
      expect(await store.put(upgraded), label).toBe('stored');
      expect(await today(store), label).toEqual({ say: 1, play: 0, finish: 0, share: 0, open: 0, beat: 0, remix: 1 });
    }
  });

  it('výpadek: počítání spolkne, čtení je VersionStoreUnavailable', async () => {
    const down = httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS, now: () => T0 }, () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    await expect(down.countFunnel('play', GAME, 'session-a')).resolves.toBeUndefined();
    await expect(down.funnel(7)).rejects.toBeInstanceOf(VersionStoreUnavailable);
  });

  it('jedna dohraná hra od věty po porážku výzvy stojí v Upstash nejvýš 12 příkazů navíc', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const [, , [, store]] = stores(() => T0, requests) as [unknown, unknown, [string, VersionStore]];
    const loop = ['play', 'finish', 'share', 'open', 'beat'] as const;
    // První zvýšení dne nastaví i expiraci (jednou za den a stupeň, ne za hru) – měří se další hra.
    for (const stage of loop) await store.countFunnel(stage, 'e'.repeat(32), 'session-z');
    requests.splice(0);
    for (const stage of loop) await store.countFunnel(stage, GAME, 'session-a');
    // Nová hra: jeden INCR za `say` (zbytek zápisu hry je stávající cena publikace).
    expect(requests.length + 1).toBeLessThanOrEqual(12);
    // Opakovaná událost téže relace stojí jen SET NX.
    requests.splice(0);
    await store.countFunnel('play', GAME, 'session-a');
    expect(requests).toHaveLength(1);
  });
});
