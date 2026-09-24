/**
 * Kontrakt stránkovaného feedu (P27B T2, `docs/play/feed.md`): kdo do feedu
 * smí, jak se stránkuje a co vydrží souběžný zápis. Čistá část jede nad
 * řádky seznamu, dveře nad paměťovým úložištěm procesu – bez modelu.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as listGames, POST as createGame } from '@/app/api/play/games/route';
import { GET as readGame } from '@/app/api/play/games/[id]/route';
import { __resetProcessVersionStore, decodeCursor, feedEligible, feedPage, hiddenFromEnv, RECENT_CAP, type RecentGame, versionStoreFromEnv } from '@/play/version';
import { encodeCursor } from '@/play/version/feed';
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

  it('refuses an offset beyond the list cap even with a valid checksum', () => {
    const top = { createdAt: '2026-09-24T00:00:00.000Z', versionId: 'a'.repeat(32) };
    expect(decodeCursor(encodeCursor({ top, offset: RECENT_CAP - 1 }))).toEqual({ top, offset: RECENT_CAP - 1 });
    expect(decodeCursor(encodeCursor({ top, offset: RECENT_CAP }))).toBeNull();
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
});
