/**
 * Neměnné verze hry (P23-C T2): `sealVersion` a `VersionStore`.
 *
 * Obě implementace portu jedou týmž testem – paměť přímo, REST přes falešný
 * `fetch`, který drží `Map` a ctí `NX`. Semantika „zapiš jednou“ je to, na čem
 * stojí remix: kdo publikuje podruhé totéž, dostane `exists`; kdo pod týmž id
 * pošle něco jiného, dostane `conflict` a nic se nepřepíše.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CompiledGame, GameVersion, QualityReport } from '../contracts';
import { GAME_COMPILER_VERSION } from '../contracts';
import { readGameSpec } from '../spec';
import type { WorldstreamBlueprint } from '@/worldstream/schema';
import { RUNTIME_VERSION } from '@/sim/interpreter';

import {
  __resetProcessVersionStore,
  DEFAULT_WRITE_LIMITS,
  httpVersionStore,
  memoryVersionStore,
  RECENT_CAP,
  sealVersion,
  versionStoreFromEnv,
  VersionStoreUnavailable,
  volatileVersionStore,
  writeLimitsFromEnv,
  type PublishedGame,
  type VersionStore,
} from '../version';

const fixturePath = fileURLToPath(new URL('../__fixtures__/collect_exit.json', import.meta.url));

function compiled(seed: number): CompiledGame {
  const read = readGameSpec(JSON.parse(readFileSync(fixturePath, 'utf8')));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return {
    spec: read.value,
    specHash: `spec-${String(seed)}`,
    seed,
    compilerVersion: GAME_COMPILER_VERSION,
    // Úložiště blueprint nikdy nečte – stačí prázdný objekt pod správným typem.
    blueprint: {} as WorldstreamBlueprint,
    worldHash: `world-${String(seed)}`,
    mechanics: [],
    roles: [],
    winsAtTick: 12,
  };
}

function report(game: CompiledGame, replayEqual = true): QualityReport {
  return {
    specHash: game.specHash,
    worldHash: game.worldHash,
    keypoints: [],
    witness: { certified: true, winsAtTick: game.winsAtTick },
    replayEqual,
    budgets: { entities: 3, rules: 4, triangles: null },
    publishEligible: true,
  };
}

function publish(seed: number, parentId: string | null, replayEqual = true): PublishedGame {
  const game = compiled(seed);
  return { version: sealVersion(game, parentId, () => 1_700_000_000_000), spec: game.spec, blueprint: game.blueprint, report: report(game, replayEqual) };
}

/** Falešný Upstash: SET (NX, EX), GET, MGET, INCR, EXPIRE, LPUSH, LTRIM, LRANGE. Expirace se zapisují do `ttl`, aby šly ověřit. */
function fakeUpstash(kv: Map<string, string>, ttl: Map<string, number> = new Map(), lists: Map<string, string[]> = new Map()): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const getMatch = /\/get\/(.+)$/.exec(url);
    if (getMatch !== null) return Response.json({ result: kv.get(decodeURIComponent(getMatch[1])) ?? null });
    const parts = JSON.parse(String(init?.body)) as string[];
    const [command, key] = parts;
    if (command === 'MGET') return Response.json({ result: parts.slice(1).map((k) => kv.get(k) ?? null) });
    if (command === 'LPUSH') {
      lists.set(key, [parts[2], ...(lists.get(key) ?? [])]);
      return Response.json({ result: lists.get(key)?.length });
    }
    if (command === 'LTRIM') {
      lists.set(key, (lists.get(key) ?? []).slice(Number(parts[2]), Number(parts[3]) + 1));
      return Response.json({ result: 'OK' });
    }
    if (command === 'LRANGE') return Response.json({ result: (lists.get(key) ?? []).slice(Number(parts[2]), Number(parts[3]) + 1) });
    if (command === 'INCR') {
      const next = Number(kv.get(key) ?? '0') + 1;
      kv.set(key, String(next));
      return Response.json({ result: next });
    }
    if (command === 'EXPIRE') {
      ttl.set(key, Number(parts[2]));
      return Response.json({ result: 1 });
    }
    if (command !== 'SET') throw new Error(`fake store does not know ${command}`);
    const value = parts[2];
    const flags = parts.slice(3);
    if (flags.includes('NX') && kv.has(key)) return Response.json({ result: null });
    kv.set(key, value);
    const ex = flags.indexOf('EX');
    if (ex !== -1) ttl.set(key, Number(flags[ex + 1]));
    return Response.json({ result: 'OK' });
  };
}

