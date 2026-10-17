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

import { type ArcadeWorld, BUTTON, type InputEvent } from '@/play/arcade/contract';
import { packInputs } from '@/play/score/dare';
import { scoredReplay } from '@/play/score/replay';
import { __resetProcessVersionStore, versionStoreFromEnv, VersionStoreUnavailable } from '@/play/version';
import { issuePlayer, PLAYER_COOKIE } from '@/server/player-identity';
import { resetRateWindows } from '@/server/rate-limit';

import { NEW_PLAYERS_PER_HOUR_SHARED } from '../_player';
import { changesOf, copiesRun, NEAR_COPY_TICKS } from '../games/[id]/dare/route';
import { GET as readDareRoute } from '../games/[id]/dare/[dareId]/route';
import { GET as me } from '../me/route';
import { freshCaller, player, publishedGame, type Runs, SECRET, send } from './dare-fixtures';

const versions = () => versionStoreFromEnv(process.env);

/** Id hráče z hlavičky `set-cookie`. */
const issuedId = (setCookie: string | null): string => (setCookie as string).split(';')[0]?.slice(PLAYER_COOKIE.length + 1).split('.')[0] as string;

const shifted = (inputs: readonly InputEvent[], by: number): InputEvent[] => inputs.map((event) => ({ ...event, tick: event.tick + by }));

/** Vstupy seřazené podle tiku, v jednom tiku jen první – jak je chce `scoredReplay`. */
const ordered = (inputs: readonly InputEvent[]): InputEvent[] =>
  [...inputs].sort((a, b) => a.tick - b.tick).filter((event, index, all) => index === 0 || all[index - 1]?.tick !== event.tick);

/** Hash konce, když je `inputs` vítězný běh s týmž skóre a tiky ± `NEAR_COPY_TICKS` jako `original` a jiným koncem než `taken` (nová výzva), jinak `null`. */
function sameScoreNewDare(world: ArcadeWorld, original: Runs['better'], inputs: readonly InputEvent[], taken: readonly string[] = []): string | null {
  const run = scoredReplay(world, inputs, []);
  const fits = run.outcome === 'won' && run.score === original.run.score && Math.abs(run.tick - original.run.tick) <= NEAR_COPY_TICKS;
  return fits && ![original.run.hash, ...taken].includes(run.hash) ? run.hash : null;
}

/**
 * Duch posunutý o nejmenší počet tiků, který dá novou výzvu se stejným skóre. Ve hrách, kde posun skončí týmž
 * koncem (křeček s pár klepnutími), je kopie táž výzva a drží ji pravidlo prvního zapisovatele – `null`.
 */
function ghostCopy(world: ArcadeWorld, original: Runs['better'], taken: readonly string[] = []): { inputs: InputEvent[]; hash: string } | null {
  for (let by = 1; by <= NEAR_COPY_TICKS; by += 1) {
    const inputs = shifted(original.inputs, by);
    const hash = sameScoreNewDare(world, original, inputs, taken);
    if (hash !== null) return { inputs, hash };
  }
  return null;
}

/**
 * Druhý poctivý hráč: vítězný běh s týmž skóre a tiky ± `NEAR_COPY_TICKS` jako `original`, ale s vlastní rukou –
 * každý druhý stisk o pár tiků jinak, nebo slabší osa. Hry se skóre po krocích a pevným koncem takové běhy dávají
 * běžně (měření T5b: přežití 60 s končí u všech vítězů 250 body v tiku 3 600).
 */
