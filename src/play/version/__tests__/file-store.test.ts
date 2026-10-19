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
import { __resetProcessVersionStore, DEFAULT_WRITE_LIMITS, fileStoreDirFromEnv, fileVersionStore, RECENT_CAP, versionStoreFromEnv } from '../store';
import type { PublishedGame } from '../version';

/** Disk, který přejmenování odmítne – antivir drží soubor (Windows EPERM) nebo je plný. */
const disk = vi.hoisted(() => ({ broken: false, busyRenames: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (disk.busyRenames > 0) {
        disk.busyRenames -= 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      if (disk.broken) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      fs.renameSync(...args);
    },
  };
});

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
  disk.broken = false;
  disk.busyRenames = 0;
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
    await first.countLoop(parent.version.versionId, ['retry', 'share', 'bounce'], 'voter-a');

    const restarted = fileVersionStore(dir);
    expect((await restarted.get(parent.version.versionId))?.spec).toEqual(parent.spec);
    expect((await restarted.get(child.version.versionId))?.version.parentId).toBe(parent.version.versionId);
    expect(await restarted.childrenOf(parent.version.versionId)).toEqual([child.version.versionId]);
    expect((await restarted.lineageOf(child.version.versionId)).map((version) => version.versionId)).toEqual([parent.version.versionId, child.version.versionId]);
    // Remix s rodičem má řádek feedu taky (P54A T10).
    expect((await restarted.recent(RECENT_CAP)).map((row) => row.versionId).sort()).toEqual([parent.version.versionId, child.version.versionId].sort());
    expect((await restarted.loopHeat([parent.version.versionId])).get(parent.version.versionId)).toMatchObject({ finishes: 2, starts: 1, retries: 1, shares: 1, bounces: 1, remixes: 1 });
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

  it('hra, kterou disk nepřijal, není ani v paměti: další put ji zapíše znovu a přežije restart', async () => {
    const dir = freshDir();
    const store = fileVersionStore(dir);
    disk.broken = true;
    await expect(store.put(parent)).rejects.toThrow();
    expect(await store.get(parent.version.versionId)).toBeNull();
    disk.broken = false;
    // Ne `exists` nad kopií jen v paměti: odkaz by po restartu hlásil „Game not found“.
    expect(await store.put(parent)).toBe('stored');
    expect(await fileVersionStore(dir).get(parent.version.versionId)).not.toBeNull();
  });

  it('chvilkově držený soubor (Windows EPERM pod antivirem) zápis neshodí: přejmenování se zopakuje', async () => {
    const dir = freshDir();
    const store = fileVersionStore(dir);
    disk.busyRenames = 2;
    expect(await store.put(parent)).toBe('stored');
    expect(disk.busyRenames).toBe(0);
    expect(await fileVersionStore(dir).get(parent.version.versionId)).not.toBeNull();
  });

  it('čítač, který disk nepřijal, se nezvýší ani v paměti', async () => {
    const dir = freshDir();
    const store = fileVersionStore(dir);
    disk.broken = true;
    await expect(store.takeDirectorCall('caller', 1)).rejects.toThrow();
    disk.broken = false;
    // První započtené volání je pořád první – selhaný zápis ho neukousl.
    expect(await store.takeDirectorCall('caller', 1)).toBe(true);
    expect(await fileVersionStore(dir).takeDirectorCall('caller', 1)).toBe(false);
  });

  it('denní čítače vyprší i na disku: po dvou dnech se při startu nenačtou a jejich soubory zmizí', async () => {
    const dir = freshDir();
    let clock = Date.parse('2026-10-05T10:00:00Z');
    const now = (): number => clock;
    const store = fileVersionStore(dir, undefined, now);
    expect(await store.takeDirectorCall('caller', 1)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
    // Hra návštěvníka (ne vestavěná) ubere z denní kvóty publikací.
    const visitorGame: PublishedGame = { ...parent, version: { ...parent.version, versionId: 'f'.repeat(32) } };
    expect(await store.put(visitorGame)).toBe('stored');
    const files = readdirSync(dir).length;

    clock += 3 * 24 * 3600 * 1000;
    const restarted = fileVersionStore(dir, undefined, now);
    // Zmizely právě dva soubory – čítač režiséra a kvóta; hra žije půl roku.
    expect(readdirSync(dir)).toHaveLength(files - 2);
    expect(await restarted.get(visitorGame.version.versionId)).not.toBeNull();
  });

  it('čítač pod TTL se dál sčítá a expirace se dalším zvýšením neposune', async () => {
    const dir = freshDir();
    // Klíč čítače nese den (UTC): obě zvýšení musí padnout do téhož dne.
    let clock = Date.parse('2026-10-05T00:00:01Z');
    const now = (): number => clock;
    const store = fileVersionStore(dir, undefined, now);
    expect(await store.takeDirectorCall('caller', 2)).toBe(true);
    clock = Date.parse('2026-10-05T23:59:00Z');
    expect(await store.takeDirectorCall('caller', 2)).toBe(true);
    expect(await store.takeDirectorCall('caller', 2)).toBe(false);
    // 2 dny od PRVNÍHO zvýšení: od posledního by čítač žil ještě do půlnoci.
    clock = Date.parse('2026-10-07T12:00:00Z');
    expect(readdirSync(dir)).toHaveLength(1);
    fileVersionStore(dir, undefined, now);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('dvě instance nad týmž adresářem si nepřepíšou feed, děti ani kvótu a vidí hry té druhé', async () => {
    const dir = freshDir();
    const limits = { ...DEFAULT_WRITE_LIMITS, dailyCap: 2 };
    // Druhý server nebo pod `next dev` druhá route – obě načtou adresář dřív, než ta první zapíše.
    const a = fileVersionStore(dir, limits);
    const b = fileVersionStore(dir, limits);
    const visitor = (mark: string): PublishedGame => ({ ...parent, version: { ...parent.version, versionId: mark.repeat(32) } });
    const kid = (game: PublishedGame): PublishedGame => ({ ...game, version: { ...game.version, parentId: parent.version.versionId } });
    // `feature` = uložit a zařadit do feedu (sám `put` řadí jen verzi od režiséra).
    expect(await a.feature(visitor('a'))).toBe('stored');
    expect(await b.feature(visitor('b'))).toBe('stored');
    expect(await a.put(parent)).toBe('stored');
    expect(await a.put(kid(games[1]!))).toBe('stored');
    expect(await b.put(kid(games[2]!))).toBe('stored');
    expect(await b.get('a'.repeat(32))).not.toBeNull();

    const later = fileVersionStore(dir, limits);
    expect((await later.recent(RECENT_CAP)).map((row) => row.versionId)).toEqual(expect.arrayContaining(['a'.repeat(32), 'b'.repeat(32)]));
    expect([...(await later.childrenOf(parent.version.versionId))].sort()).toEqual([games[1]!.version.versionId, games[2]!.version.versionId].sort());
    // Obě publikace návštěvníků v kvótě: strop 2 je vyčerpaný.
    expect(await later.canPublish()).toBe(false);
  });

  it('soubor, který nejde přečíst, nechá klíč z paměti – feed se zápisem nesmaže', async () => {
    const dir = freshDir();
    const store = fileVersionStore(dir);
    await store.feature(parent);
    for (const name of readdirSync(dir)) writeFileSync(join(dir, name), '{ not json');
    expect((await store.recent(RECENT_CAP)).map((row) => row.versionId)).toEqual([parent.version.versionId]);
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
