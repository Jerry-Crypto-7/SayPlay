/**
 * Žebříček z dveří výzvy (P44B T5): `POST /api/play/games/:id/dare` zapíše po ověřené výhře bez živých
 * změn hráče z platné cookie se skóre, které spočítal server přehráním. Číslo z těla, padělaná cookie,
 * běh se živými změnami ani znovu poslaný cizí běh (duch je veřejný) žebříček nezmění; `beat` jen
 * porovnáním `bestRank` s uloženou výzvou téže hry. Paměťové i souborové úložiště.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { packInputs } from '@/play/score/dare';
import { __resetProcessVersionStore, versionStoreFromEnv, VersionStoreUnavailable } from '@/play/version';
import { PLAYER_COOKIE } from '@/server/player-identity';
import { resetRateWindows } from '@/server/rate-limit';

import { NEW_PLAYERS_PER_HOUR_SHARED } from '../_player';
import { GET as readDareRoute } from '../games/[id]/dare/[dareId]/route';
import { GET as me } from '../me/route';
import { freshCaller, player, publishedGame, SECRET, send } from './dare-fixtures';

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

describe.each(['memory', 'file'])('POST …/dare feeds the leaderboard over the %s store (P44B T5)', (kind) => {
  beforeEach(() => {
    if (kind === 'file') {
      const dir = mkdtempSync(join(tmpdir(), 'p44b-dare-board-'));
      dirs.push(dir);
      vi.stubEnv('PLAY_STORE_DIR', dir);
    }
  });

  it('zapíše přehrané skóre pod hráče z cookie; čísla ani jméno z těla nečte a id hráče nevrátí', async () => {
    const { id, runs } = await publishedGame();
    const ada = player();
    const sent = await send(id, { inputs: packInputs(runs.better.inputs), score: 999_999, ticks: 1, hash: 'forged', playerId: 'x'.repeat(22), nickname: 'Admin', place: 1 }, ada.cookie);
    expect(sent.status).toBe(201);
    expect(sent.setCookie).toBeNull();
    expect(sent.body).toEqual({ dareId: expect.stringMatching(/^[a-f0-9]{32}$/), score: runs.better.run.score, ticks: runs.better.run.tick, board: { place: 1, of: 1 }, beat: null });
    expect(sent.text).not.toContain(ada.id);
    expect(await versions().board(id, 10)).toEqual([{ playerId: ada.id, dareId: sent.body.dareId, score: runs.better.run.score, ticks: runs.better.run.tick, place: 1 }]);
    expect((await versions().getDare(sent.body.dareId))?.by).toBe(ada.id);
    // Autor výzvy ven nejde ani čtením výzvy (duch je veřejný).
    const read = await readDareRoute(new Request(`http://play.test/api/play/games/${id}/dare/${sent.body.dareId}`, { headers: freshCaller() }), { params: Promise.resolve({ id, dareId: sent.body.dareId }) });
    expect(read.status).toBe(200);
    expect(await read.text()).not.toContain(ada.id);
  });

  it('bez cookie ji vydá a zapíše pod ni; id hráče jen v set-cookie', async () => {
    const { id, runs } = await publishedGame();
    const sent = await send(id, { inputs: packInputs(runs.better.inputs) });
    expect(sent.status).toBe(201);
    expect(sent.setCookie).toContain('HttpOnly');
    const issued = (sent.setCookie as string).split(';')[0]?.slice(PLAYER_COOKIE.length + 1).split('.')[0] as string;
    expect(sent.text).not.toContain(issued);
    expect(sent.body.board).toEqual({ place: 1, of: 1 });
    expect((await versions().board(id, 10)).map(({ playerId }) => playerId)).toEqual([issued]);
  });

  it('padělaná nebo zdvojená cookie: výzva 201 jako dnes, žebříček beze změny, žádná nová cookie', async () => {
    const { id, runs } = await publishedGame();
    const ada = player();
    const forged = `${PLAYER_COOKIE}=${ada.id}.${'A'.repeat(43)}`;
    const sent = await send(id, { inputs: packInputs(runs.better.inputs) }, forged);
    expect(sent.status).toBe(201);
    expect(sent.setCookie).toBeNull();
    expect(sent.body.board).toBeNull();
    const doubled = await send(id, { inputs: packInputs(runs.worse.inputs) }, `${ada.cookie}; ${player().cookie}`);
    expect(doubled.status).toBe(201);
    expect(doubled.setCookie).toBeNull();
    expect(doubled.body.board).toBeNull();
    expect(await versions().board(id, 10)).toEqual([]);
  });

  it('běh se živou změnou je výzva, ale do žebříčku nejde', async () => {
    const { id, runs } = await publishedGame();
    const ada = player();
    const sent = await send(id, { inputs: packInputs(runs.better.inputs), patches: [{ tick: 0, patch: { kind: 'visual', weather: 'rain' } }] }, ada.cookie);
    expect(sent.status).toBe(201);
    expect((await versions().getDare(sent.body.dareId))?.liveChanges).toBe(1);
    expect(sent.body.board).toBeNull();
    expect(await versions().board(id, 10)).toEqual([]);
  });

  it('běh patří prvnímu zapisovateli: cizí kopie ducha žebříček nezmění, vlastní opakování ano', async () => {
    const { id, runs } = await publishedGame();
    const [ada, bo] = [player(), player()];
    const first = await send(id, { inputs: packInputs(runs.better.inputs) }, ada.cookie);
    expect(first.status).toBe(201);
    const copy = await send(id, { inputs: packInputs(runs.better.inputs) }, bo.cookie);
    expect(copy.status).toBe(200);
    expect(copy.body.dareId).toBe(first.body.dareId);
    expect(copy.body.board).toBeNull();
    expect((await versions().board(id, 10)).map(({ playerId }) => playerId)).toEqual([ada.id]);
    expect((await versions().getDare(first.body.dareId))?.by).toBe(ada.id);
    const again = await send(id, { inputs: packInputs(runs.better.inputs) }, ada.cookie);
    expect(again.status).toBe(200);
    expect(again.body.board).toEqual({ place: 1, of: 1 });
  });

  it('lepší běh téhož hráče zvedne jeho řádek, horší ho nechá', async () => {
    const { id, runs } = await publishedGame();
    const ada = player();
    const worse = await send(id, { inputs: packInputs(runs.worse.inputs) }, ada.cookie);
    const better = await send(id, { inputs: packInputs(runs.better.inputs) }, ada.cookie);
    expect(better.body.board).toEqual({ place: 1, of: 1 });
    const rows = await versions().board(id, 10);
    expect(rows).toEqual([{ playerId: ada.id, dareId: better.body.dareId, score: runs.better.run.score, ticks: runs.better.run.tick, place: 1 }]);
    const worseAgain = await send(id, { inputs: packInputs(runs.worse.inputs) }, ada.cookie);
    expect(worseAgain.body.dareId).toBe(worse.body.dareId);
    expect(await versions().board(id, 10)).toEqual(rows);
  });

  it('beat: true jen nad uloženou výzvou téže hry s nižším hodnocením; cizí hra, neznámá i vadná výzva = null', async () => {
    const { id, runs } = await publishedGame();
    const [ada, bo] = [player(), player()];
    const weaker = await send(id, { inputs: packInputs(runs.worse.inputs) }, ada.cookie);
    const beaten = await send(id, { inputs: packInputs(runs.better.inputs), against: weaker.body.dareId }, bo.cookie);
    expect(beaten.body.beat).toBe(true);
    // Trychtýř (P44B T12): porážka výzvy jednou za den na hráče a hru.
    expect((await send(id, { inputs: packInputs(runs.better.inputs), against: weaker.body.dareId }, bo.cookie)).body.beat).toBe(true);
    expect((await versions().funnel(1))[0]?.counts.beat).toBe(1);
    expect((await versions().board(id, 10)).map(({ playerId, place }) => [playerId, place])).toEqual([
      [bo.id, 1],
      [ada.id, 2],
    ]);
    // Týž běh proti sobě (stejné hodnocení) ani horší proti lepšímu výhra není.
    expect((await send(id, { inputs: packInputs(runs.better.inputs), against: beaten.body.dareId }, bo.cookie)).body.beat).toBe(false);
    expect((await send(id, { inputs: packInputs(runs.worse.inputs), against: beaten.body.dareId }, ada.cookie)).body.beat).toBe(false);
    const elsewhere = { ...(await versions().getDare(weaker.body.dareId))!, dareId: 'e'.repeat(32), versionId: 'f'.repeat(64), score: 0, ticks: 1 };
    expect(await versions().putDare(elsewhere)).toBe('stored');
    expect((await send(id, { inputs: packInputs(runs.better.inputs), against: elsewhere.dareId }, bo.cookie)).body.beat).toBeNull();
    expect((await send(id, { inputs: packInputs(runs.better.inputs), against: 'a'.repeat(32) }, bo.cookie)).body.beat).toBeNull();
    const malformed = await send(id, { inputs: packInputs(runs.better.inputs), against: '../x' }, bo.cookie);
    expect(malformed.status).toBe(200);
    expect(malformed.body.beat).toBeNull();
  });

  it('výpadek úložiště při zápisu žebříčku výzvu neshodí: board null', async () => {
    const { id, runs } = await publishedGame();
    vi.spyOn(versions(), 'putBoardEntry').mockRejectedValueOnce(new VersionStoreUnavailable('connect ECONNREFUSED'));
    const sent = await send(id, { inputs: packInputs(runs.better.inputs) }, player().cookie);
    expect(sent.status).toBe(201);
    expect(sent.body.board).toBeNull();
  });

  it('nad stropem nových hráčů výzva projde bez cookie a bez žebříčku', async () => {
    const { id, runs } = await publishedGame();
    // Mimo Vercel sdílí všichni jeden koš stropu (T3, od T3b širší); vyčerpá ho kdokoli.
    for (let n = 0; n < NEW_PLAYERS_PER_HOUR_SHARED; n++) {
      resetRateWindows();
      expect((await me(new Request('http://play.test/api/play/me', { headers: freshCaller() }))).status).toBe(200);
    }
    const sent = await send(id, { inputs: packInputs(runs.better.inputs) });
    expect(sent.status).toBe(201);
    expect(sent.setCookie).toBeNull();
    expect(sent.body.board).toBeNull();
    expect(await versions().board(id, 10)).toEqual([]);
  });
});

describe('POST …/dare without player identity (Vercel without a secret)', () => {
  it('výzva projde jako dřív, bez cookie a bez žebříčku', async () => {
    const { id, runs } = await publishedGame();
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('PLAY_IDENTITY_SECRET', '');
    const sent = await send(id, { inputs: packInputs(runs.better.inputs) }, player().cookie);
    expect(sent.status).toBe(201);
    expect(sent.setCookie).toBeNull();
    expect(sent.body.board).toBeNull();
    expect(await versions().board(id, 10)).toEqual([]);
  });
});
