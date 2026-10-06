/**
 * Kontrakt stránkovaného feedu (P27B T2, `docs/play/feed.md`): kdo do feedu
 * smí, jak se stránkuje a co vydrží souběžný zápis. Čistá část jede nad
 * řádky seznamu, dveře nad paměťovým úložištěm procesu – bez modelu.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as sendEvent } from '@/app/api/play/events/route';
import { GET as listGames, POST as createGame } from '@/app/api/play/games/route';
import { GET as readGame } from '@/app/api/play/games/[id]/route';
import { __resetProcessVersionStore, decodeCursor, feedEligible, feedPage, type FeedPage, hiddenFromEnv, type LoopHeat, RECENT_CAP, type RecentGame, versionStoreFromEnv } from '@/play/version';
import { BUILTIN_GAMES } from '@/play/version/builtin';
import { FEED_BLOCK, MAX_PER_ARCHETYPE } from '@/play/version/diversify';
import { encodeCursor, FRESH_EVERY } from '@/play/version/feed';
import { RUNTIME_VERSION } from '@/sim/interpreter';
import { resetRateWindows } from '@/server/rate-limit';

const NONE: ReadonlySet<string> = new Set();

let clock = 0;

/** Řádek feedu; čas roste s každým voláním, takže pozdější řádek je novější. */
function row(n: number, fields: Partial<RecentGame> = {}): RecentGame {
  clock += 1000;
  return {
    versionId: n.toString(16).padStart(32, '0'),
    title: `Game ${String(n)}`,
    specHash: 'x',
    worldHash: 'x',
    seed: 1,
    schemaVersion: 'gamespec.v1',
    compilerVersion: 'c',
    runtimeVersion: RUNTIME_VERSION,
    parentId: `d${n.toString(16).padStart(31, '0')}`,
    createdAt: new Date(Date.UTC(2026, 8, 24) + clock).toISOString(),
    archetype: ['collect_exit', 'chase_escape', 'hazard_crossing', 'switch_puzzle'][n % 4],
    relation: 'upgrade',
    ...fields,
  };
}

/** Všechny stránky za sebou; `between` smí mezi stránkami zapsat do seznamu. */
function walk(rows: RecentGame[], limit: number, hidden = NONE, between?: (page: number) => void): string[] {
  const seen: string[] = [];
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const result = feedPage(rows, limit, cursor, hidden);
    seen.push(...result.games.map((game) => game.versionId));
    if (result.next === null) return seen;
    cursor = decodeCursor(result.next);
    expect(cursor).not.toBeNull();
    between?.(page);
  }
  throw new Error('feed never ended');
}

beforeEach(() => {
  clock = 0;
});

describe('feedEligible', () => {
  it('lets in only an eligible authored version nobody hid', () => {
    const id = 'a'.repeat(32);
    expect(feedEligible({ versionId: id, relation: 'upgrade', publishEligible: true }, NONE)).toBe(true);
    expect(feedEligible({ versionId: id, publishEligible: true }, NONE)).toBe(false);
    expect(feedEligible({ versionId: id, relation: 'upgrade', publishEligible: false }, NONE)).toBe(false);
    expect(feedEligible({ versionId: id, relation: 'upgrade', publishEligible: true }, new Set([id]))).toBe(false);
    // Hra ze seedu provozovatele (P37C T6) smí do feedu taky, pod stejnou branou a skrytím.
    expect(feedEligible({ versionId: id, curated: true, publishEligible: true }, NONE)).toBe(true);
    expect(feedEligible({ versionId: id, curated: true, publishEligible: false }, NONE)).toBe(false);
    expect(feedEligible({ versionId: id, curated: true, publishEligible: true }, new Set([id]))).toBe(false);
  });

  it('reads the hide list from comma-separated ids and ignores blanks', () => {
    expect([...hiddenFromEnv({ PLAY_FEED_HIDE: ' aa , ,bb,' })]).toEqual(['aa', 'bb']);
    expect(hiddenFromEnv({}).size).toBe(0);
  });
});

