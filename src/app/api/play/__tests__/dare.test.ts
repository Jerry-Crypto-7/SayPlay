/**
 * Dveře výzvy Dare (P36B T5): `POST /api/play/games/:id/dare` přehraje vstupy
 * běhu (i živé změny) na publikované hře a uloží výsledek, který spočítal
 * server. Skóre ani čas z těla se nečtou; cizí, prohraný, příliš dlouhý nebo
 * nevalidní záznam se odmítne, strop frekvence i denní strop výzev platí.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import switchPuzzle from '@/play/__fixtures__/switch_puzzle.json';
import { createArcadeSession } from '@/components/play/arcade/session';
import { STARTERS } from '@/components/play/starters';
import { ARCADE_LIMITS, type ArcadeWorld, type InputEvent } from '@/play/arcade/contract';
import { hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { replayLive } from '@/play/arcade/live';
import { runBot } from '@/play/arcade/verify';
import { packInputs, unpackInputs } from '@/play/score/dare';
import { scoredReplay } from '@/play/score/replay';
import {
  __resetProcessVersionStore,
  BEST_KEPT,
  bestRank,
  type DareRecord,
  type DareReplay,
  DEFAULT_WRITE_LIMITS,
  httpVersionStore,
  GHOST_DAILY_CAP_PER_CALLER,
  GHOST_TTL_SECONDS,
  MAX_GHOST_BYTES,
  memoryVersionStore,
  VersionStoreUnavailable,
  versionStoreFromEnv,
  writeLimitsFromEnv,
} from '@/play/version';
import { MAX_DARE_REQUESTS_PER_WINDOW, MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE, MAX_REQUESTS_PER_WINDOW, resetRateWindows } from '@/server/rate-limit';

import { POST as createGame } from '../games/route';
import { GET as readGame } from '../games/[id]/route';
import { POST as dare } from '../games/[id]/dare/route';
import { GET as readDareRoute } from '../games/[id]/dare/[dareId]/route';

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

let callers = 0;
/** Pokaždé jiná adresa: strop volajícího výzev je 1 za okno (T5r3) a soudí ho jen testy, které adresu dají samy. */
const freshCaller = (): Record<string, string> => ({ 'x-forwarded-for': `198.18.${String(Math.floor(callers / 256) % 256)}.${String(callers++ % 256)}` });

/** Každá výzva o `stepMs` později – klouzavá sekunda instance (T5r2) pustí 2 za sekundu a testy tu nesoudí ji. */
function send(id: string, body: unknown, headers: Record<string, string> = freshCaller(), stepMs = 500): Promise<Response> {
  vi.setSystemTime(Date.now() + stepMs);
  return dare(post(`/api/play/games/${id}/dare`, body, headers), params(id));
}

interface Game {
  readonly id: string;
  readonly world: ArcadeWorld | undefined;
}

async function publish(sentence: string): Promise<Game> {
  const created = await createGame(post('/api/play/games', { sentence }));
  const { versionId } = (await created.json()) as { versionId: string };
  const read = await readGame(new Request(`http://play.test/api/play/games/${versionId}`, { headers: CALLER }), params(versionId));
  const body = (await read.json()) as { arcade?: ArcadeWorld };
  return { id: versionId, world: body.arcade };
}

/** První startovní hra, jejíž svět splní `wanted` – testy nestojí na tom, která to je. */
async function arcadeGame(wanted: (world: ArcadeWorld) => boolean = () => true): Promise<{ id: string; world: ArcadeWorld }> {
  for (const { sentence } of STARTERS) {
    const game = await publish(sentence);
    if (game.world !== undefined && wanted(game.world)) return { id: game.id, world: game.world };
  }
  throw new Error('no starter game fits the test');
}

const hasLives = (world: ArcadeWorld): boolean => world.rules.some((rule) => rule.id === 'out_of_health');

const stored = (dareId: string) => versionStoreFromEnv(process.env).getDare(dareId);

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.PLAY_DARE_DAILY_CAP;
  delete process.env.VERCEL;
});

