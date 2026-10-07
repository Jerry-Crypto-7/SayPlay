/**
 * Veřejný žebříček hry (P44B T6): `GET /api/play/games/:id/board` nad skutečným úložištěm s běhy, které
 * zapsaly dveře výzvy. Nejvýš 10 řádků `{ place, nickname, score, ticks, dareId, you }`; přezdívka z
 * `PUT /api/play/me`, jinak výchozí; `you` jen u hráče z platné cookie. Id hráče ani podpis cookie
 * v těle nikdy, odpověď se necachuje. Paměťové i souborové úložiště.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultNickname } from '@/play/player/nickname';
import { packInputs } from '@/play/score/dare';
import { __resetProcessVersionStore, versionStoreFromEnv, VersionStoreUnavailable } from '@/play/version';
import { PLAYER_COOKIE } from '@/server/player-identity';
import { resetRateWindows } from '@/server/rate-limit';

import { GET as board } from '../games/[id]/board/route';
import { GET as readDareRoute } from '../games/[id]/dare/[dareId]/route';
import { PUT as rename } from '../me/route';
import { freshCaller, params, player, publishedGame, SECRET, send } from './dare-fixtures';

interface Row {
  place: number;
  nickname: string;
  score: number;
  ticks: number;
  dareId: string | null;
  you: boolean;
}

async function read(id: string, cookie?: string): Promise<{ status: number; cacheControl: string | null; text: string; rows: Row[] }> {
  const response = await board(new Request(`http://play.test/api/play/games/${id}/board`, { headers: { ...freshCaller(), ...(cookie === undefined ? {} : { cookie }) } }), params(id));
  const text = await response.text();
  return { status: response.status, cacheControl: response.headers.get('cache-control'), text, rows: (JSON.parse(text) as { rows?: Row[] }).rows ?? [] };
}

async function nickname(cookie: string, name: string): Promise<void> {
  const response = await rename(
    new Request('http://play.test/api/play/me', { method: 'PUT', headers: { 'content-type': 'application/json', cookie, ...freshCaller() }, body: JSON.stringify({ nickname: name }) }),
  );
  expect(response.status).toBe(200);
}

const signatureOf = (cookie: string): string => cookie.slice(cookie.indexOf('.') + 1);

const versions = () => versionStoreFromEnv(process.env);

const dirs: string[] = [];

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
  vi.stubEnv('PLAY_IDENTITY_SECRET', SECRET);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetProcessVersionStore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(['memory', 'file'])('GET /api/play/games/:id/board over the %s store (P44B T6)', (kind) => {
  beforeEach(() => {
    if (kind === 'file') {
      const dir = mkdtempSync(join(tmpdir(), 'p44b-board-route-'));
      dirs.push(dir);
      vi.stubEnv('PLAY_STORE_DIR', dir);
    }
  });

  it('dva hráči v pořadí přehraných běhů, jméno z PUT /me, you jen u volajícího, bez id a podpisu, no-store', async () => {
    const { id, runs } = await publishedGame();
    const [ada, bo] = [player(), player()];
    await nickname(ada.cookie, 'Ada');
    const slower = await send(id, { inputs: packInputs(runs.worse.inputs) }, ada.cookie);
    const faster = await send(id, { inputs: packInputs(runs.better.inputs) }, bo.cookie);

    const seenByAda = await read(id, ada.cookie);
    expect(seenByAda.status).toBe(200);
    expect(seenByAda.cacheControl).toBe('no-store');
    expect(JSON.parse(seenByAda.text)).toEqual({
      rows: [
        { place: 1, nickname: defaultNickname(bo.id), score: runs.better.run.score, ticks: runs.better.run.tick, dareId: faster.body.dareId, you: false },
        { place: 2, nickname: 'Ada', score: runs.worse.run.score, ticks: runs.worse.run.tick, dareId: slower.body.dareId, you: true },
      ],
    });
    for (const secret of [ada.id, bo.id, signatureOf(ada.cookie), signatureOf(bo.cookie)]) expect(seenByAda.text).not.toContain(secret);

    expect((await read(id, bo.cookie)).rows.map(({ you }) => you)).toEqual([true, false]);
    expect((await read(id)).rows.map(({ you }) => you)).toEqual([false, false]);

    // „Race this run“: řádek vede na běh ducha stávajícími dveřmi výzvy.
    const ghost = await readDareRoute(new Request(`http://play.test/api/play/games/${id}/dare/${faster.body.dareId}`, { headers: freshCaller() }), {
      params: Promise.resolve({ id, dareId: faster.body.dareId }),
    });
    expect(ghost.status).toBe(200);
    expect(((await ghost.json()) as { replay: unknown }).replay).not.toBeNull();
  });

  it('padělaná ani zdvojená cookie you nedostane', async () => {
    const { id, runs } = await publishedGame();
    const ada = player();
    await send(id, { inputs: packInputs(runs.better.inputs) }, ada.cookie);
    expect((await read(id, `${PLAYER_COOKIE}=${ada.id}.${'A'.repeat(43)}`)).rows.map(({ you }) => you)).toEqual([false]);
    expect((await read(id, `${ada.cookie}; ${player().cookie}`)).rows.map(({ you }) => you)).toEqual([false]);
  });

  it('nejvýš 10 řádků od prvního místa', async () => {
    const { id } = await publishedGame();
    const players = Array.from({ length: 12 }, () => player());
    for (const [index, { id: playerId }] of players.entries())
      await versions().putBoardEntry(id, { playerId, dareId: index.toString(16).padStart(32, '0'), score: 100 + index, ticks: 600 });
    const { rows } = await read(id);
    expect(rows.map(({ place, score }) => [place, score])).toEqual(Array.from({ length: 10 }, (_, index) => [index + 1, 111 - index]));
  });

  it('hra bez běhů → prázdný žebříček; neznámá hra a vadné id → 404', async () => {
    const { id } = await publishedGame();
    const empty = await read(id);
    expect(empty.status).toBe(200);
    expect(empty.rows).toEqual([]);
    expect((await read('f'.repeat(64))).status).toBe(404);
    expect((await read('../etc')).status).toBe(404);
  });

  it('výpadek úložiště → 503, ne prázdný žebříček', async () => {
    const { id } = await publishedGame();
    vi.spyOn(versions(), 'board').mockRejectedValueOnce(new VersionStoreUnavailable('connect ECONNREFUSED'));
    const down = await read(id);
    expect(down.status).toBe(503);
    expect(down.text).not.toContain('"rows"');
  });

  it('vypínač all zavře i čtení žebříčku', async () => {
    const { id } = await publishedGame();
    const dir = mkdtempSync(join(tmpdir(), 'p44b-board-kill-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'control.json'), JSON.stringify({ off: ['all'] }));
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', join(dir, 'control.json'));
    expect((await read(id)).status).toBe(503);
  });
});