describe('feedPage', () => {
  it('an empty list is one empty page with no next', () => {
    expect(feedPage([], 10, null, NONE)).toEqual({ games: [], next: null });
  });

  it('pages cover every game exactly once, newest first', () => {
    const rows = Array.from({ length: 23 }, (_, n) => row(n + 1));
    const seen = walk(rows, 5);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.versionId)));
  });

  it('a game published between two pages neither shifts nor repeats the rest', () => {
    const rows = Array.from({ length: 12 }, (_, n) => row(n + 1));
    const original = rows.map((r) => r.versionId);
    const seen = walk(rows, 4, NONE, (page) => rows.unshift(row(100 + page)));
    expect(seen).toEqual(expect.arrayContaining(original));
    expect(seen).toHaveLength(original.length);
    // Nová hra je na první stránce příštího načtení.
    expect(feedPage(rows, 4, null, NONE).games[0].versionId).toBe(rows[0].versionId);
  });

  it('a game diversify cannot place still lands on a page', () => {
    const rows = [...Array.from({ length: 10 }, (_, n) => row(n + 1, { archetype: 'chase_escape' })), row(20, { archetype: 'collect_exit' })];
    const seen = walk(rows, 4);
    expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.versionId)));
    expect(seen).toHaveLength(rows.length);
  });

  it('hides a game on the hide list', () => {
    const rows = [row(1), row(2), row(3)];
    const seen = walk(rows, 10, new Set([rows[1].versionId]));
    expect(seen).not.toContain(rows[1].versionId);
    expect(seen).toHaveLength(2);
  });

  it('shows only the newest authored version of one draft', () => {
    const older = row(1, { parentId: 'f'.repeat(32) });
    const newer = row(2, { parentId: 'f'.repeat(32) });
    const other = row(3);
    const seen = walk([older, newer, other], 10);
    expect(seen).toContain(newer.versionId);
    expect(seen).not.toContain(older.versionId);
  });

  it('never repeats a title that differs only in case and punctuation', () => {
    const rows = [row(1, { title: 'Coin Runner!' }), row(2, { title: 'coin  runner' }), row(3, { title: 'Coin Runners' })];
    const titles = feedPage(rows, 10, null, NONE).games.map((game) => game.title);
    expect(titles).toEqual(['Coin Runners', 'coin  runner']);
  });

  it('refuses a cursor it did not give out', () => {
    for (const bad of ['', '!!!', 'bm90IGpzb24', Buffer.from('[1,2,3]').toString('base64url'), Buffer.from('["2026-09-24T00:00:00.000Z","zz",1]').toString('base64url'), Buffer.from('["2026-09-24T00:00:00.000Z","aaaaaaaa",0]').toString('base64url')]) {
      expect(decodeCursor(bad), bad).toBeNull();
    }
  });

  it('refuses a well-formed cursor that was forged or edited', () => {
    const rows = Array.from({ length: 12 }, (_, n) => row(n + 1));
    const issued = feedPage(rows, 4, null, NONE).next;
    expect(issued).not.toBeNull();
    const [createdAt, versionId, offset] = JSON.parse(Buffer.from(issued as string, 'base64url').toString('utf8')) as unknown[];
    const forge = (value: unknown[]): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    // Bez kontrolního součtu, s cizím součtem, s posunutým offsetem a za stropem seznamu.
    for (const bad of [forge([createdAt, versionId, offset]), forge([createdAt, versionId, offset, 'deadbeef']), forge([createdAt, versionId, 9, 'deadbeef'])]) {
      expect(decodeCursor(bad), bad).toBeNull();
    }
    expect(decodeCursor(issued as string)).toMatchObject({ offset: 4 });
    const edited = JSON.parse(Buffer.from(issued as string, 'base64url').toString('utf8')) as unknown[];
    edited[2] = 8;
    expect(decodeCursor(forge(edited))).toBeNull();
  });

  it('refuses another spelling of an issued cursor', () => {
    const issued = feedPage(Array.from({ length: 12 }, (_, n) => row(n + 1)), 4, null, NONE).next as string;
    const json = Buffer.from(issued, 'base64url').toString('utf8');
    const respelled = Buffer.from(json.replace(/,4,/, ',4e0,')).toString('base64url');
    expect(JSON.parse(Buffer.from(respelled, 'base64url').toString('utf8'))).toEqual(JSON.parse(json));
    expect(decodeCursor(respelled)).toBeNull();
    // Volné bity posledního znaku: jiný znak, tytéž bajty.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(issued.at(-1) as string);
    const sibling = issued.slice(0, -1) + alphabet[last ^ 1];
    expect(Buffer.from(sibling, 'base64url').equals(Buffer.from(issued, 'base64url'))).toBe(true);
    expect(decodeCursor(sibling)).toBeNull();
    expect(decodeCursor(issued)).not.toBeNull();
  });

  it('refuses an offset beyond the list cap even with a valid checksum', () => {
    const top = { createdAt: '2026-09-24T00:00:00.000Z', versionId: 'a'.repeat(32) };
    expect(decodeCursor(encodeCursor({ top, offset: RECENT_CAP - 1 }))).toEqual({ top, offset: RECENT_CAP - 1 });
    expect(decodeCursor(encodeCursor({ top, offset: RECENT_CAP }))).toBeNull();
  });
});