describe('POST /api/play/games/:id/dare (P36B T5)', () => {
  it('poctivý běh: skóre a čas z přehrání, ne z těla; týž běh podruhé je 200 s týmž dareId', async () => {
    const game = await arcadeGame();
    const bot = runBot(game.world).inputs;
    const expected = scoredReplay(game.world, bot, []);
    expect(expected.outcome).toBe('won');

    const first = await send(game.id, { inputs: packInputs(bot), score: 999_999, ticks: 1, hash: 'forged' });
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = (await first.json()) as { dareId: string; score: number; ticks: number };
    expect(body).toEqual({ dareId: expect.stringMatching(/^[a-f0-9]{32}$/), score: expected.score, ticks: expected.tick });
    expect(await stored(body.dareId)).toMatchObject({ versionId: game.id, score: expected.score, ticks: expected.tick, hash: expected.hash, liveChanges: 0 });

    // Týž běh podruhé – i se vstupem po konci a s živou změnou, která už nepadla – je táž výzva.
    const after = [...bot, { tick: ARCADE_LIMITS.maxTicks - 1, buttons: 1, axis: 0 }];
    const late = [{ tick: ARCADE_LIMITS.maxTicks - 1, patch: { kind: 'visual', weather: 'rain' } }];
    const again = await send(game.id, { inputs: packInputs(after), patches: late });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { dareId: string }).dareId).toBe(body.dareId);
    // Feed (P36B T9, revize T9-1): výzvu započte server sám u nové ověřené výzvy, opakování ne.
    expect((await versionStoreFromEnv(process.env).loopHeat([game.id])).get(game.id)).toMatchObject({ dares: 1 });
  });

  // T5r1: id z výsledku přehrání, ne z poslaných bajtů – jinak no-op vstup nebo prohozené změny
  // v témž tiku dají tentýž běh pod novým id a každá kopie ubere denní strop.
  it('týž vítězný běh s no-op vstupem a s prohozenými změnami v témž tiku je táž výzva a strop neubírá', async () => {
    process.env.PLAY_DARE_DAILY_CAP = '1';
    const game = await arcadeGame(hasLives);
    const bot = runBot(game.world).inputs;
    const used = new Set(bot.map((event) => event.tick));
    let idle = 0;
    while (used.has(idle)) idle += 1;
    const noop = [...bot, { tick: idle, buttons: 0, axis: 0 }].sort((a, b) => a.tick - b.tick);
    const both = [
      { tick: 30, patch: { kind: 'count', counter: 'health', amount: 2 } },
      { tick: 30, patch: { kind: 'visual', weather: 'rain' } },
    ] as const;
    // Předpoklad: obě varianty jsou opravdu týž běh.
    const run = scoredReplay(game.world, bot, [...both] as never);
    expect(run.outcome).toBe('won');
    expect(scoredReplay(game.world, noop, [...both] as never).hash).toBe(run.hash);
    expect(scoredReplay(game.world, bot, [both[1], both[0]] as never).hash).toBe(run.hash);

    const first = await send(game.id, { inputs: packInputs(bot), patches: both });
    expect(first.status).toBe(201);
    const { dareId } = (await first.json()) as { dareId: string };
    for (const body of [{ inputs: packInputs(noop), patches: both }, { inputs: packInputs(bot), patches: [both[1], both[0]] }]) {
      const again = await send(game.id, body);
      expect(again.status).toBe(200);
      expect(((await again.json()) as { dareId: string }).dareId).toBe(dareId);
    }
  });

  it('živá změna běhu se přehraje taky: hash a skóre jako v relaci prohlížeče', async () => {
    const game = await arcadeGame(hasLives);
    const session = createArcadeSession(game.world);
    const bot = new Map(runBot(game.world).inputs.map((event) => [event.tick, event] as const));
    while (session.snapshot().runState === 'running' && session.snapshot().tick < ARCADE_LIMITS.maxTicks) {
      const tick = session.snapshot().tick;
      if (tick === 30) expect(session.live({ kind: 'count', counter: 'health', amount: 2 })).toBeNull();
      const event = bot.get(tick);
      if (event !== undefined) session.press(event.buttons, event.axis);
      session.stepOnce();
    }
    expect(session.snapshot().runState).toBe('won');
    expect(session.patches()).toHaveLength(1);

    const response = await send(game.id, { inputs: packInputs(session.inputs()), patches: session.patches() });
    expect(response.status).toBe(201);
    const record = await stored(((await response.json()) as { dareId: string }).dareId);
    expect(record?.hash).toBe(hashArcade(session.state()));
    expect(record?.score).toBe(session.snapshot().score);
    expect(record?.liveChanges).toBe(1);
    // Bez změny je konec jiný: změna se opravdu přehrála, ne zahodila.
    expect(scoredReplay(game.world, session.inputs(), []).hash).not.toBe(record?.hash);
  });

  // Od P36A mají životy všechny startovní hry; odmítnutá změna je proto prázdná vizuální („Nothing to change.“).
  it('živá změna, kterou hra nevezme (vizuální bez změny) → 422, nic se neuložilo', async () => {
    const game = await arcadeGame();
    const putDare = vi.spyOn(versionStoreFromEnv(process.env), 'putDare');
    const response = await send(game.id, {
      inputs: packInputs(runBot(game.world).inputs),
      patches: [{ tick: 0, patch: { kind: 'visual' } }],
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('DARE_REJECTED');
    expect(putDare).not.toHaveBeenCalled();
  });

  it('vstupy jiné hry ani nečinný běh tuhle hru nevyhrají → 422 DARE_REJECTED', async () => {
    const games: { id: string; world: ArcadeWorld }[] = [];
    for (const { sentence } of STARTERS) {
      const game = await publish(sentence);
      if (game.world !== undefined) games.push({ id: game.id, world: game.world });
    }
    const target = games[0];
    const other = games.find((game) => game.id !== target?.id && target !== undefined && scoredReplay(target.world, runBot(game.world).inputs, []).outcome !== 'won');
    if (target === undefined || other === undefined) throw new Error('need two arcade starters whose bots do not cross-win');
    const foreign = runBot(other.world).inputs;
    const putDare = vi.spyOn(versionStoreFromEnv(process.env), 'putDare');

    // Každý z jiné adresy: prohrané přehrání stojí volajícího zbytek okna (T5r3r1).
    for (const [i, inputs] of [foreign, [] as InputEvent[]].entries()) {
      const response = await send(target.id, { inputs: packInputs(inputs) }, { 'x-forwarded-for': `198.51.100.${String(20 + i)}` });
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('DARE_REJECTED');
    }
    expect(putDare).not.toHaveBeenCalled();
  });

  it('5 401 tiků je 400 dřív, než se cokoli přehraje; 5 400 projde tvarem', async () => {
    const game = await arcadeGame();
    const over = await send(game.id, { inputs: [0, ARCADE_LIMITS.maxTicks + 1, 0, 0] });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    // Nečinných 5 400 tiků je platný tvar; hru ale nevyhraje.
    expect((await send(game.id, { inputs: [0, ARCADE_LIMITS.maxTicks, 0, 0] })).status).toBe(422);
  });

  it('nevalidní tvar → 400: chybějící vstupy, nečísla, cizí počítadlo, příliš mnoho změn', async () => {
    const game = await arcadeGame();
    const inputs = packInputs(runBot(game.world).inputs);
    const visual = { tick: 0, patch: { kind: 'visual', weather: 'rain' } };
    for (const body of [
      {},
      { inputs: 'tap tap' },
      { inputs: [0, 1, 'a', 0] },
      { inputs, patches: [{ tick: 0, patch: { kind: 'count', counter: 'gold', amount: 1 } }] },
      { inputs, patches: [{ tick: -1, patch: { kind: 'visual', weather: 'rain' } }] },
      { inputs, patches: Array.from({ length: 33 }, () => visual) },
      'not json',
    ]) {
      resetRateWindows();
      const response = await send(game.id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('mřížková hra (bez arkády) výzvu nenese → 422 DARE_REJECTED', async () => {
    const created = await createGame(post('/api/play/games', { spec: switchPuzzle }));
    const { versionId } = (await created.json()) as { versionId: string };
    const read = await readGame(new Request(`http://play.test/api/play/games/${versionId}`, { headers: CALLER }), params(versionId));
    expect(((await read.json()) as { arcade?: unknown }).arcade).toBeUndefined();
    const response = await send(versionId, { inputs: [0, 1, 1, 0] });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('DARE_REJECTED');
  });

  it('neznámá hra a nemožné id → 404 NOT_FOUND', async () => {
    expect((await send('0'.repeat(16), { inputs: [] })).status).toBe(404);
    expect((await send('not-an-id', { inputs: [] })).status).toBe(404);
  });

  it('výzva má vlastní přísnější okno: přehrání nad strop volajícího → 429, 11. na instanci → SERVER_AT_CAPACITY', async () => {
    const game = await arcadeGame();
    const bot = { inputs: packInputs(runBot(game.world).inputs) };
    resetRateWindows();
    const codes: string[] = [];
    for (let i = 0; i < MAX_DARE_REQUESTS_PER_WINDOW + 1; i += 1) {
      const response = await send(game.id, bot, CALLER);
      codes.push(response.status === 429 ? ((await response.json()) as { error: { code: string } }).error.code : String(response.status));
    }
    expect(codes).toEqual(['201', ...Array.from({ length: MAX_DARE_REQUESTS_PER_WINDOW - 1 }, () => '200'), 'TOO_MANY_REQUESTS']);

    resetRateWindows();
    let last: Response | null = null;
    for (let i = 0; i <= MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE; i += 1) last = await send(game.id, bot, { 'x-forwarded-for': `198.51.100.${String(i)}` });
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(((await last!.json()) as { error: { code: string } }).error.code).toBe('SERVER_AT_CAPACITY');
  });

  it('devět adres s prohraným i opakovaným vítězným během výzvy instanci nezavře: desátá projde (T5r3, revize T5r3-1/2)', async () => {
    const game = await arcadeGame();
    const win = packInputs(runBot(game.world).inputs);
    resetRateWindows();
    // Nálezy revizí: 3+3+3+1 prohraných (T5r3-1) i opakovaných vítězných (T5r3-2, opakování je 200) zaplnilo strop 10.
    for (let a = 0; a < MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE - 1; a += 1) {
      const address = { 'x-forwarded-for': `198.51.100.${String(a)}` };
      const inputs = a % 2 === 0 ? win : packInputs([]);
      const codes: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await send(game.id, { inputs }, address, i === 0 ? 500 : 0);
        codes.push(response.status === 429 ? ((await response.json()) as { error: { code: string } }).error.code : String(response.status));
      }
      expect(codes.slice(1)).toEqual(['TOO_MANY_REQUESTS', 'TOO_MANY_REQUESTS']);
    }
    expect((await send(game.id, { inputs: win }, { 'x-forwarded-for': '192.0.2.33' })).status).toBe(200);
  });

  it('skupina /64: prohraný běh i odmítnutá živá změna utratí zbytek jejího okna výzev (T5r3r1)', async () => {
    const game = await arcadeGame();
    resetRateWindows();
    process.env.VERCEL = '1';
    const group = (n: number) => ({ 'x-vercel-forwarded-for': `2001:db8:0:${String(n)}::5` });
    const refused = { inputs: packInputs(runBot(game.world).inputs), patches: [{ tick: 0, patch: { kind: 'visual' } }] };
    for (const [n, id, body] of [[1, game.id, refused], [2, game.id, { inputs: packInputs([]) }]] as const) {
      expect((await send(id, body, group(n))).status).toBe(422);
      expect((await send(game.id, { inputs: packInputs(runBot(game.world).inputs) }, group(n))).status).toBe(429);
    }
  });

  it('vadné požadavky slot výzev neberou: 11× {} od různých volajících výzvy instanci nezavře', async () => {
    const game = await arcadeGame();
    resetRateWindows();
    // V jednom okamžiku: posun hodin by přes hranici okna strop vynuloval a test by prošel i se slotem.
    for (let i = 0; i <= MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE; i += 1) {
      expect((await send(game.id, {}, { 'x-forwarded-for': `198.51.100.${String(i)}` }, 0)).status).toBe(400);
      expect((await send('0'.repeat(16), { inputs: [] }, { 'x-forwarded-for': `203.0.113.${String(i)}` }, 0)).status).toBe(404);
    }
    expect((await send(game.id, { inputs: packInputs(runBot(game.world).inputs) })).status).toBe(201);
  });
  it('denní strop výzev → 429 DARE_QUOTA s retry-after; týž běh podruhé strop neubírá', async () => {
    process.env.PLAY_DARE_DAILY_CAP = '1';
    __resetProcessVersionStore();
    const first = await arcadeGame();
    const bot = packInputs(runBot(first.world).inputs);
    expect((await send(first.id, { inputs: bot })).status).toBe(201);
    expect((await send(first.id, { inputs: bot })).status).toBe(200);
    // Výzva na jinou hru je nová výzva; strop ji nepustí.
    const other = await arcadeGame((world) => JSON.stringify(world) !== JSON.stringify(first.world));
    const second = await send(other.id, { inputs: packInputs(runBot(other.world).inputs) });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('3600');
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('DARE_QUOTA');
  });

  it('úložiště neodpovídá → 503 STORE_UNAVAILABLE', async () => {
    const game = await arcadeGame();
    vi.spyOn(versionStoreFromEnv(process.env), 'putDare').mockRejectedValueOnce(new VersionStoreUnavailable('down'));
    const response = await send(game.id, { inputs: packInputs(runBot(game.world).inputs) });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('STORE_UNAVAILABLE');
  });

  it('produkce bez Upstash: výzva v paměti procesu a hlavička x-play-store: memory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const game = await arcadeGame();
      const response = await send(game.id, { inputs: packInputs(runBot(game.world).inputs) });
      expect(response.status).toBe(201);
      expect(response.headers.get('x-play-store')).toBe('memory');
      expect(await stored(((await response.json()) as { dareId: string }).dareId)).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function readDare(id: string, dareId: string, headers: Record<string, string> = CALLER): Promise<Response> {
  return readDareRoute(new Request(`http://play.test/api/play/games/${id}/dare/${dareId}`, { headers }), { params: Promise.resolve({ id, dareId }) });
}

/** Vítězný běh robota se živou změnou (+2 životy v tiku 30), odehraný relací prohlížeče. */
function wonWithLiveChange(world: ArcadeWorld): ReturnType<typeof createArcadeSession> {
  const session = createArcadeSession(world);
  const bot = new Map(runBot(world).inputs.map((event) => [event.tick, event] as const));
  while (session.snapshot().runState === 'running' && session.snapshot().tick < ARCADE_LIMITS.maxTicks) {
    const tick = session.snapshot().tick;
    if (tick === 30) expect(session.live({ kind: 'count', counter: 'health', amount: 2 })).toBeNull();
    const event = bot.get(tick);
    if (event !== undefined) session.press(event.buttons, event.axis);
    session.stepOnce();
  }
  expect(session.snapshot().runState).toBe('won');
  return session;
}

/** Uložený běh zpátky na přehrání: rozbalené vstupy a uložené změny přes `replayLive`. */
function replayedHash(world: ArcadeWorld, run: DareReplay): string {
  const inputs = unpackInputs(run.inputs);
  if (typeof inputs === 'string') throw new Error(inputs);
  return replayLive(world, inputs, run.patches).hash;
}

/**
 * Falešný Upstash pro úložiště výzev: GET, MGET, EXISTS, SET (NX, EX), INCR, EXPIRE, PTTL, ZADD, ZREM, ZREMRANGEBYRANK,
 * ZREMRANGEBYSCORE, ZINTERSTORE (WEIGHTS), ZRANGE a transakce `/multi-exec`; expirace jdou do `ttl`, s `clock`
 * hodnoty po `EX` i vyprší. Každý požadavek nejdřív pustí ostatní na řadu, ať se souběžné zápisy prolnou;
 * transakce pak proběhne celá najednou. `requests` sbírá adresy a těla požadavků.
 */
function fakeUpstash(
  kv: Map<string, string>,
  ttl: Map<string, number>,
  zsets = new Map<string, Map<string, number>>(),
  options: { readonly clock?: () => number; readonly requests?: { url: string; body: unknown }[] } = {},
): typeof fetch {
  const deadlines = new Map<string, number>();
  const value = (key: string): string | undefined => {
    const deadline = deadlines.get(key);
    if (deadline !== undefined && options.clock !== undefined && options.clock() >= deadline) kv.delete(key);
    return kv.get(key);
  };
  // Seřazené množiny (P37C T2): pořadí Redisu – hodnocení, při shodě člen podle bajtů.
  const sorted = (key: string): [string, number][] =>
    [...(zsets.get(key) ?? new Map<string, number>())].sort(([am, ar], [bm, br]) => ar - br || (am < bm ? -1 : am > bm ? 1 : 0));
  const bound = (text: string, edge: 'min' | 'max'): ((score: number) => boolean) => {
    if (text === '-inf' || text === '+inf') return () => true;
    const limit = Number(text.replace('(', ''));
    const open = text.startsWith('(');
    return edge === 'min' ? (score) => (open ? score > limit : score >= limit) : (score) => (open ? score < limit : score <= limit);
  };
  const run = (parts: readonly string[]): unknown => {
    const [command, key = '', arg = '', ...flags] = parts;
    if (command === 'ZADD') {
      zsets.set(key, (zsets.get(key) ?? new Map<string, number>()).set(flags[0] as string, Number(arg)));
      return 1;
    }
    if (command === 'ZREM') {
      for (const member of parts.slice(2)) zsets.get(key)?.delete(member);
      return 1;
    }
    if (command === 'PTTL') {
      if (value(key) === undefined) return -2;
      const deadline = deadlines.get(key);
      if (deadline !== undefined && options.clock !== undefined) return deadline - options.clock();
      const seconds = ttl.get(key);
      return seconds === undefined ? -1 : seconds * 1000;
    }
    if (command === 'ZREMRANGEBYSCORE') {
      const [above, below] = [bound(arg, 'min'), bound(flags[0] as string, 'max')];
      zsets.set(key, new Map(sorted(key).filter(([, score]) => !(above(score) && below(score)))));
      return 1;
    }
    if (command === 'ZINTERSTORE') {
      const sources = parts.slice(3, 3 + Number(arg));
      const weights = parts.slice(4 + Number(arg)).map(Number);
      const [first = '', ...rest] = sources;
      const result = new Map<string, number>();
      for (const [member, score] of zsets.get(first) ?? new Map<string, number>()) {
        if (rest.every((source) => zsets.get(source)?.has(member) === true))
          result.set(member, sources.reduce((sum, source, index) => sum + (weights[index] ?? 1) * (zsets.get(source)?.get(member) as number), 0));
      }
      zsets.set(key, result);
      return result.size;
    }
    // Rozsah pořadí jako v Redisu: záporný index od konce, začátek oříznutý na 0, konec pod nulou = prázdný rozsah.
    const all = sorted(key);
    const at = (index: number): number => (index < 0 ? all.length + index : index);
    const start = Math.max(0, at(Number(arg)));
    const stop = at(Number(flags[0]));
    if (command === 'ZREMRANGEBYRANK') {
      zsets.set(key, new Map(all.filter((_, index) => index < start || index > stop)));
      return 1;
    }
    if (command === 'ZRANGE') return all.slice(start, stop + 1).flatMap(([member, rank]) => [member, String(rank)]);
    if (command === 'MGET') return parts.slice(1).map((k) => value(k) ?? null);
    if (command === 'EXISTS') return value(key) === undefined ? 0 : 1;
    if (command === 'INCR') {
      kv.set(key, String(Number(kv.get(key) ?? '0') + 1));
      return Number(kv.get(key));
    }
    if (command === 'EXPIRE') {
      ttl.set(key, Number(arg));
      return 1;
    }
    if (command === 'GET') return value(key) ?? null;
    if (command !== 'SET') throw new Error(`fake store does not know ${String(command)}`);
    if (flags.includes('NX') && value(key) !== undefined) return null;
    kv.set(key, arg);
    if (flags.includes('EX')) {
      const seconds = Number(flags[flags.indexOf('EX') + 1]);
      ttl.set(key, seconds);
      if (options.clock !== undefined) deadlines.set(key, options.clock() + seconds * 1000);
    }
    return 'OK';
  };
  return async (input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    options.requests?.push({ url: String(input), body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown) });
    const getMatch = /\/get\/(.+)$/.exec(String(input));
    if (getMatch !== null) return Response.json({ result: value(decodeURIComponent(getMatch[1] as string)) ?? null });
    const body = JSON.parse(String(init?.body)) as unknown[];
    if (String(input).endsWith('/multi-exec')) return Response.json((body as string[][]).map((parts) => ({ result: run(parts) })));
    return Response.json({ result: run(body as string[]) });
  };
}

const upstash = (kv: Map<string, string>, ttl: Map<string, number> = new Map()) =>
  httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS }, fakeUpstash(kv, ttl));

/** Výzva bez běhu, jak ji zapsal P36B; běh se do ní přidá v testu. */
const plainDare = (dareId: string): DareRecord => ({ dareId, versionId: 'a'.repeat(32), score: 10, ticks: 300, hash: 'h', liveChanges: 0, createdAt: '2026-10-03T00:00:00.000Z' });

describe('záznam výzvy pro ducha (P37C T1)', () => {
  it('výzva se živou změnou: GET vrátí běh a replayLive z něj dojde k témuž hashi jako ověření', async () => {
    const game = await arcadeGame(hasLives);
    const session = wonWithLiveChange(game.world);
    const posted = await send(game.id, { inputs: packInputs(session.inputs()), patches: session.patches() });
    expect(posted.status).toBe(201);
    const { dareId } = (await posted.json()) as { dareId: string };

    const response = await readDare(game.id, dareId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hash: string; score: number; liveChanges: number; replay: DareReplay | null };
    expect(body.hash).toBe(hashArcade(session.state()));
    expect(body.score).toBe(session.snapshot().score);
    expect(body.liveChanges).toBe(1);
    expect(body.replay?.v).toBe(1);
    expect(body.replay?.patches).toHaveLength(1);
    expect(replayedHash(game.world, body.replay as DareReplay)).toBe(body.hash);
  });

  it('běh bez změn přehraje i replay jádra k témuž hashi', async () => {
    const game = await arcadeGame();
    const posted = await send(game.id, { inputs: packInputs(runBot(game.world).inputs) });
    const { dareId } = (await posted.json()) as { dareId: string };
    const body = (await (await readDare(game.id, dareId)).json()) as { hash: string; replay: DareReplay };
    const inputs = unpackInputs(body.replay.inputs) as InputEvent[];
    expect(body.replay.patches).toEqual([]);
    expect(replay(game.world, inputs, ARCADE_LIBRARY).hash).toBe(body.hash);
  });

  it('falešný Upstash: záznam přežije zápis a čtení přes REST a přehraje se k témuž hashi', async () => {
    const game = await arcadeGame(hasLives);
    const session = wonWithLiveChange(game.world);
    const posted = await send(game.id, { inputs: packInputs(session.inputs()), patches: session.patches() });
    const record = (await stored(((await posted.json()) as { dareId: string }).dareId)) as DareRecord;

    const kv = new Map<string, string>();
    const ttl = new Map<string, number>();
    expect(await upstash(kv, ttl).putDare(record, 'voter')).toBe('stored');
    const back = await upstash(kv).getDare(record.dareId);
    expect(back?.replay).toEqual(record.replay);
    expect(replayedHash(game.world, back?.replay as DareReplay)).toBe(record.hash);
    // Duch vyprší dřív než výzva (nález revize T1-1 #2): výzva s hrou, běh po 30 dnech.
    expect(ttl.get(`test:play:dare:${record.dareId}`)).toBe(DEFAULT_WRITE_LIMITS.ttlSeconds);
    expect(ttl.get(`test:play:ghost:${record.dareId}`)).toBe(GHOST_TTL_SECONDS);
    expect(kv.get(`test:play:dare:${record.dareId}`)).not.toContain('"replay"');
  });

  it('stará výzva bez běhu a běh neznámé verze se čtou dál, jen bez ducha; GET dá replay null', async () => {
    const kv = new Map<string, string>();
    kv.set(`test:play:dare:${'b'.repeat(32)}`, JSON.stringify(plainDare('b'.repeat(32))));
    kv.set(`test:play:dare:${'c'.repeat(32)}`, JSON.stringify(plainDare('c'.repeat(32))));
    kv.set(`test:play:ghost:${'c'.repeat(32)}`, JSON.stringify({ v: 2, inputs: [], patches: [] }));
    const old = await upstash(kv).getDare('b'.repeat(32));
    expect(old).toMatchObject({ score: 10, ticks: 300 });
    expect(old?.replay).toBeUndefined();
    const newer = await upstash(kv).getDare('c'.repeat(32));
    expect(newer).toMatchObject({ score: 10 });
    expect(newer?.replay).toBeUndefined();

    const game = await arcadeGame();
    const dareId = 'd'.repeat(32);
    await versionStoreFromEnv(process.env).putDare({ ...plainDare(dareId), versionId: game.id });
    const body = (await (await readDare(game.id, dareId)).json()) as { score: number; replay: unknown };
    expect(body.score).toBe(10);
    expect(body.replay).toBeNull();
  });

  it(`strop bajtů: běh nad ${String(MAX_GHOST_BYTES)} B se neuloží, výzva platí; pod ním s během`, async () => {
    const versions = memoryVersionStore();
    const big = { v: 1, inputs: new Array<number>(MAX_GHOST_BYTES / 2).fill(0), patches: [] } as const;
    const small = { v: 1, inputs: new Array<number>(MAX_GHOST_BYTES / 2 - 50).fill(0), patches: [] } as const;
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(MAX_GHOST_BYTES);
    expect(await versions.putDare({ ...plainDare('e'.repeat(32)), replay: big }, 'voter')).toBe('stored');
    expect(await versions.putDare({ ...plainDare('f'.repeat(32)), replay: small }, 'voter')).toBe('stored');
    const over = await versions.getDare('e'.repeat(32));
    expect(over).toMatchObject({ score: 10, hash: 'h' });
    expect(over?.replay).toBeUndefined();
    expect((await versions.getDare('f'.repeat(32)))?.replay?.inputs).toHaveLength(small.inputs.length);
  });

  const run = { v: 1, inputs: [0, 5, 0, 1000], patches: [] } as const;
  const dareNo = (n: number): string => n.toString(16).padStart(32, '0');

  it('denní strop duchů: nad ním výzva bez běhu; týž běh poslaný další den ducha doplní', async () => {
    let now = Date.parse('2026-10-03T12:00:00Z');
    const versions = memoryVersionStore({ ...DEFAULT_WRITE_LIMITS, ghostDailyCap: 1 }, () => now);
    expect(await versions.putDare({ ...plainDare(dareNo(1)), replay: run }, 'alice')).toBe('stored');
    expect(await versions.putDare({ ...plainDare(dareNo(2)), replay: run }, 'bob')).toBe('stored');
    expect((await versions.getDare(dareNo(1)))?.replay).toEqual(run);
    expect((await versions.getDare(dareNo(2)))?.replay).toBeUndefined();
    now += 24 * 3600 * 1000;
    expect(await versions.putDare({ ...plainDare(dareNo(2)), replay: run }, 'bob')).toBe('exists');
    expect((await versions.getDare(dareNo(2)))?.replay).toEqual(run);
    expect(writeLimitsFromEnv({ PLAY_GHOST_DAILY_CAP: '7' }).ghostDailyCap).toBe(7);
  });

  it(`jeden volající zapíše nejvýš ${String(GHOST_DAILY_CAP_PER_CALLER)} duchů za den a ostatním strop nevyčerpá`, async () => {
    const versions = memoryVersionStore({ ...DEFAULT_WRITE_LIMITS, ghostDailyCap: GHOST_DAILY_CAP_PER_CALLER + 1 });
    for (let n = 0; n <= GHOST_DAILY_CAP_PER_CALLER; n += 1) await versions.putDare({ ...plainDare(dareNo(n)), replay: run }, 'mallory');
    expect((await versions.getDare(dareNo(GHOST_DAILY_CAP_PER_CALLER - 1)))?.replay).toEqual(run);
    expect((await versions.getDare(dareNo(GHOST_DAILY_CAP_PER_CALLER)))?.replay).toBeUndefined();
    await versions.putDare({ ...plainDare(dareNo(99)), replay: run }, 'alice');
    expect((await versions.getDare(dareNo(99)))?.replay).toEqual(run);
    // Bez volajícího se běh neuloží (není komu ho započíst).
    await versions.putDare({ ...plainDare(dareNo(100)), replay: run });
    expect((await versions.getDare(dareNo(100)))?.replay).toBeUndefined();
  });

  it('GET: výzva jiné hry, neznámá výzva a nemožné id → 404', async () => {
    const game = await arcadeGame();
    const posted = await send(game.id, { inputs: packInputs(runBot(game.world).inputs) });
    const { dareId } = (await posted.json()) as { dareId: string };
    const other = 'f'.repeat(32);
    expect((await readDare(other, dareId)).status).toBe(404);
    expect((await readDare(game.id, '0'.repeat(32))).status).toBe(404);
    expect((await readDare(game.id, 'not-a-dare')).status).toBe(404);
    expect((await readDare(game.id, dareId)).status).toBe(200);
  });

  it('GET hry nese bestDare: id, skóre a tiky ověřené výzvy; hra bez výzev null', async () => {
    const game = await arcadeGame();
    const before = (await (await readGame(new Request(`http://play.test/api/play/games/${game.id}`, { headers: CALLER }), params(game.id))).json()) as { bestDare: unknown };
    expect(before.bestDare).toBeNull();
    const posted = await send(game.id, { inputs: packInputs(runBot(game.world).inputs) });
    const { dareId, score, ticks } = (await posted.json()) as { dareId: string; score: number; ticks: number };
    const after = (await (await readGame(new Request(`http://play.test/api/play/games/${game.id}`, { headers: CALLER }), params(game.id))).json()) as { bestDare: unknown };
    expect(after.bestDare).toEqual({ dareId, score, ticks });
  });

  it('GET má strop frekvence dveří play: čtení nad strop od jednoho volajícího → 429', async () => {
    const caller = { 'x-forwarded-for': '203.0.113.77' };
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) expect((await readDare('a'.repeat(32), '0'.repeat(32), caller)).status).toBe(404);
    const refused = await readDare('a'.repeat(32), '0'.repeat(32), caller);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
  });
});

describe('duch nejlepšího (P37C T2)', () => {
  const run = { v: 1, inputs: [0, 5, 0, 1000], patches: [] } as const;
  const game = 'a'.repeat(32);
  const entry = (n: number, score: number, ticks: number): DareRecord => ({ ...plainDare(n.toString(16).padStart(32, '0')), versionId: game, score, ticks, replay: run });
  const better = entry(1, 500, 900);
  const worse = entry(2, 400, 300);

  it('hodnocení: vyšší skóre vyhraje, při shodě kratší čas', () => {
    expect(bestRank(500, 900)).toBeGreaterThan(bestRank(400, 300));
    expect(bestRank(500, 300)).toBeGreaterThan(bestRank(500, 900));
    expect(bestRank(-1, 0)).toBeLessThan(bestRank(0, ARCADE_LIMITS.maxTicks));
  });

  for (const [label, order] of [
    ['lepší první', [better, worse]],
    ['horší první', [worse, better]],
  ] as const) {
    it(`dva souběžné zápisy (${label}): v paměti i ve falešném Upstash zůstane lepší`, async () => {
      const versions = memoryVersionStore();
      await Promise.all(order.map((dare, index) => versions.putDare(dare, `voter${String(index)}`)));
      expect(await versions.bestDare(game)).toEqual({ dareId: better.dareId, score: 500, ticks: 900 });

      const shared = upstash(new Map(), new Map());
      await Promise.all(order.map((dare, index) => shared.putDare(dare, `voter${String(index)}`)));
      expect(await shared.bestDare(game)).toEqual({ dareId: better.dareId, score: 500, ticks: 900 });
    });
  }

  it('horší výzva později nejlepšího nenahradí; stejné skóre za kratší čas ano', async () => {
    const versions = memoryVersionStore();
    await versions.putDare(better, 'alice');
    await versions.putDare(worse, 'bob');
    expect((await versions.bestDare(game))?.dareId).toBe(better.dareId);
    const faster = entry(3, 500, 600);
    await versions.putDare(faster, 'carol');
    expect(await versions.bestDare(game)).toEqual({ dareId: faster.dareId, score: 500, ticks: 600 });
    expect(await versions.bestDare('b'.repeat(32))).toBeNull();
  });

  it('nejlepší s prošlým během zastoupí nejvyšší, jehož běh ještě leží (nález revize T2-1)', async () => {
    const day = 24 * 3600 * 1000;
    let now = Date.parse('2026-10-03T12:00:00Z');
    const versions = memoryVersionStore(DEFAULT_WRITE_LIMITS, () => now);
    const best = entry(5, 50, 100);
    const lesser = entry(6, 10, 100);
    await versions.putDare(best, 'alice');
    now += 20 * day;
    await versions.putDare(lesser, 'bob');
    expect((await versions.bestDare(game))?.dareId).toBe(best.dareId);
    now += 15 * day;
    // Den 35: běh nejlepšího (den 0) vypršel, běh horšího (den 20) leží – ten je teď duch nejlepšího.
    expect((await versions.getDare(best.dareId))?.replay).toBeUndefined();
    expect(await versions.bestDare(game)).toEqual({ dareId: lesser.dareId, score: 10, ticks: 100 });
    now += 20 * day;
    expect(await versions.bestDare(game)).toBeNull();
  });

  const day = 24 * 3600 * 1000;
  const start = Date.parse('2026-10-03T12:00:00Z');
  const bestKey = `test:play:best:${game}`;
  /** Paměť a falešný Upstash nad týmiž hodinami; v Upstash běhy po `EX` vyprší podle nich. */
  const stores = (clock: () => number, zsets = new Map<string, Map<string, number>>()) =>
    [
      ['paměť', memoryVersionStore(DEFAULT_WRITE_LIMITS, clock)],
      [
        'falešný Upstash',
        httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS, now: clock }, fakeUpstash(new Map(), new Map(), zsets, { clock })),
      ],
    ] as const;
  /** Pět výher ze dne 0 se skóre 49 až 45 – každá horší než všechny před ní (nález revize T2-2). */
  const early = [49, 48, 47, 46, 45].map((score, index) => entry(40 + index, score, 100));

  it('šest běhů, šestý nejhorší: po expiraci prvních pěti je duchem nejlepšího šestý (nález revize T2-2)', async () => {
    let now = start;
    for (const [label, versions] of stores(() => now)) {
      now = start;
      for (const [index, dare] of early.entries()) await versions.putDare(dare, `early${String(index)}`);
      now += 20 * day;
      const sixth = entry(50, 10, 100);
      await versions.putDare(sixth, 'late');
      expect(await versions.bestDare(game), label).toEqual({ dareId: early[0]?.dareId, score: 49, ticks: 100 });
      now += 11 * day;
      expect(await versions.bestDare(game), label).toEqual({ dareId: sixth.dareId, score: 10, ticks: 100 });
    }
  });

  it('nález T2-2 den 0 / 20 / 35: duch nejlepšího je B, po jeho expiraci C, nikdy null, dokud běh leží', async () => {
    let now = start;
    const zsets = new Map<string, Map<string, number>>();
    const b = entry(60, 10, 100);
    const c = entry(61, 5, 100);
    for (const [label, versions] of stores(() => now, zsets)) {
      now = start;
      for (const [index, dare] of early.entries()) await versions.putDare(dare, `early${String(index)}`);
      now += 20 * day;
      await versions.putDare(b, 'bob');
      now += 15 * day;
      await versions.putDare(c, 'carol');
      expect(await versions.bestDare(game), label).toEqual({ dareId: b.dareId, score: 10, ticks: 100 });
      now += 16 * day;
      expect(await versions.bestDare(game), label).toEqual({ dareId: c.dareId, score: 5, ticks: 100 });
      now += 15 * day;
      expect(await versions.bestDare(game), label).toBeNull();
    }
    // Zápis dne 35 odřízl běhy dne 0 podle času zápisu: v obou množinách zbyly jen B a C.
    expect([...(zsets.get(bestKey)?.keys() ?? [])].sort()).toEqual([b.dareId, c.dareId].sort());
    expect([...(zsets.get(`${bestKey}:at`)?.keys() ?? [])].sort()).toEqual([b.dareId, c.dareId].sort());
  });

  it(`nad stropem ${String(BEST_KEPT)} odejde člen těsně nad novým během: nejlepší i nový zůstanou (revize T2-3 #1)`, async () => {
    let now = start;
    const zsets = new Map<string, Map<string, number>>();
    const full = Array.from({ length: BEST_KEPT }, (_, index) => entry(70 + index, 90 - index, 100));
    const late = entry(90, 5, 100);
    for (const [label, versions] of stores(() => now, zsets)) {
      now = start;
      for (const [index, dare] of full.entries()) await versions.putDare(dare, `full${String(index)}`);
      now += 20 * day;
      await versions.putDare(late, 'late');
      // Devátý člen: strop vyhodil 83, které leželo těsně nad novým; nejlepší (90) zůstal.
      expect(await versions.bestDare(game), label).toEqual({ dareId: full[0]?.dareId, score: 90, ticks: 100 });
      now += 11 * day;
      expect(await versions.bestDare(game), label).toEqual({ dareId: late.dareId, score: 5, ticks: 100 });
    }
    expect([...(zsets.get(bestKey)?.values() ?? [])].sort((a, b) => a - b)).toEqual([5, 84, 85, 86, 87, 88, 89, 90].map((score) => bestRank(score, 100)));
    expect([...(zsets.get(`${bestKey}:at`)?.keys() ?? [])].sort()).toEqual([...(zsets.get(bestKey)?.keys() ?? [])].sort());
  });

  it(`${String(BEST_KEPT)} shodných běhů a devátý shodný: po expiraci prvních osmi je duchem devátý (revize T2-3 #2)`, async () => {
    let now = start;
    const zsets = new Map<string, Map<string, number>>();
    const tied = Array.from({ length: BEST_KEPT }, (_, index) => entry(0x200 + 2 * index, 30, 100));
    // Id devátého leží podle abecedy mezi prvním a druhým shodným: kdyby shodní v množině zůstali,
    // ležel by na indexu 1 a strop by vyhodil právě jeho.
    const ninth = entry(0x201, 30, 100);
    for (const [label, versions] of stores(() => now, zsets)) {
      now = start;
      for (const [index, dare] of tied.entries()) await versions.putDare(dare, `tied${String(index)}`);
      now += 20 * day;
      await versions.putDare(ninth, 'ninth');
      expect(await versions.bestDare(game), label).toEqual({ dareId: ninth.dareId, score: 30, ticks: 100 });
      now += 11 * day;
      expect(await versions.bestDare(game), label).toEqual({ dareId: ninth.dareId, score: 30, ticks: 100 });
    }
    // Shodný nový běh nahradil starší shodné: vyprší poslední, starší by nebyl potřeba nikdy.
    expect([...(zsets.get(bestKey)?.keys() ?? [])]).toEqual([ninth.dareId]);
  });

  it('lepší běh vyhodí všechny horší: rostoucí skóre nad strop nechá v množině jen nejlepší', async () => {
    const zsets = new Map<string, Map<string, number>>();
    const rising = Array.from({ length: BEST_KEPT + 1 }, (_, index) => entry(110 + index, 10 + index, 100));
    for (const [label, versions] of stores(() => start, zsets)) {
      for (const [index, dare] of rising.entries()) await versions.putDare(dare, `rising${String(index)}`);
      expect(await versions.bestDare(game), label).toEqual({ dareId: rising.at(-1)?.dareId, score: 10 + BEST_KEPT, ticks: 100 });
    }
    expect([...(zsets.get(bestKey)?.keys() ?? [])]).toEqual([rising.at(-1)?.dareId]);
  });

  it('znovu poslaný starší běh schodiště nepřepíše: horší, ale déle žijící běh zůstane', async () => {
    let now = start;
    for (const [label, versions] of stores(() => now)) {
      now = start;
      const first = entry(100, 50, 100);
      const second = entry(101, 40, 100);
      await versions.putDare(first, 'alice');
      now += 10 * day;
      await versions.putDare(second, 'bob');
      now += 10 * day;
      expect(await versions.putDare(first, 'alice'), label).toBe('exists');
      now += 11 * day;
      expect(await versions.bestDare(game), label).toEqual({ dareId: second.dareId, score: 40, ticks: 100 });
    }
  });

  it('zápis schodiště jde jedním požadavkem /multi-exec s expirací obou množin; jeho pád nenechá nic napůl (R1)', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const zsets = new Map<string, Map<string, number>>();
    const shared = httpVersionStore(
      { url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS },
      fakeUpstash(new Map(), new Map(), zsets, { requests }),
    );
    await shared.putDare(better, 'alice');
    const touching = requests.filter(({ url, body }) => `${decodeURIComponent(url)} ${JSON.stringify(body) ?? ''}`.includes(bestKey));
    expect(touching.map(({ url }) => url)).toEqual(['https://store.test/multi-exec']);
    const commands = touching[0]?.body as string[][];
    expect(commands.slice(-2)).toEqual([
      ['EXPIRE', bestKey, String(GHOST_TTL_SECONDS)],
      ['EXPIRE', `${bestKey}:at`, String(GHOST_TTL_SECONDS)],
    ]);

    const untouched = new Map<string, Map<string, number>>();
    const inner = fakeUpstash(new Map(), new Map(), untouched);
    const down: typeof fetch = (input, init) => (String(input).endsWith('/multi-exec') ? Promise.resolve(new Response('down', { status: 503 })) : inner(input, init));
    const failing = httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS }, down);
    expect(await failing.putDare(better, 'alice')).toBe('stored');
    expect(untouched.size).toBe(0);
    expect(await failing.bestDare(game)).toBeNull();
  });

  it('pád zápisu schodiště: znovu poslaný běh se doplní s časem svého zápisu a horší déle žijící nevyhodí (R3)', async () => {
    let now = start;
    const zsets = new Map<string, Map<string, number>>();
    let failures = 1;
    const inner = fakeUpstash(new Map(), new Map(), zsets, { clock: () => now });
    const flaky: typeof fetch = (input, init) =>
      String(input).endsWith('/multi-exec') && failures-- > 0 ? Promise.resolve(new Response('down', { status: 503 })) : inner(input, init);
    const versions = httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS, now: () => now }, flaky);
    const lost = entry(120, 50, 100);
    const later = entry(121, 40, 100);
    expect(await versions.putDare(lost, 'alice')).toBe('stored');
    expect(await versions.bestDare(game)).toBeNull();
    now += 10 * day;
    await versions.putDare(later, 'bob');
    now += 5 * day;
    expect(await versions.putDare(lost, 'alice')).toBe('exists');
    expect(await versions.bestDare(game)).toEqual({ dareId: lost.dareId, score: 50, ticks: 100 });
    // Den 31: běh ze dne 0 vypršel, horší ze dne 10 leží dál – doplnění ho nevyhodilo.
    now += 16 * day;
    expect(await versions.bestDare(game)).toEqual({ dareId: later.dareId, score: 40, ticks: 100 });
    // Doplněný člen nese čas svého zápisu (den 0), ne den doplnění.
    expect(zsets.get(`${bestKey}:at`)?.get(lost.dareId)).toBe(start);
  });

  it('nejlepším je jen výzva s uloženým během: lepší výzva bez ducha nejlepšího nezmění', async () => {
    const versions = memoryVersionStore();
    await versions.putDare(worse, 'alice');
    await versions.putDare({ ...better, replay: undefined }, 'bob');
    await versions.putDare(better);
    // Běh nad stropem bajtů se neuloží – ani takové výzvy do pětice nejlepších nevstoupí a skutečného ducha nevytlačí.
    const tooBig = { v: 1, inputs: new Array<number>(MAX_GHOST_BYTES).fill(0), patches: [] } as const;
    for (let n = 30; n < 36; n += 1) await versions.putDare({ ...entry(n, 900, 100), replay: tooBig }, `carol${String(n)}`);
    expect((await versions.bestDare(game))?.dareId).toBe(worse.dareId);
  });
});

