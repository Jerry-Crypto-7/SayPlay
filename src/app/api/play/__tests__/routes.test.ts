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

import chaseEscape from '@/play/__fixtures__/chase_escape.json';
import collectExit from '@/play/__fixtures__/collect_exit.json';
import hazardCrossing from '@/play/__fixtures__/hazard_crossing.json';
import switchPuzzle from '@/play/__fixtures__/switch_puzzle.json';
import { GAME_COMPILER_VERSION } from '@/play/contracts';
import { STARTERS } from '@/components/play/starters';
import { draftGameSpec } from '@/play/draft';
import { __resetProcessVersionStore, VersionStoreUnavailable, versionStoreFromEnv } from '@/play/version';
import { MAX_BODY_BYTES } from '@/http/body';
import { resetRateWindows } from '@/server/rate-limit';

import { GET as listGames, POST as createGame } from '../games/route';
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
  // Okno stropu je 10 s wall-clocku; pod zátěží paralelních workerů by se smyčka 51 požadavků
  // uměla přehoupnout přes jeho hranici a čítač by se vynuloval. Čas proto stojí.
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WORLDSMITH_CONTROL_FILE;
  delete process.env.VERCEL;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('publikace → čtení → remix → rodokmen', () => {
  it('201 s odkazem, GET 200 s celou hrou, remix 201 s rodičem, rodokmen na obou stranách', async () => {
    const created = await publish('Collect five glowing mushrooms in a moonlit forest');
    expect(created.status).toBe(201);
    // Titulek píše návrh ze slov („Collect Five Glowing Mushrooms"), ne opis věty.
    expect(created.body).toMatchObject({ parentId: null, archetype: 'collect_exit', title: 'Collect Five Glowing Mushrooms' });
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

  it('(2) věta o 10 kB → 413; tělo nad 64 kB → 413 BODY_TOO_LARGE dřív, než se celé načte', async () => {
    const response = await createGame(post('/api/play/games', { sentence: 'a'.repeat(10_000) }));
    expect(response.status).toBe(413);

    // Tělo přichází po kusech a přeteče strop dřív, než skončí – dveře ho odmítají
    // přes sdílený čtecí kus (`src/http/body.ts`), ne až po `request.text()`.
    // Nezavřený proud a deadline pinuje `src/http/__tests__/body.test.ts`.
    const chunk = new TextEncoder().encode(`{"sentence":"${'a'.repeat(4_095)}`);
    const chunks = Math.ceil(MAX_BODY_BYTES / chunk.byteLength) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunks; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const big = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: CALLER, body: stream, duplex: 'half' } as RequestInit));
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe('BODY_TOO_LARGE');
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

  it('denní strop publikací → 429 PUBLISH_QUOTA s retry-after, nic se neuložilo', async () => {
    process.env.PLAY_PUBLISH_DAILY_CAP = '1';
    __resetProcessVersionStore();
    try {
      const first = await publish('Collect the coins');
      expect(first.status).toBe(201);
      const second = await createGame(post('/api/play/games', { sentence: 'Escape the chasing wolves' }));
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBe('3600');
      expect((await second.json()).error.code).toBe('PUBLISH_QUOTA');
      // Strop platí i pro remix – jde touž cestou zápisu.
      const remix = await remixGame(post(`/api/play/games/${first.body.versionId}/remix`, { chip: 'harder' }), params(first.body.versionId));
      expect(remix.status).toBe(429);
      expect((await read(first.body.versionId)).body.children).toEqual([]);
    } finally {
      delete process.env.PLAY_PUBLISH_DAILY_CAP;
    }
  });

  it('(7b) na platformě rozhoduje důvěryhodný konec, ne x-forwarded-for od volajícího', async () => {
    process.env.VERCEL = '1';
    let last: Response | null = null;
    for (let i = 0; i < 51; i += 1)
      last = await createGame(
        post('/api/play/games', { sentence: 'Collect the coins' }, { 'x-forwarded-for': `10.0.${String(i)}.1`, 'x-vercel-forwarded-for': '203.0.113.9' }),
      );
    expect(last!.status).toBe(429);
  });

  it('(2b) čtení má bránu: vypínač all → 503, 51. GET → 429', async () => {
    const created = await publish('Collect the coins');
    resetRateWindows();
    for (let i = 0; i < 50; i += 1) await readGame(new Request('http://play.test/x', { headers: CALLER }), params(created.body.versionId));
    const limited = await readGame(new Request('http://play.test/x', { headers: CALLER }), params(created.body.versionId));
    expect(limited.status).toBe(429);

    const dir = mkdtempSync(join(tmpdir(), 'play-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off: ['all'] }));
    process.env.WORLDSMITH_CONTROL_FILE = file;
    resetRateWindows();
    expect((await read(created.body.versionId)).status).toBe(503);
  });

  it('(4b) hluboko vnořený spec je 422, ne pád; semínko je součást verze i rozvržení', async () => {
    // Tělo se skládá textem: `JSON.stringify` by na téže hloubce spadl dřív než dveře.
    const response = await createGame(post('/api/play/games', `{"spec":${'['.repeat(20_000)}${']'.repeat(20_000)}}`));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('SPEC_REJECTED');

    const one = await createGame(post('/api/play/games', { spec: collectExit, seed: 1 }));
    const two = await createGame(post('/api/play/games', { spec: collectExit, seed: 2 }));
    const [a, b] = [await (await read((await one.json()).versionId)).body, await (await read((await two.json()).versionId)).body];
    expect(a.version.versionId).not.toBe(b.version.versionId);
    expect(a.version.worldHash).not.toBe(b.version.worldHash);
  });

  it('chip mimo seznam a remix bez těla → 400', async () => {
    const created = await publish('Collect the coins');
    for (const body of [{ chip: 'easier' }, {}, { chip: 'harder', spec: collectExit }]) {
      const response = await remixGame(post(`/api/play/games/${created.body.versionId}/remix`, body), params(created.body.versionId));
      expect(response.status).toBe(400);
    }
  });
});

describe('chybové cesty ze ship-review (P23-D R5)', () => {
  function switchOff(...off: string[]): void {
    const dir = mkdtempSync(join(tmpdir(), 'play-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off }));
    process.env.WORLDSMITH_CONTROL_FILE = file;
  }

  it('semínko: 0, 1.5, "7", 2^31 a −1 → 400 na obou dveřích; 2^31 − 1 → 201', async () => {
    // Strop je `sessionSeed` blueprintu; 2^31 dřív prošlo dveřmi a spadlo až jako WORLD_REJECTED.
    const created = await publish('Collect the coins');
    for (const seed of [0, 1.5, '7', 2 ** 31, -1]) {
      const game = await createGame(post('/api/play/games', { spec: collectExit, seed }));
      expect(game.status, `games ${String(seed)}`).toBe(400);
      const remix = await remixGame(post(`/api/play/games/${created.body.versionId}/remix`, { chip: 'harder', seed }), params(created.body.versionId));
      expect(remix.status, `remix ${String(seed)}`).toBe(400);
    }
    const top = await createGame(post('/api/play/games', { spec: collectExit, seed: 2 ** 31 - 1 }));
    expect(top.status).toBe(201);
  });

  it('parentId na POST /games: známý rodič → 201 s rodokmenem na obou stranách; `../etc` → 404', async () => {
    const parent = await publish('Collect the coins');
    const response = await createGame(post('/api/play/games', { spec: collectExit, seed: 3, parentId: parent.body.versionId }));
    expect(response.status).toBe(201);
    const child = await response.json();
    expect(child.parentId).toBe(parent.body.versionId);
    expect((await read(parent.body.versionId)).body.children).toEqual([child.versionId]);
    expect((await read(child.versionId)).body.lineage.map((v: { versionId: string }) => v.versionId)).toEqual([parent.body.versionId, child.versionId]);

    const hostile = await createGame(post('/api/play/games', { spec: collectExit, parentId: '../etc' }));
    expect(hostile.status).toBe(404);
  });

  it('páka sessions vypne zápis (POST i remix 503), čtení hotové hry dál 200', async () => {
    // Opačný směr (čtení vypnuté, zápis běží) páky neumí: `snapshots` vypne jen `all`.
    const created = await publish('Collect the coins');
    switchOff('sessions');
    expect((await createGame(post('/api/play/games', { sentence: 'Escape the chasing wolves' }))).status).toBe(503);
    const remix = await remixGame(post(`/api/play/games/${created.body.versionId}/remix`, { chip: 'harder' }), params(created.body.versionId));
    expect(remix.status).toBe(503);
    expect((await read(created.body.versionId)).status).toBe(200);
  });

  it('prázdná věta i věta z mezer → 400, nic se neuložilo', async () => {
    const store = versionStoreFromEnv(process.env);
    const put = vi.spyOn(store, 'put');
    for (const sentence of ['', '   ']) {
      const response = await createGame(post('/api/play/games', { sentence }));
      expect(response.status, JSON.stringify(sentence)).toBe(400);
    }
    expect(put).not.toHaveBeenCalled();
  });
});

describe('feed GET /api/play/games?recent (P23-D T4)', () => {
  const feed = async (query: string): Promise<{ status: number; body: Record<string, any> }> => {
    const response = await listGames(new Request(`http://play.test/api/play/games${query}`, { headers: CALLER }));
    return { status: response.status, body: await response.json() };
  };

  it('prázdný feed je prázdné pole, ne vymyšlené hry', async () => {
    expect(await feed('?recent=24')).toEqual({ status: 200, body: { games: [] } });
  });

  /** Autorská verze návrhu, jak by ji zapsal upgrade na pozadí – bez modelu v testu. */
  async function authoredOf(draftId: string, versionId: string): Promise<string> {
    const versions = versionStoreFromEnv(process.env);
    const draft = await versions.get(draftId);
    if (draft === null) throw new Error('draft missing');
    const createdAt = new Date(Date.now()).toISOString();
    expect(await versions.put({ ...draft, relation: 'upgrade', version: { ...draft.version, versionId, parentId: draftId, createdAt } })).toBe('stored');
    return versionId;
  }

  it('návrh, remix ani ruční spec do feedu nejdou; autorské verze od nejnovější s počtem remixů', async () => {
    const first = await publish('Collect five glowing mushrooms in a moonlit forest');
    const second = await publish(STARTERS[1].sentence);
    const remix = await remixGame(post(`/api/play/games/${first.body.versionId}/remix`, { chip: 'harder' }), params(first.body.versionId));
    expect(remix.status).toBe(201);
    expect((await createGame(post('/api/play/games', { spec: switchPuzzle }))).status).toBeLessThan(300);
    expect((await feed('?recent=24')).body.games).toEqual([]);

    vi.setSystemTime(1_700_000_001_000);
    const a = await authoredOf(first.body.versionId, 'a'.repeat(32));
    vi.setSystemTime(1_700_000_002_000);
    const b = await authoredOf(second.body.versionId, 'b'.repeat(32));
    // Remix autorské verze se počítá na její kartě; do feedu sám nejde.
    expect((await remixGame(post(`/api/play/games/${a}/remix`, { chip: 'harder' }), params(a))).status).toBe(201);

    const { status, body } = await feed('?recent=24');
    expect(status).toBe(200);
    expect(body.games.map((g: { versionId: string }) => g.versionId)).toEqual([b, a]);
    expect(body.games[1]).toEqual({
      versionId: a,
      title: first.body.title,
      archetype: 'collect_exit',
      createdAt: new Date(1_700_000_001_000).toISOString(),
      parentId: first.body.versionId,
      remixes: 1,
    });
    expect(body.games[0].remixes).toBe(0);
    expect((await feed('?recent=1')).body.games).toHaveLength(1);
  });

  it('recent mimo 1–48, s nulou na začátku, chybějící nebo s parametrem navíc → 400', async () => {
    for (const query of ['', '?recent=0', '?recent=49', '?recent=abc', '?recent=2.5', '?recent=-1', '?recent=024', '?recent=24&x=1', '?recent=24&recent=24']) {
      expect((await feed(query)).status, query).toBe(400);
    }
  });

  it('páka feed vypne jen feed, odkaz na hru dál čte; sessions feed nechá; all vypne obojí', async () => {
    const created = await publish('Collect the coins');
    const dir = mkdtempSync(join(tmpdir(), 'play-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    process.env.WORLDSMITH_CONTROL_FILE = file;
    writeFileSync(file, JSON.stringify({ off: ['sessions'] }));
    expect((await feed('?recent=24')).status).toBe(200);
    writeFileSync(file, JSON.stringify({ off: ['feed'] }));
    expect((await feed('?recent=24')).status).toBe(503);
    expect((await read(created.body.versionId)).status).toBe(200);
    writeFileSync(file, JSON.stringify({ off: ['all'] }));
    expect((await feed('?recent=24')).status).toBe(503);
  });
});

/**
 * Závod přes pět bran za dvě sekundy: na semínku 1 ho nevyhraje žádný svědek, na
 * semínku 2 ano (naměřeno 22. 9. 2026). Věta o dortu (semínko 13) přestala stačit,
 * když se hlídka od `play-compiler-v3` vyhýbá startu – semínka 1–400 jsou vyhratelná.
 */
const SHORT_RACE = 'Race through five neon gates in 2 seconds.';
const UNWINNABLE_RACE_SEED = 1;

describe('skutečný kompilátor, verifikátor a režisér (P23-D T1)', () => {
  it('osm startovních vět → osm různých archetypů; každá 201 a GET nese ověřené keypointy', async () => {
    const archetypes = new Set<string>();
    for (const starter of STARTERS) {
      const created = await publish(starter.sentence);
      expect(created.status, starter.sentence).toBe(201);
      expect(created.body.archetype, starter.sentence).toBe(starter.archetype);
      archetypes.add(created.body.archetype);
      const game = await read(created.body.versionId);
      expect(game.body.version.compilerVersion).toBe(GAME_COMPILER_VERSION);
      expect(game.body.report.keypoints.length, starter.sentence).toBeGreaterThan(0);
      expect(game.body.report.publishEligible, starter.sentence).toBe(true);
      expect('stub' in game.body.report).toBe(false);
    }
    expect(archetypes.size).toBe(8);
  });

  it('spec, jehož keypoint neprojde, je 422 NOT_PUBLISHABLE s ids a nic se neuložilo', async () => {
    const spec = structuredClone(switchPuzzle) as { mechanics: { id: string; params: Record<string, unknown> }[] };
    spec.mechanics.find((mechanic) => mechanic.id === 'switch')!.params.required = ['red', 'blue', 'green'];
    const store = versionStoreFromEnv(process.env);
    const put = vi.spyOn(store, 'put');
    const response = await createGame(post('/api/play/games', { spec }));
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error.code).toBe('NOT_PUBLISHABLE');
    expect(json.error.keypoints).toContain('green_blocks');
    expect(put).not.toHaveBeenCalled();
  });

  it('semínko zvolené volajícím se nemění: nevyhratelné rozvržení je 422 UNWINNABLE, bez semínka se hra najde', async () => {
    const spec = draftGameSpec(SHORT_RACE);
    const pinned = await createGame(post('/api/play/games', { spec, seed: UNWINNABLE_RACE_SEED }));
    expect(pinned.status).toBe(422);
    expect((await pinned.json()).error.code).toBe('UNWINNABLE');
    expect((await publish(SHORT_RACE)).status).toBe(201);
  });

  // Tři mutanty, které přežily ověření T1 (21. 9. 2026): semínko volajícího se
  // na větné a remixové cestě dalo tiše vyměnit za odvozená, a čip bez účinku
  // šel smazat.
  it('věta se semínkem volajícího: nevyhratelné rozvržení je 422 UNWINNABLE, ne jiné semínko', async () => {
    const pinned = await createGame(
      post('/api/play/games', { sentence: SHORT_RACE, seed: UNWINNABLE_RACE_SEED }),
    );
    expect(pinned.status).toBe(422);
    expect((await pinned.json()).error.code).toBe('UNWINNABLE');
  });

  it('remix se semínkem volajícího: nevyhratelné rozvržení je 422 UNWINNABLE, ne jiné semínko', async () => {
    const created = await publish('Collect five glowing mushrooms then open a portal.');
    const spec = draftGameSpec(SHORT_RACE);
    const remixed = await remixGame(
      post(`/api/play/games/${created.body.versionId}/remix`, { spec, seed: UNWINNABLE_RACE_SEED }),
      params(created.body.versionId),
    );
    expect(remixed.status).toBe(422);
    expect((await remixed.json()).error.code).toBe('UNWINNABLE');
  });

  it('čip, který na hře nemá co změnit, je 422 a rodič nevyjde pod novým id', async () => {
    // Twist přidá mechaniku jen do čtyř; hra se čtyřmi ho už nepustí.
    // Honička: u lávy od `play-compiler-v3` twist neprojde kontrolami na žádném
    // semínku 1–8, u honičky na všech (naměřeno 22. 9. 2026).
    const created = await createGame(post('/api/play/games', { spec: chaseEscape }));
    expect(created.status).toBe(201);
    const parentId = (await created.json()).versionId as string;
    const twisted = await remixGame(post(`/api/play/games/${parentId}/remix`, { chip: 'twist', seed: 3 }), params(parentId));
    expect(twisted.status).toBe(201);
    const childId = (await twisted.json()).versionId as string;
    expect((await read(childId)).body.spec.mechanics).toHaveLength(4);
    const again = await remixGame(post(`/api/play/games/${childId}/remix`, { chip: 'twist' }), params(childId));
    expect(again.status).toBe(422);
    expect((await again.json()).error.message).toContain('does not apply');
  });

  it('twist nikdy nevydá hru, která neprojde svými kontrolami', async () => {
    const created = await createGame(post('/api/play/games', { spec: hazardCrossing }));
    const parentId = (await created.json()).versionId as string;
    for (let seed = 1; seed <= 8; seed += 1) {
      const twisted = await remixGame(post(`/api/play/games/${parentId}/remix`, { chip: 'twist', seed }), params(parentId));
      const code = twisted.status === 201 ? 'created' : (await twisted.json()).error.code;
      expect(['created', 'SPEC_REJECTED'], `seed ${seed}`).toContain(code);
    }
  });

  it('čip harder jde přes remixPatch režiséra a dítě je publikovatelné', async () => {
    const created = await publish('Collect five glowing mushrooms then open a portal.');
    const remixed = await remixGame(post(`/api/play/games/${created.body.versionId}/remix`, { chip: 'harder' }), params(created.body.versionId));
    expect(remixed.status).toBe(201);
    const child = await read((await remixed.json()).versionId);
    expect(child.body.report.publishEligible).toBe(true);
  });
});