function lookAlike(world: ArcadeWorld, original: Runs['better']): InputEvent[] | null {
  const hands: ((event: InputEvent, index: number) => InputEvent)[] = [3, -3, 5, -5, 8, -8, 12, -12].map(
    (by) => (event, index) => (index % 2 === 0 ? event : { ...event, tick: Math.max(0, event.tick + by) }),
  );
  hands.push((event) => ({ ...event, axis: Math.trunc(event.axis * 0.6) }));
  for (const hand of hands) {
    const inputs = ordered(original.inputs.map(hand));
    if (sameScoreNewDare(world, original, inputs) !== null) return inputs;
  }
  return null;
}

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
    const issued = issuedId(sent.setCookie);
    expect(sent.text).not.toContain(issued);
    expect(sent.body.board).toEqual({ place: 1, of: 1 });
    expect((await versions().board(id, 10)).map(({ playerId }) => playerId)).toEqual([issued]);
  });

  it('jediná cookie se starým podpisem (restart, rotace) i padělaná dostane novou identitu a zápis; zdvojená dál nic (T5b)', async () => {
    const { id, runs } = await publishedGame();
    const old = issuePlayer('STALE_FIXTURE_ONLY_NOT_A_REAL_SECRET_000');
    const stale = await send(id, { inputs: packInputs(runs.better.inputs) }, `${PLAYER_COOKIE}=${old.value}`);
    expect(stale.status).toBe(201);
    expect(stale.setCookie).toContain('HttpOnly');
    const renewed = issuedId(stale.setCookie);
    expect(renewed).not.toBe(old.id);
    expect(stale.body.board).toEqual({ place: 1, of: 1 });
    // Padělek s cizím id vydá taky novou identitu – nikdy tu cizí.
    const ada = player();
    const forged = await send(id, { inputs: packInputs(runs.worse.inputs) }, `${PLAYER_COOKIE}=${ada.id}.${'A'.repeat(43)}`);
    expect(forged.status).toBe(201);
    const fresh = issuedId(forged.setCookie);
    expect([old.id, ada.id, renewed]).not.toContain(fresh);
    const doubled = await send(id, { inputs: packInputs(runs.worse.inputs) }, `${ada.cookie}; ${player().cookie}`);
    expect(doubled.status).toBe(200);
    expect(doubled.setCookie).toBeNull();
    expect(doubled.body.board).toBeNull();
    expect((await versions().board(id, 10)).map(({ playerId }) => playerId)).toEqual([renewed, fresh]);
  });

  it('téměř-kopie ducha: cizí běh posunutý o pár tiků žebříček nezmění ani podruhé, výzva platí; vlastní posun ano (T5b)', async () => {
    // Hra musí mít dva různé posuny se stejným skóre: cizí kopii a pak Adin vlastní posun s jiným koncem.
    const { id, world, runs } = await publishedGame((game, both) => {
      const copy = ghostCopy(game, both.better);
      return copy !== null && ghostCopy(game, both.better, [copy.hash]) !== null;
    });
    const [ada, bo] = [player(), player()];
    const copied = ghostCopy(world, runs.better) as NonNullable<ReturnType<typeof ghostCopy>>;
    const first = await send(id, { inputs: packInputs(runs.better.inputs) }, ada.cookie);
    expect(first.body.board).toEqual({ place: 1, of: 1 });
    const copy = await send(id, { inputs: packInputs(copied.inputs) }, bo.cookie);
    expect(copy.status).toBe(201);
    expect(copy.body.dareId).not.toBe(first.body.dareId);
    expect(copy.body.score).toBe(first.body.score);
    expect(copy.body.board).toBeNull();
    // Týž běh znovu – výzva už leží s autorem Bo – žebříčkem nepohne taky.
    expect((await send(id, { inputs: packInputs(copied.inputs) }, bo.cookie)).body.board).toBeNull();
    expect((await versions().board(id, 10)).map(({ playerId }) => playerId)).toEqual([ada.id]);
    // Vlastní posunutý běh je pořád Adin.
    const own = ghostCopy(world, runs.better, [copied.hash]);
    expect(own).not.toBeNull();
    expect((await send(id, { inputs: packInputs(own?.inputs ?? []) }, ada.cookie)).body.board).toEqual({ place: 1, of: 1 });
  });

  it('dva poctiví hráči se stejným skóre a blízkými tiky jsou v žebříčku oba; kopie toho níž ne (T5b, revize T5b-1)', async () => {
    // Který z obou řádků se stejným skóre leží níž, rozhodne až úložiště – kopie s novým koncem musí jít z obou běhů.
    const { id, world, runs } = await publishedGame((game, both) => {
      const look = lookAlike(game, both.better);
      if (look === null) return false;
      const boLike = { inputs: look, run: scoredReplay(game, look, []) };
      const taken = [both.better.run.hash, boLike.run.hash];
      return ghostCopy(game, both.better, taken) !== null && ghostCopy(game, boLike, taken) !== null;
    });
    const [ada, bo, cy] = [player(), player(), player()];
    const other = lookAlike(world, runs.better) as InputEvent[];
    expect((await send(id, { inputs: packInputs(runs.better.inputs) }, ada.cookie)).body.board).toEqual({ place: 1, of: 1 });
    expect((await send(id, { inputs: packInputs(other) }, bo.cookie)).body.board).toEqual({ place: expect.any(Number), of: 2 });
    const rows = await versions().board(id, 10);
    expect(rows.map(({ playerId }) => playerId).sort()).toEqual([ada.id, bo.id].sort());
    // Kopie ducha druhého řádku: porovnávají se všechny řádky se stejným skóre, ne jen ten první.
    const boRun = { inputs: other, run: scoredReplay(world, other, []) };
    const lower = rows[1]?.playerId === bo.id ? boRun : runs.better;
    const copied = ghostCopy(world, lower, [runs.better.run.hash, boRun.run.hash]);
    expect(copied).not.toBeNull();
    const copy = await send(id, { inputs: packInputs(copied?.inputs ?? []) }, cy.cookie);
    expect(copy.status).toBe(201);
    expect(copy.body.board).toBeNull();
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

  it('beat: null, když živou změnu nese nový běh nebo uložená výzva; trychtýř beat nepočítá', async () => {
    const { id, runs } = await publishedGame();
    const [ada, bo] = [player(), player()];
    const weaker = await send(id, { inputs: packInputs(runs.worse.inputs) }, ada.cookie);
    const patched = await send(
      id,
      { inputs: packInputs(runs.better.inputs), patches: [{ tick: 0, patch: { kind: 'visual', weather: 'rain' } }], against: weaker.body.dareId },
      bo.cookie,
    );
    expect(patched.body.beat).toBeNull();
    const changedRival = { ...(await versions().getDare(weaker.body.dareId))!, dareId: 'c'.repeat(32), liveChanges: 1, score: 0, ticks: 1 };
    expect(await versions().putDare(changedRival)).toBe('stored');
    expect((await send(id, { inputs: packInputs(runs.better.inputs), against: changedRival.dareId }, bo.cookie)).body.beat).toBeNull();
    expect((await versions().funnel(1))[0]?.counts.beat ?? 0).toBe(0);
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

describe('kopie ducha se pozná podle změn vstupu, ne podle držených tiků (T5b, revize T5b-1)', () => {
  /** Držení doprava od `from` do `to` se skoky v tikách `jumps`. */
  const hold = (from: number, to: number, jumps: readonly number[]): InputEvent[] =>
    Array.from({ length: to - from + 1 }, (_, k) => from + k).map((tick) => ({ tick, buttons: jumps.includes(tick) ? BUTTON.RIGHT | BUTTON.UP : BUTTON.RIGHT, axis: 0 }));

  it('stejné držení o chvíli později s vlastními skoky kopie není; posunutý duch ano', () => {
    const ada = hold(10, 3590, [500, 1200, 2000, 2700, 3100]);
    expect(copiesRun(changesOf(hold(25, 3605, [700, 1500, 2600, 2900, 3300])), changesOf(ada))).toBe(false);
    expect(copiesRun(changesOf(shifted(ada, 7)), changesOf(ada))).toBe(true);
  });

  it('běh z pár změn (jedno držení) nikomu nepatří', () => {
    expect(copiesRun(changesOf(hold(25, 3605, [])), changesOf(hold(10, 3590, [])))).toBe(false);
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