describe('feed ranked by the loop (P36B T9)', () => {
  const heat = (fields: Partial<LoopHeat>): LoopHeat => ({ finishes: 0, dares: 0, skips: 0, starts: 0, clears: 0, retries: 0, shares: 0, bounces: 0, remixes: 0, ...fields });
  const ids = (page: FeedPage): string[] => page.games.map((game) => game.versionId);

  it('without counters the order stays newest first', () => {
    const rows = Array.from({ length: 12 }, (_, n) => row(n + 1));
    const plain = ids(feedPage(rows, 12, null, NONE));
    expect(ids(feedPage(rows, 12, null, NONE, new Map()))).toEqual(plain);
    expect(ids(feedPage(rows, 12, null, NONE, new Map(rows.map((r) => [r.versionId, heat({})]))))).toEqual(plain);
    expect(plain[0]).toBe(rows[11].versionId);
  });

  it('a game people dare goes ahead of an equally old one nobody dares', () => {
    const rows = Array.from({ length: 6 }, (_, n) => row(n + 1));
    const at = rows[0].createdAt;
    const dared = row(0x20, { createdAt: at, archetype: 'collect_exit' });
    const plain = row(0x21, { createdAt: at, archetype: 'chase_escape' });
    const all = [...rows, dared, plain];
    const before = ids(feedPage(all, 8, null, NONE));
    expect(before.indexOf(plain.versionId)).toBeLessThan(before.indexOf(dared.versionId));
    const after = ids(feedPage(all, 8, null, NONE, new Map([[dared.versionId, heat({ dares: 2 })]])));
    expect(after.indexOf(dared.versionId)).toBe(0);
    expect(after.indexOf(dared.versionId)).toBeLessThan(after.indexOf(plain.versionId));
  });

  it('a new game with no history still shows within the first three places', () => {
    const rows = Array.from({ length: 12 }, (_, n) => row(n + 1));
    const newest = rows[11];
    const hot = new Map(rows.slice(0, 11).map((r) => [r.versionId, heat({ finishes: 5, remixes: 1 })]));
    const order = ids(feedPage(rows, 12, null, NONE, hot));
    expect(order.indexOf(newest.versionId)).toBeLessThan(FRESH_EVERY);
    expect(order.indexOf(newest.versionId)).toBeGreaterThanOrEqual(0);
  });

  it('skips pull a game down: with equal finishes the older unskipped game goes first', () => {
    const rows = Array.from({ length: 6 }, (_, n) => row(n + 1));
    const order = ids(feedPage(rows, 6, null, NONE, new Map([[rows[4].versionId, heat({ finishes: 3, skips: 4 })], [rows[1].versionId, heat({ finishes: 3 })]])));
    expect(order.slice(0, 2)).toEqual([rows[1].versionId, rows[4].versionId]);
  });

  // P40 T5: feed podle toho, k čemu se lidi vrací.
  it('with equal finishes a game people replay and share goes ahead of one people bounce off', () => {
    const rows = Array.from({ length: 6 }, (_, n) => row(n + 1));
    const at = rows[0].createdAt;
    const kept = row(0x30, { createdAt: at, archetype: 'collect_exit' });
    const left = row(0x31, { createdAt: at, archetype: 'chase_escape' });
    const order = ids(feedPage([...rows, kept, left], 8, null, NONE, new Map([[kept.versionId, heat({ finishes: 2, retries: 1, shares: 1 })], [left.versionId, heat({ finishes: 2, bounces: 2 })]])));
    expect(order.indexOf(kept.versionId)).toBe(0);
    expect(order.indexOf(kept.versionId)).toBeLessThan(order.indexOf(left.versionId));
  });

  it.each([
    ['a replay', { retries: 1 }],
    ['a share', { shares: 1 }],
  ] as const)('%s lifts an older game over a newer one with the same finishes', (_why, extra) => {
    const rows = Array.from({ length: 6 }, (_, n) => row(n + 1));
    const order = ids(feedPage(rows, 6, null, NONE, new Map([[rows[1].versionId, heat({ finishes: 3, ...extra })], [rows[4].versionId, heat({ finishes: 3 })]])));
    expect(order.slice(0, 2)).toEqual([rows[1].versionId, rows[4].versionId]);
  });

  it('a share outweighs a replay, and a dare outweighs a share', () => {
    const rows = Array.from({ length: 6 }, (_, n) => row(n + 1));
    const order = ids(feedPage(rows, 6, null, NONE, new Map([[rows[0].versionId, heat({ dares: 1 })], [rows[1].versionId, heat({ shares: 1 })], [rows[4].versionId, heat({ retries: 1 })]])));
    expect([order.indexOf(rows[0].versionId), order.indexOf(rows[1].versionId)]).toEqual([0, 1]);
    expect(order.indexOf(rows[4].versionId)).toBeGreaterThan(1);
  });

  it('bounces pull a game down: with equal finishes the older game nobody bounced goes first', () => {
    const rows = Array.from({ length: 6 }, (_, n) => row(n + 1));
    const order = ids(feedPage(rows, 6, null, NONE, new Map([[rows[4].versionId, heat({ finishes: 3, bounces: 1 })], [rows[1].versionId, heat({ finishes: 3 })]])));
    expect(order.slice(0, 2)).toEqual([rows[1].versionId, rows[4].versionId]);
  });

  it('replays and shares keep the fresh slot and the three-per-archetype cap', () => {
    const others = ['collect_exit', 'hazard_crossing', 'switch_puzzle'];
    const rows = Array.from({ length: 16 }, (_, n) => row(n + 1, { archetype: n < 8 ? 'chase_escape' : others[n % 3] }));
    const newest = rows[15];
    const hot = new Map(rows.slice(0, 8).map((r) => [r.versionId, heat({ finishes: 5, retries: 3, shares: 3 })]));
    const order = feedPage(rows, 16, null, NONE, hot).games;
    expect(order.findIndex((game) => game.versionId === newest.versionId)).toBeLessThan(FRESH_EVERY);
    expect(order.slice(0, FEED_BLOCK).filter((game) => game.archetype === 'chase_escape').length).toBeLessThanOrEqual(MAX_PER_ARCHETYPE);
  });
});

