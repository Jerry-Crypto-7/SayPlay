/**
 * Veřejné dveře PLAY (P23-C T3): publikace, čtení a remix verzí – bez
 * přihlášení, bez modelu. Handlery se volají přímo s `Request`, úložiště je
 * paměťový singleton procesu (reset před každým testem).
 *
 * Osm polí Oracle z plánu drží tvar smlouvy: 400 bez těla, 413 nad limitem,
 * 422 na spec s neznámou mechanikou, 404 týž tvar pro neznámé i špatné id,
 * 404 na neznámého rodiče, 503 z vypínače **bez zápisu**, 429 na 51. požadavek
 * a remix, který rodiče nepřepíše a podruhé vrátí `exists`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import collectExit from '@/play/__fixtures__/collect_exit.json';
import { __resetProcessVersionStore, VersionStoreUnavailable, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { POST as createGame } from '../games/route';
import { GET as readGame } from '../games/[id]/route';
import { POST as remixGame } from '../games/[id]/remix/route';

const CALLER = { 'x-forwarded-for': '203.0.113.9' };

function post(path: string, body: unknown, headers: Record<string, string> = CALLER): Request {
  return new Request(`http://play.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function publish(sentence: string): Promise<{ status: number; body: Record<string, any> }> {
  const response = await createGame(post('/api/play/games', { sentence }));
  return { status: response.status, body: await response.json() };
}

async function read(id: string): Promise<{ status: number; body: Record<string, any>; response: Response }> {
  const response = await readGame(new Request(`http://play.test/api/play/games/${id}`), params(id));
  return { status: response.status, body: await response.json(), response };
}

const temporary: string[] = [];

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
});

afterEach(() => {
  delete process.env.WORLDSMITH_CONTROL_FILE;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('publikace → čtení → remix → rodokmen', () => {
  it('201 s odkazem, GET 200 s celou hrou, remix 201 s rodičem, rodokmen na obou stranách', async () => {
    const created = await publish('Collect five glowing mushrooms in a moonlit forest');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      parentId: null,
      archetype: 'collect_exit',
      title: 'Collect five glowing mushrooms in a moonlit forest',
    });
    expect(created.body.versionId).toMatch(/^[a-f0-9]{8,64}$/);
    expect(created.body.url).toBe(`/play/${created.body.versionId}`);

    const game = await read(created.body.versionId);
    expect(game.status).toBe(200);
    expect(game.response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    expect(game.body.version.versionId).toBe(created.body.versionId);
    expect(game.body.spec.schema).toBe('gamespec.v1');
    expect(game.body.blueprint.world.sim).toBeDefined();
    expect(game.body.report.publishEligible).toBe(true);
    expect(game.body.children).toEqual([]);
    expect(game.body.lineage.map((v: { versionId: string }) => v.versionId)).toEqual([created.body.versionId]);

    const remixed = await remixGame(
      post(`/api/play/games/${created.body.versionId}/remix`, { chip: 'harder' }),
      params(created.body.versionId),
    );
    expect(remixed.status).toBe(201);
    const child = await remixed.json();
    expect(child.parentId).toBe(created.body.versionId);
    expect(child.versionId).not.toBe(created.body.versionId);

    const parent = await read(created.body.versionId);
    expect(parent.body.children).toEqual([child.versionId]);
    const childRead = await read(child.versionId);
    expect(childRead.body.lineage.map((v: { versionId: string }) => v.versionId)).toEqual([
      created.body.versionId,
      child.versionId,
    ]);
    // Těžší = víc hub k sesbírání; spec dítěte je vlastní, ne rodičův.
    expect(childRead.body.spec.objective.count).toBe(parent.body.spec.objective.count + 2);
  });

  it('táž věta podruhé je 200 exists s týmž versionId', async () => {
    const first = await publish('Collect the coins');
    const second = await publish('Collect the coins');
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.versionId).toBe(first.body.versionId);
  });

  it('spec v těle jde rovnou do kompilace', async () => {
    const response = await createGame(post('/api/play/games', { spec: collectExit, seed: 7 }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.title).toBe(collectExit.title);
  });

  it('remix přes spec v těle', async () => {
    const created = await publish('Collect the coins');
    const spec = { ...collectExit, title: 'Six Mushrooms' };
    const response = await remixGame(
      post(`/api/play/games/${created.body.versionId}/remix`, { spec }),
      params(created.body.versionId),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).parentId).toBe(created.body.versionId);
  });
});

describe('Oracle', () => {
  it('(1) tělo bez sentence i spec → 400; obojí naráz → 400; nečitelný JSON → 400', async () => {
    for (const body of [{}, { sentence: 'x', spec: collectExit }, '{not json']) {
      const response = await createGame(post('/api/play/games', body));
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(Object.keys(json)).toEqual(['error']);
      expect(typeof json.error.code).toBe('string');
      expect(typeof json.error.message).toBe('string');
    }
  });

  it('(2) věta o 10 kB → 413', async () => {
    const response = await createGame(post('/api/play/games', { sentence: 'a'.repeat(10_000) }));
    expect(response.status).toBe(413);
  });

  it('(3) spec s projektilem → 422 SPEC_REJECTED', async () => {
    const spec = {
      ...collectExit,
      mechanics: [...collectExit.mechanics, { id: 'projectile', params: { role: 'player' } }],
    };
    const response = await createGame(post('/api/play/games', { spec }));
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error.code).toBe('SPEC_REJECTED');
    expect(JSON.stringify(json)).not.toMatch(/stack|node_modules|[A-Z]:\\/);
  });

  it('(4) neznámé id i `../etc` → 404 téhož tvaru', async () => {
    const unknown = await read('0123456789abcdef');
    const hostile = await read('../etc');
    expect(unknown.status).toBe(404);
    expect(hostile.status).toBe(404);
    expect(hostile.body).toEqual(unknown.body);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
  });

  it('(5) neznámý parentId → 404 UNKNOWN_PARENT, remix neznámého → 404', async () => {
    const response = await createGame(
      post('/api/play/games', { sentence: 'Collect the coins', parentId: '0123456789abcdef' }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('UNKNOWN_PARENT');

    const remix = await remixGame(
      post('/api/play/games/0123456789abcdef/remix', { chip: 'twist' }),
      params('0123456789abcdef'),
    );
    expect(remix.status).toBe(404);
  });

  it('(6) vypínač all → 503 DISABLED a nic se neuložilo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off: ['all'] }));
    process.env.WORLDSMITH_CONTROL_FILE = file;

    const store = versionStoreFromEnv(process.env);
    const put = vi.spyOn(store, 'put');
    const response = await createGame(post('/api/play/games', { sentence: 'Collect the coins' }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('DISABLED');
    expect(put).not.toHaveBeenCalled();

    const remix = await remixGame(post('/api/play/games/0123456789abcdef/remix', { chip: 'harder' }), params('0123456789abcdef'));
    expect(remix.status).toBe(503);
    expect(put).not.toHaveBeenCalled();
  });

  it('(7) 51. požadavek v okně → 429 s retry-after', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 51; i += 1) last = await createGame(post('/api/play/games', { sentence: 'Collect the coins' }));
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(Object.keys(await last!.json())).toEqual(['error']);
  });

  it('(8) remix nepřepíše rodiče a stejný remix podruhé dá 200 exists s týmž versionId', async () => {
    const created = await publish('Collect the coins');
    const before = JSON.stringify((await read(created.body.versionId)).body);

    const first = await remixGame(post(`/api/play/games/${created.body.versionId}/remix`, { chip: 'harder' }), params(created.body.versionId));
    const second = await remixGame(post(`/api/play/games/${created.body.versionId}/remix`, { chip: 'harder' }), params(created.body.versionId));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const [a, b] = [await first.json(), await second.json()];
    expect(b.versionId).toBe(a.versionId);

    const after = (await read(created.body.versionId)).body;
    // Rodič je bajtově týž až na seznam dětí, který mu remix přidal.
    expect(JSON.stringify({ ...after, children: [] })).toBe(before);
    expect(after.children).toEqual([a.versionId]);
  });

  it('úložiště hlásí conflict → 409, výpadek → 503; ani jednou 201', async () => {
    const store = versionStoreFromEnv(process.env);
    vi.spyOn(store, 'put').mockResolvedValueOnce('conflict');
    const conflict = await createGame(post('/api/play/games', { sentence: 'Collect the coins' }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('VERSION_CONFLICT');

    vi.spyOn(store, 'put').mockRejectedValueOnce(new VersionStoreUnavailable('down'));
    const down = await createGame(post('/api/play/games', { sentence: 'Collect the coins' }));
    expect(down.status).toBe(503);
    expect((await down.json()).error.code).toBe('STORE_UNAVAILABLE');
    expect((await read((await publish('Collect the coins')).body.versionId)).status).toBe(200);
  });

  it('chip mimo seznam a remix bez těla → 400', async () => {
    const created = await publish('Collect the coins');
    for (const body of [{ chip: 'easier' }, {}, { chip: 'harder', spec: collectExit }]) {
      const response = await remixGame(post(`/api/play/games/${created.body.versionId}/remix`, body), params(created.body.versionId));
      expect(response.status).toBe(400);
    }
  });
});