describe('čítače smyčky nad Upstash (P37C T5)', () => {
  it('jedna událost ověří existenci hry jednou, ne za každý čítač; opakování nestojí nic (nález revize T5-1 #3)', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const kv = new Map<string, string>();
    const shared = httpVersionStore({ url: 'https://store.test', token: 't', prefix: 'test', timeoutMs: 1_000, limits: DEFAULT_WRITE_LIMITS }, fakeUpstash(kv, new Map(), new Map(), { requests }));
    const commands = (): string[] => requests.map(({ body }) => (body as string[])[0] as string);
    const unknown = 'd'.repeat(32);
    await shared.countLoop(unknown, ['start', 'finish', 'clear'], 'voter-t5-unknown');
    expect(commands()).toEqual(['EXISTS']);
    await shared.countLoop(unknown, ['start', 'finish', 'clear'], 'voter-t5-unknown');
    expect(requests).toHaveLength(1);

    const game = 'e'.repeat(32);
    kv.set(`test:play:v:${game}`, '{}');
    requests.length = 0;
    await shared.countLoop(game, ['start', 'finish', 'clear'], 'voter-t5-known');
    expect(commands().filter((command) => command === 'EXISTS')).toHaveLength(1);
    for (const counter of ['start', 'finish', 'clear']) expect(kv.get(`test:play:loop:${counter}:${game}`), counter).toBe('1');
  });
});