const PREFIX = 'test:spend';

describe('sealVersion', () => {
  it('hashes everything the game stands on and copies title and time', () => {
    const game = compiled(7);
    const version = sealVersion(game, null, () => 0);
    expect(version.title).toBe(game.spec.title);
    expect(version.createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(version.runtimeVersion).toBe(RUNTIME_VERSION);
    expect(version.compilerVersion).toBe(GAME_COMPILER_VERSION);
    expect(version.schemaVersion).toBe('gamespec.v1');
    // Táž hra pod jiným rodičem je jiná verze; jiný čas ji nemění.
    expect(sealVersion(game, null, () => 99).versionId).toBe(version.versionId);
    expect(sealVersion(game, 'parent', () => 0).versionId).not.toBe(version.versionId);
    expect(sealVersion(compiled(8), null, () => 0).versionId).not.toBe(version.versionId);
  });

  it('derives a 128-bit id that also covers the spec itself', () => {
    const game = compiled(7);
    const version = sealVersion(game, null, () => 0);
    expect(version.versionId).toMatch(/^[a-f0-9]{32}$/);
    // Stejná pole verze (specHash, worldHash, seed…), jiný spec → jiné id: 32-bitový specHash sám nestačí.
    const retitled: CompiledGame = { ...game, spec: { ...game.spec, title: `${game.spec.title} II` } };
    expect(sealVersion(retitled, null, () => 0).versionId).not.toBe(version.versionId);
  });
});

describe.each<{ name: string; make: () => { store: VersionStore; kv: Map<string, string> } }>([
  { name: 'memory', make: () => ({ store: memoryVersionStore(), kv: new Map() }) },
  {
    name: 'http',
    make: () => {
      const kv = new Map<string, string>();
      return { store: httpVersionStore({ url: 'https://x', token: 't', prefix: PREFIX, timeoutMs: 500 }, fakeUpstash(kv)), kv };
    },
  },
])('VersionStore $name', ({ name, make }) => {
  it('stores once, answers exists for the same bytes and conflict without overwriting', async () => {
    const { store } = make();
    expect(store.id).toBe(name);
    const root = publish(1, null);
    expect(await store.put(root)).toBe('stored');
    expect(await store.put(publish(1, null))).toBe('exists');

    const forged = publish(1, null, false);
    expect(forged.version.versionId).toBe(root.version.versionId);
    expect(await store.put(forged)).toBe('conflict');
    const kept = await store.get(root.version.versionId);
    expect(kept?.report.replayEqual).toBe(true);
    expect(kept).toEqual(root);
  });

  it('treats the same game sealed a moment later as exists, keeping the first record', async () => {
    const { store } = make();
    const root = publish(1, null);
    expect(await store.put(root)).toBe('stored');
    const later: PublishedGame = { ...root, version: { ...root.version, createdAt: '2026-09-20T12:00:00.000Z' } };
    expect(later.version.versionId).toBe(root.version.versionId);
    expect(await store.put(later)).toBe('exists');
    expect((await store.get(root.version.versionId))?.version.createdAt).toBe(root.version.createdAt);
  });

  it('appends children only on stored', async () => {
    const { store } = make();
    const root = publish(1, null);
    await store.put(root);
    expect(await store.childrenOf(root.version.versionId)).toEqual([]);

    const child = publish(2, root.version.versionId);
    expect(await store.put(child)).toBe('stored');
    expect(await store.childrenOf(root.version.versionId)).toEqual([child.version.versionId]);

    expect(await store.put(child)).toBe('exists');
    expect(await store.put(publish(2, root.version.versionId, false))).toBe('conflict');
    expect(await store.childrenOf(root.version.versionId)).toEqual([child.version.versionId]);
  });

  it('walks lineage root-first', async () => {
    const { store } = make();
    const a = publish(1, null);
    const b = publish(2, a.version.versionId);
    const c = publish(3, b.version.versionId);
    for (const game of [a, b, c]) await store.put(game);
    const lineage = await store.lineageOf(c.version.versionId);
    expect(lineage.map((v) => v.versionId)).toEqual([a.version.versionId, b.version.versionId, c.version.versionId]);
    expect(await store.lineageOf(a.version.versionId)).toHaveLength(1);
  });

  it('caps a long lineage at the 32 newest entries and never walks parents on read', async () => {
    const { store } = make();
    let parentId: string | null = null;
    const ids: string[] = [];
    for (let i = 1; i <= 40; i += 1) {
      const game = publish(i, parentId);
      await store.put(game);
      parentId = game.version.versionId;
      ids.push(parentId);
    }
    // Čtení rodokmenu je jeden záznam, ne chůze po rodičích – `get` portu se nevolá.
    const reads = vi.spyOn(store, 'get');
    const lineage = await store.lineageOf(ids[39]);
    expect(lineage).toHaveLength(32);
    expect(lineage.map((v) => v.versionId)).toEqual(ids.slice(8));
    expect(reads).not.toHaveBeenCalled();
  });

  it('a forged parent pointing at a descendant cannot make a cycle', async () => {
    const { store } = make();
    const base = publish(1, null);
    const forge = (versionId: string, parentId: string): PublishedGame => ({ ...base, version: { ...base.version, versionId, parentId } });
    await store.put(forge('x', 'y'));
    await store.put(forge('y', 'x'));
    expect((await store.lineageOf('x')).map((v) => v.versionId)).toEqual(['x']);
    expect((await store.lineageOf('y')).map((v) => v.versionId)).toEqual(['x', 'y']);
  });

  it('answers null for an unknown version', async () => {
    const { store } = make();
    expect(await store.get('nope')).toBeNull();
    expect(await store.childrenOf('nope')).toEqual([]);
    expect(await store.lineageOf('nope')).toEqual([]);
    expect(await store.recent(24)).toEqual([]);
    expect(await store.childCounts([])).toEqual([]);
  });

  it('feeds only stored, publish-eligible authored versions, newest first, with child counts', async () => {
    const { store } = make();
    const authored = (seed: number, parentId: string | null, eligible = true): PublishedGame => {
      const game = publish(seed, parentId);
      // Feed vypršelé hry schová – čas musí být dnešní, ne ten z `publish`.
      const createdAt = new Date(Date.now() + seed).toISOString();
      return { ...game, relation: 'upgrade', version: { ...game.version, createdAt }, report: { ...game.report, publishEligible: eligible } };
    };
    // Návrh, remix a ruční spec píše volající – do feedu nesmí.
    const draft = publish(1, null);
    const remix = publish(2, draft.version.versionId);
    const first = authored(3, draft.version.versionId);
    const ineligible = authored(4, draft.version.versionId, false);
    const second = authored(5, draft.version.versionId);
    for (const game of [draft, remix, first, ineligible, second]) expect(await store.put(game)).toBe('stored');
    // `exists` a `conflict` feed nepřidají.
    expect(await store.put(first)).toBe('exists');
    expect(await store.put({ ...first, report: { ...first.report, replayEqual: false } })).toBe('conflict');

    const recent = await store.recent(24);
    expect(recent.map((row) => row.versionId)).toEqual([second.version.versionId, first.version.versionId]);
    expect(recent[0]).toMatchObject({ archetype: draft.spec.archetype, relation: 'upgrade', parentId: draft.version.versionId, title: draft.version.title });
    expect(await store.recent(1)).toHaveLength(1);
    expect(await store.childCounts([draft.version.versionId, first.version.versionId, 'nope'])).toEqual([4, 0, 0]);
  });

  it(`remembers at most ${String(RECENT_CAP)} games in the feed`, async () => {
    const { store } = make();
    const base: PublishedGame = { ...publish(1, null), relation: 'upgrade' };
    const createdAt = new Date().toISOString();
    for (let i = 0; i < RECENT_CAP + 5; i++) await store.put({ ...base, version: { ...base.version, versionId: `id${String(i)}`, createdAt } });
    const recent = await store.recent(RECENT_CAP + 5);
    expect(recent).toHaveLength(RECENT_CAP);
    expect(recent[0].versionId).toBe(`id${String(RECENT_CAP + 4)}`);
  });
});

describe('feed expiry', () => {
  it('drops feed rows whose game has already expired', async () => {
    let clock = Date.parse('2026-09-01T00:00:00.000Z');
    const store = memoryVersionStore({ ttlSeconds: 3600, dailyCap: 100 }, () => clock);
    const base: PublishedGame = { ...publish(1, null), relation: 'upgrade' };
    const at = (versionId: string, createdAt: number): PublishedGame => ({ ...base, version: { ...base.version, versionId, createdAt: new Date(createdAt).toISOString() } });
    await store.put(at('old', clock));
    clock += 1800 * 1000;
    await store.put(at('fresh', clock));
    expect((await store.recent(24)).map((row) => row.versionId)).toEqual(['fresh', 'old']);
    clock += 1801 * 1000;
    expect((await store.recent(24)).map((row) => row.versionId)).toEqual(['fresh']);
  });
});

describe('VersionStore http', () => {
  // `recent()` čte nejvýš RECENT_CAP řádků, takže zkrácení seznamu v úložišti přes něj vidět není – měří se seznam sám.
  it(`trims the stored feed list to ${String(RECENT_CAP)} entries`, async () => {
    const lists = new Map<string, string[]>();
    const store = httpVersionStore({ url: 'https://x', token: 't', prefix: PREFIX, timeoutMs: 500 }, fakeUpstash(new Map(), new Map(), lists));
    const base: PublishedGame = { ...publish(1, null), relation: 'upgrade' };
    const createdAt = new Date().toISOString();
    for (let i = 0; i < RECENT_CAP + 5; i++) await store.put({ ...base, version: { ...base.version, versionId: `id${String(i)}`, createdAt } });
    expect(lists.get(`${PREFIX}:play:recent`)).toHaveLength(RECENT_CAP);
  });

  it('treats corrupted JSON as an unknown version', async () => {
    const kv = new Map<string, string>([[`${PREFIX}:play:v:bad`, '{not json']]);
    const store = httpVersionStore({ url: 'https://x', token: 't', prefix: PREFIX, timeoutMs: 500 }, fakeUpstash(kv));
    expect(await store.get('bad')).toBeNull();
  });

  it('reads as unknown and refuses to put when the store is unreachable', async () => {
    const down: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const store = httpVersionStore({ url: 'https://x', token: 't', prefix: PREFIX, timeoutMs: 500 }, down);
    expect(await store.get('any')).toBeNull();
    await expect(store.put(publish(1, null))).rejects.toBeInstanceOf(VersionStoreUnavailable);

    const denied: typeof fetch = () => Promise.resolve(new Response('nope', { status: 503 }));
    const refused = httpVersionStore({ url: 'https://x', token: 't', prefix: PREFIX, timeoutMs: 500 }, denied);
    expect(await refused.get('any')).toBeNull();
    await expect(refused.put(publish(1, null))).rejects.toBeInstanceOf(VersionStoreUnavailable);
  });

  it('a write that dies after SET NX refuses the put, but the game reads and is its own lineage root', async () => {
    const kv = new Map<string, string>();
    const upstash = fakeUpstash(kv);
    let sets = 0;
    // Druhý SET je zápis rodokmenu – první (NX) hru už uložil.
    const flaky: typeof fetch = (input, init) => {
      const parts = init?.body === undefined ? [] : (JSON.parse(String(init.body)) as string[]);
      if (parts[0] === 'SET' && ++sets === 2) return Promise.reject(new Error('ECONNRESET'));
      return upstash(input, init);
    };
    const store = httpVersionStore({ url: 'https://x', token: 't', prefix: PREFIX, timeoutMs: 500 }, flaky);
    const game = publish(1, null);
    await expect(store.put(game)).rejects.toBeInstanceOf(VersionStoreUnavailable);
    expect(await store.get(game.version.versionId)).not.toBeNull();
    expect((await store.lineageOf(game.version.versionId)).map((version) => version.versionId)).toEqual([game.version.versionId]);
  });

  it('sends the bearer token and the prefixed key', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const kv = new Map<string, string>();
    const spy: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return fakeUpstash(kv)(input, init);
    };
    const store = httpVersionStore({ url: 'https://x', token: 'secret', prefix: PREFIX, timeoutMs: 500 }, spy);
    const root = publish(1, null);
    await store.put(root);
    expect(kv.has(`${PREFIX}:play:v:${root.version.versionId}`)).toBe(true);
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
    // První příkaz je denní počítadlo, druhý zápis hry s NX a expirací.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(['INCR', expect.stringMatching(new RegExp(`^${PREFIX}:play:quota:\\d{4}-\\d{2}-\\d{2}$`))]);
    const setCall = calls.find((call) => String(call.init?.body).startsWith('["SET"'));
    expect(JSON.parse(String(setCall?.init?.body))).toEqual([
      'SET',
      `${PREFIX}:play:v:${root.version.versionId}`,
      expect.any(String),
      'NX',
      'EX',
      String(DEFAULT_WRITE_LIMITS.ttlSeconds),
    ]);
  });

  it('expires every play key and stops writing above the daily cap', async () => {
    const kv = new Map<string, string>();
    const ttl = new Map<string, number>();
    let day = Date.UTC(2026, 8, 20, 10);
    const limits = { ttlSeconds: 3600, dailyCap: 2 };
    const store = httpVersionStore({ url: 'https://x', token: 't', prefix: PREFIX, timeoutMs: 500, limits, now: () => day }, fakeUpstash(kv, ttl));
    const root = publish(1, null);
    expect(await store.put(root)).toBe('stored');
    expect(await store.put(publish(2, root.version.versionId))).toBe('stored');
    expect(ttl.get(`${PREFIX}:play:v:${root.version.versionId}`)).toBe(3600);
    expect(ttl.get(`${PREFIX}:play:lineage:${root.version.versionId}`)).toBe(3600);
    expect(ttl.get(`${PREFIX}:play:children:${root.version.versionId}`)).toBe(3600);
    expect(ttl.get(`${PREFIX}:play:quota:2026-09-20`)).toBe(2 * 24 * 3600);

    // Třetí publikace dne: strop – nic se nezapíše, ani opakovaná stejná hra neprojde jako exists.
    const third = publish(3, null);
    expect(await store.put(third)).toBe('quota');
    expect(kv.has(`${PREFIX}:play:v:${third.version.versionId}`)).toBe(false);
    expect(await store.put(root)).toBe('quota');

    // Další den počítadlo začíná znovu.
    day += 24 * 3600 * 1000;
    expect(await store.put(third)).toBe('stored');
  });

  it('memory store honours the same daily cap', async () => {
    const store = memoryVersionStore({ ttlSeconds: 60, dailyCap: 1 }, () => 0);
    expect(await store.put(publish(1, null))).toBe('stored');
    expect(await store.put(publish(2, null))).toBe('quota');
    expect(await store.get(publish(2, null).version.versionId)).toBeNull();
  });
});

