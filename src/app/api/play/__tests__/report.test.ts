/**
 * Nahlášení hry z feedu (P54A T11): `POST /api/play/games/:id/report`.
 *
 * Hlas se počítá jednou na volajícího a hru; až tři různí volající hru z feedu
 * skryjí (k `PLAY_FEED_HIDE` se sčítá). Vestavěnou hru nahlášení neskryje –
 * tu skryje jen provozovatel. Dveře jdou přes bránu `admit()` jako ostatní.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore } from '@/play/version';
import { BUILTIN_GAMES } from '@/play/version/builtin';
import { REPORT_HIDE_VOTES } from '@/play/version/store';
import { MAX_REQUESTS_PER_WINDOW, resetRateWindows, takeRateSlot } from '@/server/rate-limit';

import { callerOf } from '../_publish';
import { POST as reportGame } from '../games/[id]/report/route';
import { POST as remixGame } from '../games/[id]/remix/route';
import { GET as listGames } from '../games/route';

const BUILTIN = BUILTIN_GAMES[0]!.version.versionId;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
/** `ip` je adresa od platformy (důvěryhodná jen s `VERCEL=1`), `written` hlavička, kterou si volající píše sám. */
const report = (id: string, ip: string, written = ip) =>
  reportGame(new Request(`http://play.test/api/play/games/${id}/report`, { method: 'POST', headers: { 'x-vercel-forwarded-for': ip, 'x-forwarded-for': written } }), params(id));
const feedIds = async (): Promise<string[]> => {
  const response = await listGames(new Request('http://play.test/api/play/games?recent=24', { headers: { 'x-forwarded-for': '192.0.2.250' } }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { games: { versionId: string }[] }).games.map((game) => game.versionId);
};

/** Remix vestavěné hry: do feedu jde (T10), nahlásit ho jde. */
async function publishedRemix(): Promise<string> {
  const response = await remixGame(
    new Request(`http://play.test/api/play/games/${BUILTIN}/remix`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.251' }, body: JSON.stringify({ chip: 'harder' }) }),
    params(BUILTIN),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { versionId: string }).versionId;
}

describe('POST /api/play/games/:id/report (P54A T11)', () => {
  beforeEach(() => {
    resetRateWindows();
    __resetProcessVersionStore();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetProcessVersionStore();
  });

  it('hides a game once three different callers report it; one caller reporting again does not count', async () => {
    // Feed jen s remixem: vestavěnou sadu skryje provozovatel.
    vi.stubEnv('PLAY_FEED_HIDE', BUILTIN_GAMES.map((game) => game.version.versionId).join(','));
    const remix = await publishedRemix();
    expect(await feedIds()).toEqual([remix]);
    expect(REPORT_HIDE_VOTES).toBe(3);
    vi.stubEnv('VERCEL', '1');

    for (let again = 0; again < 4; again += 1) expect((await report(remix, '203.0.113.10', `198.51.100.${String(again)}`)).status).toBe(204);
    expect((await report(remix, '203.0.113.11')).status).toBe(204);
    // Dva různí volající (jeden pětkrát, pokaždé s jinou vlastní hlavičkou) hru nechají.
    expect(await feedIds()).toEqual([remix]);

    expect((await report(remix, '203.0.113.12')).status).toBe(204);
    expect(await feedIds()).toEqual([]);
    // Skrytá z feedu, ne smazaná: odkaz dál hraje.
    expect((await report(remix, '203.0.113.13')).status).toBe(204);
  });

  it('off Vercel callers write their own address, so all of them together are one vote', async () => {
    vi.stubEnv('PLAY_FEED_HIDE', BUILTIN_GAMES.map((game) => game.version.versionId).join(','));
    const remix = await publishedRemix();
    for (const ip of ['203.0.113.50', '203.0.113.51', '203.0.113.52', '203.0.113.53']) expect((await report(remix, ip)).status).toBe(204);
    expect(await feedIds()).toEqual([remix]);
  });

  it('a built-in game stays in the feed however many report it', async () => {
    vi.stubEnv('PLAY_FEED_HIDE', BUILTIN_GAMES.slice(1).map((game) => game.version.versionId).join(','));
    vi.stubEnv('VERCEL', '1');
    expect(await feedIds()).toEqual([BUILTIN]);
    for (const ip of ['203.0.113.20', '203.0.113.21', '203.0.113.22', '203.0.113.23']) expect((await report(BUILTIN, ip)).status).toBe(204);
    expect(await feedIds()).toEqual([BUILTIN]);
  });

  it('an unknown or malformed id is 404', async () => {
    expect((await report('0'.repeat(32), '203.0.113.30')).status).toBe(404);
    expect((await report('not-a-game', '203.0.113.30')).status).toBe(404);
  });

  it('goes through the gate: a caller over the rate cap is refused and nothing is counted', async () => {
    vi.stubEnv('PLAY_FEED_HIDE', BUILTIN_GAMES.map((game) => game.version.versionId).join(','));
    const remix = await publishedRemix();
    vi.stubEnv('VERCEL', '1');
    expect((await report(remix, '203.0.113.40')).status).toBe(204);
    expect((await report(remix, '203.0.113.41')).status).toBe(204);
    const caller = callerOf(new Request('http://play.test/', { headers: { 'x-vercel-forwarded-for': '203.0.113.42' } }));
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1) takeRateSlot('play', caller);
    const refused = await report(remix, '203.0.113.42');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect(await feedIds()).toEqual([remix]);
  });
});
