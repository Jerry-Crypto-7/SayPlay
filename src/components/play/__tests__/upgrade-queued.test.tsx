/**
 * Čekání ve frontě režiséra (P53 T3): `pending` s `queued` je pořád práce, ne
 * chyba – proužek řekne pořadí, rychlá verze se hraje dál a po odchodu z fronty
 * se stav vrátí k dnešní větě. Hodiny i `fetch` řídí test, server je scénář.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { followRemix, type RemixView } from '../RemixBox';
import { FINAL_REASON_TEXT, followUpgrade, noticeOf, POLL_MS, type UpgradeView } from '../UpgradeBanner';

const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const DEADLINE = T0 + 285_000;
const deadlineAt = new Date(DEADLINE).toISOString();

/** `script(elapsedMs)` říká, co server odpoví v kterou chvíli. */
function serve(script: (elapsed: number) => Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () => Response.json(script(Date.now() - T0)));
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('followUpgrade with a queued director call', () => {
  it('reports the place in line, drops it once the call has a slot, then the ready version', async () => {
    serve((elapsed) => {
      if (elapsed < 4_000) return { status: 'pending', deadlineAt, queued: 2 };
      if (elapsed < 6_000) return { status: 'pending', deadlineAt, queued: 1 };
      if (elapsed < 10_000) return { status: 'pending', deadlineAt };
      return { status: 'ready', versionId: 'b'.repeat(32) };
    });
    const views: UpgradeView[] = [];
    const stop = followUpgrade('/api/play/games/a/upgrade', (view) => views.push(view));
    await vi.advanceTimersByTimeAsync(12_000);
    stop();
    expect(views).toEqual([
      { kind: 'working', since: T0, deadlineAt: T0 + 285_000 },
      { kind: 'working', since: T0, deadlineAt: DEADLINE, queued: 2 },
      { kind: 'working', since: T0, deadlineAt: DEADLINE, queued: 1 },
      { kind: 'working', since: T0, deadlineAt: DEADLINE },
      { kind: 'ready', versionId: 'b'.repeat(32) },
    ]);
  });

  it('ignores a place in line it cannot read', async () => {
    let queued: unknown = 0;
    serve(() => ({ status: 'pending', deadlineAt, queued }));
    const views: UpgradeView[] = [];
    const stop = followUpgrade('/api/play/games/a/upgrade', (view) => views.push(view));
    for (const junk of [0, '2', 1.5, -1, null]) {
      queued = junk;
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    stop();
    expect(views.every((view) => view.kind === 'working' && view.queued === undefined)).toBe(true);
  });
});

describe('noticeOf a queued upgrade', () => {
  it('says the place in line as the kit sentence, with a short visible note and no action', () => {
    expect(noticeOf({ kind: 'working', since: T0, deadlineAt: DEADLINE, queued: 1 })).toEqual({
      text: 'Quick version · the full-detail one is next in line',
      action: null,
      note: 'Next in line',
    });
    expect(noticeOf({ kind: 'working', since: T0, deadlineAt: DEADLINE, queued: 3 })).toMatchObject({ text: 'Quick version · the full-detail one is #3 in line', note: '#3 in line' });
  });

  it('reads as waiting, never as one of the failure sentences', () => {
    const text = noticeOf({ kind: 'working', since: T0, deadlineAt: DEADLINE, queued: 2 })?.text ?? '';
    expect(Object.values(FINAL_REASON_TEXT)).not.toContain(text);
    expect(text).not.toMatch(/couldn't|lost|busy|error/i);
  });

  it('without a place in line keeps today’s sentence and no note', () => {
    expect(noticeOf({ kind: 'working', since: T0, deadlineAt: DEADLINE })).toEqual({ text: 'Quick version · the full-detail one is on its way', action: null });
  });
});

describe('followRemix with a queued director call', () => {
  it('reports the place in line, drops it on leaving the queue, then the ready remix', async () => {
    serve((elapsed) => {
      if (elapsed < 4_000) return { status: 'pending', job: 'j', deadlineAt, queued: 1 };
      if (elapsed < 8_000) return { status: 'pending', job: 'j', deadlineAt };
      return { status: 'ready', versionId: 'c'.repeat(32), changed: ['faster'] };
    });
    const views: RemixView[] = [];
    const stop = followRemix('/api/play/games/a/remix?job=j', T0, DEADLINE, (view) => views.push(view));
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    expect(views).toEqual([
      { kind: 'working', since: T0, queued: 1 },
      { kind: 'working', since: T0 },
      { kind: 'ready', versionId: 'c'.repeat(32), changed: ['faster'] },
    ]);
  });
});
