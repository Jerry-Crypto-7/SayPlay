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
import { hashArcade } from '@/play/arcade/kernel';
import { runBot } from '@/play/arcade/verify';
import { packInputs } from '@/play/score/dare';
import { scoredReplay } from '@/play/score/replay';
import { __resetProcessVersionStore, VersionStoreUnavailable, versionStoreFromEnv } from '@/play/version';
import { MAX_DARE_REQUESTS_PER_WINDOW, MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE, resetRateWindows } from '@/server/rate-limit';

import { POST as createGame } from '../games/route';
import { GET as readGame } from '../games/[id]/route';
import { POST as dare } from '../games/[id]/dare/route';

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

  it('živá změna, kterou hra nevezme (životy hře bez životů) → 422, nic se neuložilo', async () => {
    const game = await arcadeGame((world) => !hasLives(world));
    const putDare = vi.spyOn(versionStoreFromEnv(process.env), 'putDare');
    const response = await send(game.id, {
      inputs: packInputs(runBot(game.world).inputs),
      patches: [{ tick: 0, patch: { kind: 'count', counter: 'health', amount: 3 } }],
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
    const plain = await arcadeGame((world) => !hasLives(world));
    const game = await arcadeGame();
    resetRateWindows();
    process.env.VERCEL = '1';
    const group = (n: number) => ({ 'x-vercel-forwarded-for': `2001:db8:0:${String(n)}::5` });
    const refused = { inputs: packInputs(runBot(plain.world).inputs), patches: [{ tick: 0, patch: { kind: 'count', counter: 'health', amount: 3 } }] };
    for (const [n, id, body] of [[1, plain.id, refused], [2, game.id, { inputs: packInputs([]) }]] as const) {
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
