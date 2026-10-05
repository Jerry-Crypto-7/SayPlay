/**
 * Souborové úložiště (P40 T3): bez Upstash přežijí hry, remixy i čítače
 * smyčky restart serveru. Dřív žily jen v paměti procesu a po restartu odkaz
 * hlásil „Game not found“, což vypadá jako vada hry, ne úložiště.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { markVolatileStore } from '@/app/api/play/_publish';

import builtinGames from '../builtin-games.json';
import { __resetProcessVersionStore, fileStoreDirFromEnv, fileVersionStore, RECENT_CAP, versionStoreFromEnv } from '../store';
import type { PublishedGame } from '../version';

const games = builtinGames as unknown as PublishedGame[];
const parent = games[0]!;
/** Dítě rodiče: jiná vestavěná hra s `parentId` – tvar jako remix. */
const child: PublishedGame = { ...games[1]!, version: { ...games[1]!.version, parentId: parent.version.versionId } };

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'play-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetProcessVersionStore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fileVersionStore', () => {
  it('hra, remix s rodičem, řádek feedu a čítače se po novém vytvoření nad týmž adresářem přečtou zpět', async () => {
    const dir = freshDir();
    const first = fileVersionStore(dir);
    expect(await first.put(parent)).toBe('stored');
    expect(await first.put(child)).toBe('stored');
    expect(await first.feature(parent)).toBe('exists');
    await first.countLoop(parent.version.versionId, ['finish', 'start'], 'voter-a');
    await first.countLoop(parent.version.versionId, ['finish'], 'voter-b');

    const restarted = fileVersionStore(dir);
    expect((await restarted.get(parent.version.versionId))?.spec).toEqual(parent.spec);
    expect((await restarted.get(child.version.versionId))?.version.parentId).toBe(parent.version.versionId);
    expect(await restarted.childrenOf(parent.version.versionId)).toEqual([child.version.versionId]);
    expect((await restarted.lineageOf(child.version.versionId)).map((version) => version.versionId)).toEqual([parent.version.versionId, child.version.versionId]);
    expect((await restarted.recent(RECENT_CAP)).map((row) => row.versionId)).toEqual([parent.version.versionId]);
    expect((await restarted.loopHeat([parent.version.versionId])).get(parent.version.versionId)).toMatchObject({ finishes: 2, starts: 1, remixes: 1 });
  });

  it('hlas na hráče za 24 h platí i po restartu: týž hráč čítač znovu nezvýší', async () => {
    const dir = freshDir();
    const first = fileVersionStore(dir);
    await first.put(parent);
    await first.countLoop(parent.version.versionId, ['finish'], 'voter-a');
    const restarted = fileVersionStore(dir);
    __resetProcessVersionStore();
    await restarted.countLoop(parent.version.versionId, ['finish'], 'voter-a');
    expect((await restarted.loopHeat([parent.version.versionId])).get(parent.version.versionId)?.finishes).toBe(1);
  });

  it('poškozený soubor → prázdné úložiště a varování, ne pád', async () => {
    const dir = freshDir();
    const first = fileVersionStore(dir);
    await first.put(parent);
    for (const name of readdirSync(dir)) writeFileSync(join(dir, name), '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restarted = fileVersionStore(dir);
    expect(await restarted.get(parent.version.versionId)).toBeNull();
    expect(await restarted.recent(RECENT_CAP)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    // Úložiště dál zapisuje: po poškození se dá znovu publikovat.
    expect(await restarted.put(parent)).toBe('stored');
    expect(await fileVersionStore(dir).get(parent.version.versionId)).not.toBeNull();
  });

  it('soubor se špatnou položkou schodiště se přeskočí, ostatní hry zůstanou', async () => {
    const dir = freshDir();
    await fileVersionStore(dir).put(parent);
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ key: 'k', set: [null] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await fileVersionStore(dir).get(parent.version.versionId)).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('zápis nenechá v adresáři dočasné soubory', async () => {
    const dir = freshDir();
    await fileVersionStore(dir).put(parent);
    expect(readdirSync(dir).filter((name) => !name.endsWith('.json'))).toEqual([]);
  });
});

describe('volba úložiště podle prostředí', () => {
  it('bez Upstash s PLAY_STORE_DIR: hra přežije nové vytvoření úložiště procesu', async () => {
    const dir = freshDir();
    const env = { PLAY_STORE_DIR: dir, VITEST: 'true' };
    await versionStoreFromEnv(env).put(parent);
    __resetProcessVersionStore();
    expect(await versionStoreFromEnv(env).get(parent.version.versionId)).not.toBeNull();
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });

  it('s Upstash proměnnými dál HTTP úložiště, nic na disk', async () => {
    const dir = freshDir();
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return Response.json({ result: null });
    }) as unknown as typeof fetch;
    const store = versionStoreFromEnv({ PLAY_STORE_DIR: dir, KV_REST_API_URL: 'https://kv.invalid', KV_REST_API_TOKEN: 'token' }, fetchImpl);
    await store.get('a'.repeat(32));
    expect(calls.length).toBeGreaterThan(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('adresář: PLAY_STORE_DIR, jinak data/play/store; na Vercelu a pod vitestem bez PLAY_STORE_DIR žádný', () => {
    expect(fileStoreDirFromEnv({ PLAY_STORE_DIR: '/x/store' })).toBe('/x/store');
    expect(fileStoreDirFromEnv({})).toBe(join(process.cwd(), 'data', 'play', 'store'));
    expect(fileStoreDirFromEnv({ VERCEL: '1' })).toBeNull();
    expect(fileStoreDirFromEnv({ VERCEL: '1', PLAY_STORE_DIR: '/x/store' })).toBeNull();
    expect(fileStoreDirFromEnv({ VITEST: 'true' })).toBeNull();
  });

  it('produkce nad souborovým úložištěm není nestálá a dveře to řeknou hlavičkou x-play-store: file', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PLAY_STORE_DIR', freshDir());
    vi.stubEnv('KV_REST_API_URL', '');
    vi.stubEnv('WORLDSMITH_SPEND_STORE_URL', '');
    expect(markVolatileStore(new Response('{}')).headers.get('x-play-store')).toBe('file');
  });
});
