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
  httpVersionStore,
  memoryVersionStore,
  sealVersion,
  versionStoreFromEnv,
  VersionStoreUnavailable,
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

/** Falešný Upstash: `GET /get/<key>` a `POST /` s `['SET', key, value, 'NX'?]`. */
function fakeUpstash(kv: Map<string, string>): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const getMatch = /\/get\/(.+)$/.exec(url);
    if (getMatch !== null) return Response.json({ result: kv.get(decodeURIComponent(getMatch[1])) ?? null });
    const [command, key, value, flag] = JSON.parse(String(init?.body)) as string[];
    if (command !== 'SET') throw new Error(`fake store does not know ${command}`);
    if (flag === 'NX' && kv.has(key)) return Response.json({ result: null });
    kv.set(key, value);
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

  it('stops a cyclic lineage at 32 entries', async () => {
    const { store } = make();
    const base = publish(1, null);
    const forge = (versionId: string, parentId: string): PublishedGame => ({ ...base, version: { ...base.version, versionId, parentId } });
    await store.put(forge('x', 'y'));
    await store.put(forge('y', 'x'));
    // Chůze po rodičích jde přes `get` portu; víc než 40 čtení znamená, že strop nedržel.
    const inner = store.get.bind(store);
    const reads = vi.spyOn(store, 'get').mockImplementation((id) => {
      if (reads.mock.calls.length > 40) throw new Error('lineage walk did not stop');
      return inner(id);
    });
    await expect(store.lineageOf('x')).resolves.toHaveLength(32);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(32);
  });

  it('answers null for an unknown version', async () => {
    const { store } = make();
    expect(await store.get('nope')).toBeNull();
    expect(await store.childrenOf('nope')).toEqual([]);
    expect(await store.lineageOf('nope')).toEqual([]);
  });
});

describe('VersionStore http', () => {
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
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(['SET', `${PREFIX}:play:v:${root.version.versionId}`, expect.any(String), 'NX']);
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
});
