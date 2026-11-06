/**
 * Sledování AI verze (P27C T1): klient se ptá do lhůty serveru (`deadlineAt`),
 * ne do pevných 90 s. Hodiny i `fetch` řídí test – server tu je jen scénář,
 * co odpoví v kterou sekundu.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { followUpgrade, OFFLINE_POLL_MS, POLL_MS, type UpgradeView } from '../UpgradeBanner';

const T0 = Date.parse('2026-09-24T12:00:00.000Z');
/** Lhůta, jakou server řekne práci začaté v T0: 270 s rozpočtu + 15 s. */
const DEADLINE = T0 + 285_000;

type Reply = Record<string, unknown> | 'network' | number;

/** `script(elapsedMs, url)` říká, co server odpoví; `calls` počítá dotazy na adresu. */
function serve(script: (elapsed: number, url: string) => Reply, latencyMs = 0): { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  vi.stubGlobal('fetch', async (url: string, init: { signal: AbortSignal }) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const reply = script(Date.now() - T0, url);
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (reply === 'network') throw new TypeError('Failed to fetch');
    if (typeof reply === 'number') return new Response('{}', { status: reply });
    return Response.json(reply);
  });
  return { calls };
}

const pending = { status: 'pending', deadlineAt: new Date(DEADLINE).toISOString() };

function follow(url = '/api/play/games/a/upgrade'): { views: UpgradeView[]; stop: () => void; last: () => UpgradeView } {
  const views: UpgradeView[] = [];
  const stop = followUpgrade(url, (view) => views.push(view));
  return { views, stop, last: () => views[views.length - 1] };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('followUpgrade', () => {
  it('pending → ready', async () => {
    serve((elapsed) => (elapsed < 10_000 ? pending : { status: 'ready', versionId: 'b'.repeat(32) }));
    const run = follow();
    expect(run.last()).toMatchObject({ kind: 'working', since: T0 });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(run.last()).toEqual({ kind: 'working', since: T0, deadlineAt: DEADLINE });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.last()).toEqual({ kind: 'ready', versionId: 'b'.repeat(32) });
    run.stop();
  });

  // P58D T3: hra ze čtení přijde v `pending` dřív než AI verze; ta pak přijde stejně jako dnes.
  it('pending → pending s hrou ze čtení → ready', async () => {
    const reading = 'd'.repeat(32);
    serve((elapsed) => (elapsed < 3_000 ? pending : elapsed < 30_000 ? { ...pending, reading: { versionId: reading } } : { status: 'ready', versionId: 'b'.repeat(32) }));
    const run = follow();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(run.last()).toEqual({ kind: 'working', since: T0, deadlineAt: DEADLINE });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(run.last()).toEqual({ kind: 'working', since: T0, deadlineAt: DEADLINE, reading });
    const heard = run.views.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(run.views).toHaveLength(heard);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.last()).toEqual({ kind: 'ready', versionId: 'b'.repeat(32) });
    run.stop();
  });

  // P73C T2: kroky režie přibývají; odpověď bez nich (jiná instance) známé nezapomene, nečitelné vypadnou.
  it('pending s kroky režie → kroky jen přibývají', async () => {
    const steps = ['Reading your idea…', 'Hero: turtle'];
    serve((elapsed) => (elapsed < 3_000 ? { ...pending, steps: [steps[0], 42, 'x'.repeat(200)] } : elapsed < 5_000 ? { ...pending, steps } : pending));
    const run = follow();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(run.last()).toEqual({ kind: 'working', since: T0, deadlineAt: DEADLINE, steps: [steps[0]] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(run.last()).toEqual({ kind: 'working', since: T0, deadlineAt: DEADLINE, steps });
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(run.last()).toEqual({ kind: 'working', since: T0, deadlineAt: DEADLINE, steps });
    run.stop();
  });

  it('nečitelné čtení se nepočítá', async () => {
    serve(() => ({ ...pending, reading: { versionId: '../evil' } }));
    const run = follow();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(run.last()).toEqual({ kind: 'working', since: T0, deadlineAt: DEADLINE });
    run.stop();
  });

  it('pending → draft-final nese důvod', async () => {
    serve((elapsed) => (elapsed < 6_000 ? pending : { status: 'draft-final', reason: 'NOT_PLAYABLE' }));
    const run = follow();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run.last()).toEqual({ kind: 'final', reason: 'NOT_PLAYABLE' });
    run.stop();
  });

  it('ready po 150 s: lhůta serveru, ne pevných 90 s', async () => {
    serve((elapsed) => (elapsed < 150_000 ? pending : { status: 'ready', versionId: 'c'.repeat(32) }));
    const run = follow();
    await vi.advanceTimersByTimeAsync(160_000);
    expect(run.views.map((view) => view.kind)).not.toContain('lost');
    expect(run.last()).toEqual({ kind: 'ready', versionId: 'c'.repeat(32) });
    run.stop();
  });

  it('tři chyby po sobě = offline, ptá se dál řidčeji a po obnově zase working', async () => {
    const { calls } = serve((elapsed) => (elapsed < 40_000 ? (elapsed < 5_000 ? 503 : 'network') : pending));
    const run = follow();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(run.last()).toEqual({ kind: 'offline' });
    const before = calls.get('/api/play/games/a/upgrade') ?? 0;
    await vi.advanceTimersByTimeAsync(OFFLINE_POLL_MS - 1);
    expect(calls.get('/api/play/games/a/upgrade')).toBe(before);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(run.last()).toEqual({ kind: 'working', since: T0, deadlineAt: DEADLINE });
    run.stop();
  });

  it('lhůta vyprší bez výsledku = lost a dotazy skončí', async () => {
    const { calls } = serve(() => pending);
    const run = follow();
    await vi.advanceTimersByTimeAsync(290_000);
    expect(run.last()).toEqual({ kind: 'lost' });
    const asked = calls.get('/api/play/games/a/upgrade');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.get('/api/play/games/a/upgrade')).toBe(asked);
  });

  it('výpadek přes celou lhůtu skončí lost, ne věčným offline', async () => {
    serve(() => 'network');
    const run = follow();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run.last()).toEqual({ kind: 'lost' });
  });

  it('přepnutí na jinou hru uprostřed dotazu: stará práce už nic nehlásí ani se neptá', async () => {
    // Server odpovídá za 1,5 s, takže přepnutí v 6. s zastihne dotaz z 5,5. s v letu.
    const { calls } = serve((elapsed, url) => (url.includes('/a/') && elapsed >= 4_000 ? { status: 'ready', versionId: 'a'.repeat(32) } : pending), 1_500);
    const first = follow('/api/play/games/a/upgrade');
    await vi.advanceTimersByTimeAsync(6_000);
    const heard = first.views.length;
    first.stop();
    const second = follow('/api/play/games/b/upgrade');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(first.views).toHaveLength(heard);
    expect(first.views.map((view) => view.kind)).not.toContain('ready');
    expect(second.views.map((view) => view.kind)).not.toContain('ready');
    expect(calls.get('/api/play/games/a/upgrade')).toBe(2);
    second.stop();
  });
});
