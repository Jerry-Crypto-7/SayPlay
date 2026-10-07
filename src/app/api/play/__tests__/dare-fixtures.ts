/**
 * Společné kusy testů žebříčku (P44B T5, T6): publikovaná hra se dvěma vítěznými běhy různého hodnocení,
 * hráč s platně podepsanou cookie a výzva poslaná dveřmi `POST …/dare` z nové adresy.
 */

import { vi } from 'vitest';

import { STARTERS } from '@/components/play/starters';
import type { ArcadeWorld, InputEvent } from '@/play/arcade/contract';
import { runBot } from '@/play/arcade/verify';
import { scoredReplay, type ScoredRun } from '@/play/score/replay';
import { bestRank } from '@/play/version';
import { issuePlayer, PLAYER_COOKIE } from '@/server/player-identity';

import { POST as createGame } from '../games/route';
import { GET as readGame } from '../games/[id]/route';
import { POST as dare } from '../games/[id]/dare/route';

export const SECRET = 'FIXTURE_ONLY_NOT_A_REAL_SECRET_0000000000';
export const CALLER = { 'x-forwarded-for': '203.0.113.9' };

let callers = 0;
export const freshCaller = (): Record<string, string> => ({ 'x-forwarded-for': `198.18.${String(Math.floor(callers / 256) % 256)}.${String(callers++ % 256)}` });

export function post(path: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(`http://play.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

export const params = (id: string): { params: Promise<{ id: string }> } => ({ params: Promise.resolve({ id }) });

export interface Sent {
  readonly status: number;
  readonly setCookie: string | null;
  readonly text: string;
  readonly body: { dareId: string; score: number; ticks: number; board: { place: number; of: number } | null; beat: boolean | null };
}

/** Výzva o půl sekundy později (klouzavé okno instance), z nové adresy, s cookie nebo bez. */
export async function send(id: string, body: unknown, cookie?: string): Promise<Sent> {
  vi.setSystemTime(Date.now() + 500);
  const response = await dare(post(`/api/play/games/${id}/dare`, body, { ...freshCaller(), ...(cookie === undefined ? {} : { cookie }) }), params(id));
  const text = await response.text();
  return { status: response.status, setCookie: response.headers.get('set-cookie'), text, body: JSON.parse(text) as Sent['body'] };
}

/** Hráč s platně podepsanou cookie. */
export function player(): { id: string; cookie: string } {
  const { id, value } = issuePlayer(SECRET);
  return { id, cookie: `${PLAYER_COOKIE}=${value}` };
}

const shifted = (inputs: readonly InputEvent[], by: number): InputEvent[] => inputs.map((event) => ({ ...event, tick: event.tick + by }));

export interface Runs {
  readonly better: { readonly inputs: InputEvent[]; readonly run: ScoredRun };
  readonly worse: { readonly inputs: InputEvent[]; readonly run: ScoredRun };
}

/** Dva vítězné běhy téže hry s různým hodnocením: robot a robot, který začne o chvíli později. */
function twoRuns(world: ArcadeWorld): Runs | null {
  const bot = runBot(world).inputs;
  const won = [0, 10, 20, 40, 60, 90]
    .map((by) => ({ inputs: shifted(bot, by), run: scoredReplay(world, shifted(bot, by), []) }))
    .filter(({ run }) => run.outcome === 'won' && run.refusedPatch === null)
    .sort((a, b) => bestRank(b.run.score, b.run.tick) - bestRank(a.run.score, a.run.tick));
  const [better, ...rest] = won;
  const worse = rest.find(({ run }) => better !== undefined && bestRank(run.score, run.tick) < bestRank(better.run.score, better.run.tick));
  return better === undefined || worse === undefined ? null : { better, worse };
}

export async function publishedGame(): Promise<{ id: string; runs: Runs }> {
  for (const { sentence } of STARTERS) {
    const created = await createGame(post('/api/play/games', { sentence }, CALLER));
    const { versionId } = (await created.json()) as { versionId: string };
    const read = await readGame(new Request(`http://play.test/api/play/games/${versionId}`, { headers: CALLER }), params(versionId));
    const world = ((await read.json()) as { arcade?: ArcadeWorld }).arcade;
    const runs = world === undefined ? null : twoRuns(world);
    if (runs !== null) return { id: versionId, runs };
  }
  throw new Error('no starter game has two winning runs of different rank');
}
