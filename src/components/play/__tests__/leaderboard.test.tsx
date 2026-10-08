/**
 * Žebříček po výhře a v listu „About this game“ (P44B T9). „You beat Ada!“ smí stát jen na
 * `beat: true`, které vrátil server po přehrání běhu – jinak by prohra vypadala jako výhra.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type BoardRow, dareResult, fetchBoard, rememberDare } from '../board-client';
import type { RunFacts } from '../PostRun';
import type { RemixJob } from '../RemixBox';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

const { BoardList } = await import('../Leaderboard');
const { PostRun } = await import('../PostRun');
const { publishDare } = await import('../ShareButton');

const row = (place: number, nickname: string, you = false, score = 3000 - place * 100): BoardRow => ({ place, nickname, score, ticks: 600 + place, dareId: String(place).repeat(32), you });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BoardList', () => {
  it('shows at most the limit, highlights your own row, and says where you stand', () => {
    const rows = [row(1, 'Bo'), row(2, 'Ada', true), row(3, 'Cy'), row(4, 'Di'), row(5, 'Ed'), row(6, 'Fa')];
    const html = renderToStaticMarkup(createElement(BoardList, { rows, limit: 5, standing: { place: 2, of: 3 } }));
    expect(html.match(/data-testid="play-board-row"/g)).toHaveLength(5);
    expect(html).not.toContain('Fa');
    expect(html).toMatch(/class="[^"]*play-board-row--you[^"]*"[^>]*>(?:(?!<\/li>).)*Ada/);
    expect(html.match(/play-board-row--you/g)).toHaveLength(1);
    expect(html).toContain('You&#x27;re #2 of 3');
    expect(html).toContain('2,800');
    expect(html).not.toMatch(/#[0-9a-f]{6}\b/i);
  });

  it('shows a run without points by its time, like the dare goal', () => {
    const html = renderToStaticMarkup(createElement(BoardList, { rows: [{ ...row(1, 'Bo'), score: 0, ticks: 1860 }], limit: 5, standing: null }));
    expect(html).toContain('31.0s');
  });

  it('invites the first win on an empty board', () => {
    expect(renderToStaticMarkup(createElement(BoardList, { rows: [], limit: 5, standing: null }))).toContain('No scores yet. Win it and be first.');
  });
});

describe('fetchBoard', () => {
  it('reads the rows; a refused or failed read is null, so the board stays away', async () => {
    const ok = vi.fn(async () => Response.json({ rows: [row(1, 'Bo')] }));
    expect(await fetchBoard('v1', ok as unknown as typeof fetch)).toEqual([row(1, 'Bo')]);
    expect(ok).toHaveBeenCalledWith('/api/play/games/v1/board', expect.anything());
    expect(await fetchBoard('v1', (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchBoard('v1', (async () => Response.json({ nope: 1 })) as unknown as typeof fetch)).toBeNull();
    expect(
      await fetchBoard('v1', (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch),
    ).toBeNull();
  });
});

describe('publishDare', () => {
  it('sends the dare it plays against and keeps the verified { board, beat } by dare id', async () => {
    vi.stubGlobal('window', { location: { search: `?dare=${'a'.repeat(32)}` } });
    const fetcher = vi.fn(async () => Response.json({ dareId: 'd'.repeat(32), score: 2600, ticks: 600, board: { place: 1, of: 2 }, beat: true }, { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await publishDare('v1', [], [])).toBe('d'.repeat(32));
    const sent = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { against?: string };
    expect(sent.against).toBe('a'.repeat(32));
    expect(dareResult('d'.repeat(32))).toEqual({ board: { place: 1, of: 2 }, beat: true });
  });

  it('without a dare in the address sends no against, and a malformed answer keeps nothing it cannot trust', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    const fetcher = vi.fn(async () => Response.json({ dareId: 'e'.repeat(32), board: 'first!', beat: 'yes' }, { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    await publishDare('v1', [], []);
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty('against');
    expect(dareResult('e'.repeat(32))).toEqual({ board: null, beat: null });
  });
});

describe('PostRun after a dare', () => {
  const job: RemixJob = { view: { kind: 'idle' }, sent: '', submit: () => undefined };
  const facts: RunFacts = { won: true, tick: 246, hz: 20, survive: false, goal: { count: 5, need: 5, label: 'collected' }, extra: [] };
  const challenge = { score: 2450, ticks: 1860, liveChanges: 0, by: 'Ada' };
  const card = (dareId: string, by: string | null = 'Ada'): string =>
    renderToStaticMarkup(
      createElement(PostRun, { versionId: 'v1', remix: job, facts, onReplay: () => undefined, dare: { state: 'ready', dareId }, challenge: by === null ? { score: 2450, ticks: 1860, liveChanges: 0 } : { ...challenge, by } }),
    ).replace(/<!-- -->/g, '');

  it('says You beat Ada! only when the server verified the beat', () => {
    rememberDare('1'.repeat(32), { board: { place: 1, of: 2 }, beat: true });
    rememberDare('2'.repeat(32), { board: { place: 2, of: 2 }, beat: false });
    rememberDare('3'.repeat(32), { board: null, beat: null });
    expect(card('1'.repeat(32))).toContain('You beat Ada!');
    expect(card('1'.repeat(32), null)).toContain('You beat your friend!');
    expect(card('2'.repeat(32))).not.toContain('You beat');
    expect(card('3'.repeat(32))).not.toContain('You beat');
    expect(card('9'.repeat(32))).not.toContain('You beat');
  });

  it('keeps exactly one primary action', () => {
    rememberDare('1'.repeat(32), { board: { place: 1, of: 2 }, beat: true });
    expect(card('1'.repeat(32)).match(/<[^>]*data-variant="primary"[^>]*>/g)).toHaveLength(1);
  });
});
