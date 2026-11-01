/**
 * Sdílení, výzva Dare a přehrání pěti her P68 (P68-I T6). Pro každou hru s ručním specem
 * `e2e/fixtures/p68-<id>-spec.json`, jejíž modul z něj svět postaví: publikace dveřmi `/api/play/games`, `GET` hry
 * i stránka `/play/<id>` dají týž svět; robot dohraje → `packInputs` → JSON těla → `unpackInputs` → `scoredReplay`
 * (s Rapierem, když svět má tělesa, jako dveře výzvy) dá týž výsledek, skóre a hash konce; druhé přehrání týž hash;
 * dveře výzvy uloží týž výsledek a jejich běh pro ducha se přehraje k témuž hashi. Hra bez specu nebo s kostrou
 * modulu je `it.skip` s důvodem v názvu – dokud kategorie hru nedodá, přeskakuje se všech pět. Proto totéž kolo jede
 * i na ručním specu P66 (kontrola): pomocník kola tak není ozdobný ani tehdy, když se žádná hra P68 nehraje.
 *
 * Velikost výzvy (platí už dnes, bez her): nejhorší stopa `railfps` (jiná osa z `RAILFPS_AXES` každý tik) a `drawsave`
 * (tah s `HOLD` přes celou mřížku, jiná buňka každý tik) za 5 400 tiků se vejde pod strop těla 64 kB a dveře ji rozbalí.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_BODY_BYTES } from '@/http/body';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, AXIS_MAX, BUTTON, type InputEvent } from '@/play/arcade/contract';
import { worldHasPhysics } from '@/play/arcade/kernel';
import { axisOfCell } from '@/play/arcade/pieces/lanes';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { DRAWSAVE_STROKE, P68_GENRES, P68_MAX_TICKS, RAILFPS_AXES, handSpec } from '@/play/genre/p68-contract';
import { packInputs, unpackInputs } from '@/play/score/dare';
import { scoredReplay } from '@/play/score/replay';
import { readGameSpec } from '@/play/spec';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { POST as createGame } from '../games/route';
import { GET as readGame } from '../games/[id]/route';
import { POST as dare } from '../games/[id]/dare/route';
import { GET as readDare } from '../games/[id]/dare/[dareId]/route';

// Stránka hry mimo Next.js: hlavičky pro bránu, `notFound` jako výjimka a shell bez renderu (vzor `dare-by.test.ts`).
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.68' }) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/components/play/PlayShell', () => ({ PlayShell: () => null }));

const { default: PlayGamePage } = await import('@/app/play/[id]/page');

const CALLER = { 'x-forwarded-for': '203.0.113.69' };
const fixtureOf = (name: string): string => join(process.cwd(), 'e2e', 'fixtures', `${name}-spec.json`);
/** Kontrola kola: ruční spec P66, který se publikuje dnes (šipky – bez fyziky, krátký běh robota). */
const CONTROL = 'p66-arrows';