describe('writeLimitsFromEnv', () => {
  it('reads positive integers and falls back to the defaults on anything else', () => {
    expect(writeLimitsFromEnv({})).toEqual(DEFAULT_WRITE_LIMITS);
    expect(writeLimitsFromEnv({ PLAY_VERSION_TTL_SECONDS: '86400', PLAY_PUBLISH_DAILY_CAP: '20' })).toEqual({ ttlSeconds: 86400, dailyCap: 20, dareDailyCap: 2000 });
    expect(writeLimitsFromEnv({ PLAY_VERSION_TTL_SECONDS: '0', PLAY_PUBLISH_DAILY_CAP: 'unlimited' })).toEqual(DEFAULT_WRITE_LIMITS);
    expect(writeLimitsFromEnv({ PLAY_PUBLISH_DAILY_CAP: '-5' }).dailyCap).toBe(DEFAULT_WRITE_LIMITS.dailyCap);
  });
});

describe('versionStoreFromEnv', () => {
  afterEach(() => __resetProcessVersionStore());

  it('falls back to one memory store per process', () => {
    const first = versionStoreFromEnv({});
    expect(first.id).toBe('memory');
    expect(versionStoreFromEnv({})).toBe(first);
  });

  it('uses the shared store when the environment names one', () => {
    expect(versionStoreFromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }, fakeUpstash(new Map())).id).toBe('http');
  });

  it('keeps a game published on 24 Sep past the results on 25 Nov', () => {
    const published = Date.UTC(2026, 8, 24);
    const results = Date.UTC(2026, 10, 25);
    expect(published + DEFAULT_WRITE_LIMITS.ttlSeconds * 1000).toBeGreaterThan(results + 30 * 24 * 3600 * 1000);
    expect(writeLimitsFromEnv({ PLAY_VERSION_TTL_SECONDS: '86400' }).ttlSeconds).toBe(86400);
  });

  it('flags a production process that holds games only in memory, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(volatileVersionStore({ NODE_ENV: 'production' })).toBe(true);
      expect(volatileVersionStore({ NODE_ENV: 'development' })).toBe(false);
      expect(volatileVersionStore({ NODE_ENV: 'production', KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' })).toBe(false);
      versionStoreFromEnv({ NODE_ENV: 'production' });
      versionStoreFromEnv({ NODE_ENV: 'production' });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