describe('GET /api/play/games?recent&cursor', () => {
  const CALLER = { 'x-forwarded-for': '203.0.113.7' };
  const feed = async (query: string): Promise<{ status: number; body: Record<string, any> }> => {
    const response = await listGames(new Request(`http://play.test/api/play/games${query}`, { headers: CALLER }));
    return { status: response.status, body: await response.json() };
  };

  beforeEach(() => {
    __resetProcessVersionStore();
    resetRateWindows();
    // Kontrakt nad uloženými hrami: vestavěnou sadu (P37C T6, `builtin.test.ts`) provozovatel skryje.
    vi.stubEnv('PLAY_FEED_HIDE', BUILTIN_GAMES.map((game) => game.version.versionId).join(','));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Autorská verze ručního specu, jak by ji zapsal upgrade na pozadí. */
  async function authored(title: string, n: number): Promise<string> {
    const versions = versionStoreFromEnv(process.env);
    const response = await createGame(
      new Request('http://play.test/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json', ...CALLER }, body: JSON.stringify({ sentence: title }) }),
    );
    const draftId = ((await response.json()) as { versionId: string }).versionId;
    const draft = await versions.get(draftId);
    if (draft === null) throw new Error('draft missing');
    const versionId = n.toString(16).padStart(32, 'c');
    const createdAt = new Date(Date.UTC(2026, 8, 24) + n * 1000).toISOString();
    expect(await versions.put({ ...draft, relation: 'upgrade', version: { ...draft.version, title, versionId, parentId: draftId, createdAt } })).toBe('stored');
    return versionId;
  }

  it('pages with a cursor, 400 on a broken one, and a hidden game still opens by link', async () => {
    const ids = [];
    for (const [n, title] of ['Collect the coins', 'Run from the bear', 'Cross the road', 'Jump the gaps'].entries()) ids.push(await authored(title, n + 1));

    const first = await feed('?recent=3');
    expect(first.status).toBe(200);
    expect(first.body.games).toHaveLength(3);
    expect(typeof first.body.next).toBe('string');
    const second = await feed(`?recent=3&cursor=${first.body.next as string}`);
    expect(second.body).toMatchObject({ next: null });
    expect([...first.body.games, ...second.body.games].map((g: { versionId: string }) => g.versionId).sort()).toEqual([...ids].sort());

    expect((await feed('?recent=3&cursor=broken!')).status).toBe(400);
    expect((await feed('?recent=3&cursor=a&cursor=a')).status).toBe(400);

    vi.stubEnv('PLAY_FEED_HIDE', ids[0]);
    const shown = (await feed('?recent=10')).body.games.map((g: { versionId: string }) => g.versionId);
    expect(shown).not.toContain(ids[0]);
    expect((await readGame(new Request(`http://play.test/api/play/games/${ids[0]}`), { params: Promise.resolve({ id: ids[0] }) })).status).toBe(200);
  });

  // P36B T9: dohrání se započte při události a feed podle něj přeřadí; vymyšlené id čítač nedostane.
  // Revize T9-1: jedna adresa započte hře dohrání jednou za den, ať mění relaci jak chce; výzvu slovem klienta nezapočte vůbec.
  it('finishes reported through the event door move a game up, once per caller; forged dares and unknown games count nothing', async () => {
    const older = await authored('Collect the coins', 1);
    const newer = await authored('Run from the bear', 2);
    const order = async (): Promise<string[]> => (await feed('?recent=10')).body.games.map((g: { versionId: string }) => g.versionId);
    const heat = async (versionId: string): Promise<LoopHeat | undefined> => (await versionStoreFromEnv(process.env).loopHeat([versionId])).get(versionId);
    expect(await order()).toEqual([newer, older]);

    const report = (body: Record<string, unknown>, ip = '203.0.113.7'): Promise<Response> =>
      sendEvent(new Request('http://play.test/api/play/events', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify({ session: 'abcdefghijkl', ...body }) }));
    for (const name of ['win', 'lose']) expect((await report({ name, versionId: older })).status).toBe(204);
    expect(await order()).toEqual([older, newer]);
    for (let n = 0; n < 5; n += 1) expect((await report({ name: 'win', versionId: newer, session: `session${String(n).padStart(6, '0')}` })).status).toBe(204);
    expect(await heat(newer)).toMatchObject({ finishes: 1 });
    expect((await report({ name: 'share', versionId: newer, dare: true })).status).toBe(204);
    expect(await heat(newer)).toMatchObject({ dares: 0 });
    expect(await heat(older)).toMatchObject({ finishes: 1 });
    expect((await report({ name: 'win', versionId: older }, '198.51.100.4')).status).toBe(204);
    expect(await heat(older)).toMatchObject({ finishes: 2 });

    const unknown = 'e'.repeat(32);
    expect((await report({ name: 'win', versionId: unknown })).status).toBe(204);
    expect(await heat(unknown)).toEqual({ finishes: 0, dares: 0, skips: 0, starts: 0, clears: 0, retries: 0, shares: 0, bounces: 0, remixes: 0 });
  });

  // P37C T5: „clear rate“ – pokus (`first_input`) a výhra, každý jeden hlas volajícího za den; pod deseti pokusy nic.
  it('shows the clear rate from ten attempts, counts one attempt per caller and nothing for an unknown game', async () => {
    const game = await authored('Collect the coins', 1);
    const heat = async (versionId: string): Promise<LoopHeat | undefined> => (await versionStoreFromEnv(process.env).loopHeat([versionId])).get(versionId);
    const beat = async (): Promise<{ feed: unknown; game: unknown }> => {
      const listed = (await feed('?recent=10')).body.games.find((g: { versionId: string }) => g.versionId === game) as { beat: unknown };
      const detail = await readGame(new Request(`http://play.test/api/play/games/${game}`, { headers: CALLER }), { params: Promise.resolve({ id: game }) });
      return { feed: listed.beat, game: ((await detail.json()) as { beat: unknown }).beat };
    };
    const report = (name: string, ip: string, session = 'abcdefghijkl', versionId = game): Promise<Response> =>
      sendEvent(new Request('http://play.test/api/play/events', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify({ name, versionId, session }) }));

    // Falešné pokusy a výhry od jednoho volajícího, každý s novou relací: jeden pokus, jedna výhra.
    for (let n = 0; n < 12; n += 1) expect((await report('first_input', '203.0.113.50', `forged${String(n).padStart(6, '0')}`)).status).toBe(204);
    for (let n = 0; n < 3; n += 1) expect((await report('win', '203.0.113.50', `forged${String(n).padStart(6, '0')}`)).status).toBe(204);
    expect(await heat(game)).toMatchObject({ starts: 1, clears: 1, finishes: 1 });

    // Osm dalších volajících: devět pokusů, tři výhry, prohra výhru nepočítá – pod prahem nic.
    for (let n = 1; n <= 8; n += 1) await report('first_input', `198.51.100.${String(n)}`);
    for (const n of [1, 2]) await report('win', `198.51.100.${String(n)}`);
    await report('lose', '198.51.100.3');
    expect(await heat(game)).toMatchObject({ starts: 9, clears: 3 });
    expect(await beat()).toEqual({ feed: null, game: null });

    // Desátý pokus: 3 výhry z 10 = 30 %.
    await report('first_input', '198.51.100.9');
    expect(await beat()).toEqual({ feed: 30, game: 30 });
    // Nečinný hráč hry na přežití vyhraje bez vstupu: výhra je i pokus, 4 z 11 = 36 % (nález revize T5-1 #1).
    await report('win', '198.51.100.11');
    expect(await heat(game)).toMatchObject({ starts: 11, clears: 4 });

    const unknown = 'e'.repeat(32);
    for (const name of ['first_input', 'win']) expect((await report(name, '198.51.100.10', 'abcdefghijkl', unknown)).status).toBe(204);
    expect(await heat(unknown)).toMatchObject({ starts: 0, clears: 0 });
  });
});