function post(path: string, body: unknown, headers: Record<string, string> = CALLER): Request {
  return new Request(`http://play.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const params = <P extends Record<string, string>>(value: P): { params: Promise<P> } => ({ params: Promise.resolve(value) });

let callers = 0;
/** Každá výzva z jiné adresy a o půl sekundy později – strop výzev volajícího ani klouzavá sekunda instance tu nesoudí. */
function sendDare(id: string, body: string): Promise<Response> {
  vi.setSystemTime(Date.now() + 500);
  return dare(post(`/api/play/games/${id}/dare`, body, { 'x-forwarded-for': `198.18.68.${String(callers++ % 256)}` }), params({ id }));
}

/**
 * Proč hra kolo ještě nejde: chybí ruční spec, nebo modul (ovládání a generátor hry) svět ze specu nepostaví – hází,
 * nebo vrátí hlášku kostry `modeStub` („is not built yet“). Jiná vada specu se nepřeskočí: kolo pak spadne nahlas.
 * `null` = hra kolo jde.
 */
function blockerOf(name: string): string | null {
  const fixture = fixtureOf(name);
  if (!existsSync(fixture)) return `no hand spec e2e/fixtures/${name}-spec.json yet`;
  try {
    const read = readGameSpec(handSpec(JSON.parse(readFileSync(fixture, 'utf8')) as unknown));
    if (!read.ok) return null;
    const made = arcadeWorldOf(read.value, 1);
    const skeleton = made.ok ? undefined : made.issues.find((issue) => issue.includes('is not built yet'));
    return skeleton === undefined ? null : `the module is still a skeleton (${skeleton})`;
  } catch (thrown) {
    return `the module throws (${thrown instanceof Error ? thrown.message : String(thrown)})`;
  }
}

// Svět s tělesy chce Rapier už při stavbě; bez specu se nestahuje.
if (P68_GENRES.some((genre) => existsSync(fixtureOf(`p68-${genre}`)))) await loadRapier();

/** Celé kolo jedné hry: publikace → týž svět ze sdíleného odkazu → robot → výzva → přehrání. */
async function roundTrip(name: string): Promise<void> {
  const spec = handSpec(JSON.parse(readFileSync(fixtureOf(name), 'utf8')) as unknown);
  const created = await createGame(post('/api/play/games', { spec }));
  expect(created.status, await created.clone().text()).toBeLessThan(300);
  const { versionId: id } = (await created.json()) as { versionId: string };

  // Sdílený odkaz: `GET` dveří i stránka `/play/<id>` nesou tutéž verzi a týž svět.
  const read = await readGame(new Request(`http://play.test/api/play/games/${id}`, { headers: CALLER }), params({ id }));
  expect(read.status).toBe(200);
  const game = (await read.json()) as { spec: unknown; arcade?: ArcadeWorld };
  const world = game.arcade;
  if (world === undefined) throw new Error(`${name}: the published game carries no arcade world`);
  const page = (await PlayGamePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as { props: { children: { props: Record<string, unknown> }[] } };
  const shell = page.props.children.find((child) => 'versionId' in child.props)?.props;
  expect(shell?.versionId).toBe(id);
  expect(JSON.parse(JSON.stringify([shell?.spec, shell?.arcade])) as unknown).toEqual([game.spec, world]);

  // Robot dohraje; jeho vstupy jdou cestou výzvy: zhuštěné běhy → JSON těla → rozbalení na serveru.
  if (worldHasPhysics(world)) await loadRapier();
  const bot = runBot(world);
  expect(bot.outcome).toBe('won');
  const body = JSON.stringify({ inputs: packInputs(bot.inputs) });
  expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES);
  const inputs = unpackInputs((JSON.parse(body) as { inputs: unknown }).inputs);
  if (typeof inputs === 'string') throw new Error(`${name}: ${inputs}`);
  expect(inputs).toEqual(bot.inputs);
  const replayed = scoredReplay(world, inputs, []);
  expect({ outcome: replayed.outcome, score: replayed.score, tick: replayed.tick, hash: replayed.hash }).toEqual({ outcome: bot.outcome, score: bot.score, tick: bot.tick, hash: bot.hash });
  expect(scoredReplay(world, inputs, []).hash).toBe(replayed.hash);

  // Dveře výzvy přehrají totéž tělo samy a uloží týž výsledek; běh pro ducha se přehraje k témuž hashi.
  const response = await sendDare(id, body);
  expect(response.status).toBe(201);
  const answer = (await response.json()) as { dareId: string; score: number; ticks: number };
  expect({ score: answer.score, ticks: answer.ticks }).toEqual({ score: replayed.score, ticks: replayed.tick });
  expect((await versionStoreFromEnv(process.env).getDare(answer.dareId))?.hash).toBe(replayed.hash);
  const ghost = await readDare(new Request(`http://play.test/api/play/games/${id}/dare/${answer.dareId}`, { headers: CALLER }), params({ id, dareId: answer.dareId }));
  const { replay } = (await ghost.json()) as { replay: { inputs: unknown } };
  const ghostInputs = unpackInputs(replay.inputs);
  if (typeof ghostInputs === 'string') throw new Error(`${name}: ghost ${ghostInputs}`);
  expect(scoredReplay(world, ghostInputs, []).hash).toBe(replayed.hash);
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
  // Sada běží s `VERCEL_ENV=production` (vitest.config) a tam stráž R1/R3 ruční spec nezapojené hry odmítne (422).
  // Kolo hry před zapojením je místní / preview běh kategorie – ten stráž pouští; jeden proces dál doložený.
  vi.stubEnv('VERCEL_ENV', 'preview');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P68 games: share, Dare and replay round trip (T6)', () => {
  for (const genre of P68_GENRES) {
    const blocker = blockerOf(`p68-${genre}`);
    if (blocker !== null) it.skip(`${genre}: skipped – ${blocker}`, () => {});
    else it(`${genre}: the shared link, the Dare door and two replays agree on outcome, score and end hash`, () => roundTrip(`p68-${genre}`), 180_000);
  }

  it(`the same round trip holds on a P66 hand spec (${CONTROL}), so it is not decorative while all P68 games skip`, () => roundTrip(CONTROL), 180_000);
});

