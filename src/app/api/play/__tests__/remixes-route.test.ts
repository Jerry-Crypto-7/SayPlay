/**
 * Řetěz remixů (P44B T11): `GET /api/play/games/:id/remixes` vrátí nejvýš 12 dětí hry od nejnovějšího
 * s názvem, čipy rozdílu proti rodiči a nejlepším řádkem **jejich vlastního** žebříčku – skóre rodiče
 * se k remixu nepřiřadí. Autorská verze od AI (`relation: 'upgrade'`) remix není. Id hráče v těle nikdy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STARTERS } from '@/components/play/starters';
import { defaultNickname } from '@/play/player/nickname';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { remixChips } from '@/play/version/remix-diff';
import { resetRateWindows } from '@/server/rate-limit';

import { POST as createGame } from '../games/route';
import { GET as remixesOf } from '../games/[id]/remixes/route';
import { CALLER, freshCaller, params, post, SECRET } from './dare-fixtures';

interface Remix {
  versionId: string;
  title: string;
  chips: string[];
  top: { nickname: string; score: number; ticks: number } | null;
}

const versions = () => versionStoreFromEnv(process.env);

async function publish(sentence: string, parentId: string | null = null): Promise<string> {
  const created = await createGame(post('/api/play/games', { sentence, parentId }, CALLER));
  expect(created.status).toBe(201);
  return ((await created.json()) as { versionId: string }).versionId;
}

async function read(id: string): Promise<{ status: number; cacheControl: string | null; text: string; remixes: Remix[] }> {
  const response = await remixesOf(new Request(`http://play.test/api/play/games/${id}/remixes`, { headers: freshCaller() }), params(id));
  const text = await response.text();
  return { status: response.status, cacheControl: response.headers.get('cache-control'), text, remixes: (JSON.parse(text) as { remixes?: Remix[] }).remixes ?? [] };
}

const playerId = (n: number): string => `p${String(n).padStart(21, '0')}`;
const dareId = (n: number): string => n.toString(16).padStart(32, '0');

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
  vi.stubEnv('PLAY_IDENTITY_SECRET', SECRET);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  __resetProcessVersionStore();
});

describe('GET /api/play/games/:id/remixes (P44B T11)', () => {
  it('každý remix nese nejlepší řádek svého žebříčku, ne rodičova; bez běhů top null; id hráče ven nejde', async () => {
    const [first, second, third] = STARTERS.map(({ sentence }) => sentence);
    const parent = await publish(first!);
    const scored = await publish(second!, parent);
    const quiet = await publish(third!, parent);
    await versions().putBoardEntry(parent, { playerId: playerId(1), dareId: dareId(1), score: 9_999, ticks: 300 });
    await versions().putBoardEntry(scored, { playerId: playerId(2), dareId: dareId(2), score: 2_450, ticks: 900 });
    await versions().putBoardEntry(scored, { playerId: playerId(3), dareId: dareId(3), score: 1_200, ticks: 600 });
    await versions().putPlayer(playerId(2), { nickname: 'Ada' });

    const { status, cacheControl, text, remixes } = await read(parent);
    expect(status).toBe(200);
    expect(cacheControl).toBe('public, max-age=0, s-maxage=60');
    const [parentGame, scoredGame, quietGame] = await Promise.all([parent, scored, quiet].map((id) => versions().get(id)));
    expect(remixes).toEqual([
      { versionId: quiet, title: quietGame!.version.title, chips: remixChips(parentGame!.spec, quietGame!.spec), top: null },
      { versionId: scored, title: scoredGame!.version.title, chips: remixChips(parentGame!.spec, scoredGame!.spec), top: { nickname: 'Ada', score: 2_450, ticks: 900 } },
    ]);
    for (const n of [1, 2, 3]) expect(text).not.toContain(playerId(n));

    // Výchozí jméno, když si hráč žádné nedal.
    await versions().putBoardEntry(quiet, { playerId: playerId(4), dareId: dareId(4), score: 10, ticks: 100 });
    expect((await read(parent)).remixes[0]?.top).toEqual({ nickname: defaultNickname(playerId(4)), score: 10, ticks: 100 });
  });

  it('nejvýš 12 nejnovějších remixů; autorská verze od AI mezi nimi není', async () => {
    const parent = await publish(STARTERS[0]!.sentence);
    const child = (await versions().get(await publish(STARTERS[1]!.sentence, parent)))!;
    const ids = [child.version.versionId];
    for (let n = 1; n < 14; n++) {
      const versionId = n.toString(16).padStart(32, 'a');
      expect(await versions().put({ ...child, version: { ...child.version, versionId } })).toBe('stored');
      ids.push(versionId);
    }
    const upgrade = 'b'.repeat(32);
    expect(await versions().put({ ...child, version: { ...child.version, versionId: upgrade }, relation: 'upgrade' })).toBe('stored');

    const { remixes } = await read(parent);
    expect(remixes.map(({ versionId }) => versionId)).toEqual(ids.slice(-12).reverse());
    expect(remixes.map(({ versionId }) => versionId)).not.toContain(upgrade);
  });

  it('hra bez remixů → prázdný seznam; neznámá hra a vadné id → 404', async () => {
    const lonely = await publish(STARTERS[0]!.sentence);
    const empty = await read(lonely);
    expect(empty.status).toBe(200);
    expect(empty.remixes).toEqual([]);
    expect((await read('f'.repeat(32))).status).toBe(404);
    expect((await read('../etc')).status).toBe(404);
  });
});