describe('Dare body size of the worst P68 traces (T6)', () => {
  const ticks = Array.from({ length: P68_MAX_TICKS }, (_, tick) => tick);
  /** Dvě hodnoty `RAILFPS_AXES` s nejdelším zápisem v JSON (−1000, −937): střídané každý tik nikdy nesplynou do běhu. */
  const [longest, second] = [...RAILFPS_AXES].sort((a, b) => String(b).length - String(a).length) as [number, number];
  /**
   * Natáčení každý tik a k tomu ťuk `FIRE` (`session.press`, padne do jednoho tiku) každý druhý tik – 30 ran za
   * sekundu, víc, než ťukne prst nebo zopakuje klávesa. `FIRE` v každém tiku je níž: nad stropem.
   */
  const railfps = (fireEvery: number): InputEvent[] => ticks.map((tick) => ({ tick, buttons: tick % fireEvery === 0 ? BUTTON.FIRE : 0, axis: tick % 2 === 0 ? longest : second }));
  /** Největší mřížka, kterou osa unese (`axisOfCell(buňka) ≤ AXIS_MAX`, 1 000 buněk): tah tam a zpět přes všechny, `HOLD` celou dobu. */
  const cells = AXIS_MAX;
  const drawsave: InputEvent[] = ticks.map((tick) => {
    const at = tick % (2 * cells - 2);
    return { tick, buttons: BUTTON[DRAWSAVE_STROKE.hold], axis: axisOfCell(at < cells ? at : 2 * cells - 2 - at) };
  });
  /** Tělo, jak ho pošle `ShareButton`: vstupy, živé změny a výzva, kterou běh poráží. */
  const bodyOf = (trace: readonly InputEvent[]): string => JSON.stringify({ inputs: packInputs(trace), patches: [], against: 'a'.repeat(32) });
  /** Neznámá hra: dveře tělo přečtou a rozbalí (jinak 413 nebo 400) a teprve pak hru nenajdou (404). */
  const UNKNOWN = '0123456789abcdef';

  it.each([
    ['railfps', railfps(2)],
    ['drawsave', drawsave],
  ])('%s: a 5 400-tick worst trace is a new run every tick, packs under 64 kB and the Dare door unpacks it', async (_game, trace) => {
    expect(packInputs(trace)).toHaveLength(4 * P68_MAX_TICKS);
    const body = bodyOf(trace);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES);
    expect(unpackInputs((JSON.parse(body) as { inputs: unknown }).inputs)).toEqual(trace);
    const response = await sendDare(UNKNOWN, body);
    expect(response.status, await response.clone().text()).toBe(404);
  });

  it('the cap is real: railfps turning and firing on every tick is over 64 kB and the door refuses it (413)', async () => {
    const body = bodyOf(railfps(1));
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_BODY_BYTES);
    const response = await sendDare(UNKNOWN, body);
    expect(response.status).toBe(413);
  });
});
