/**
 * Co proužek AI verze řekne (P27C T2): věta pro každý stav, nejvýš jedna akce,
 * `Try again` jen tam, kde nový pokus může dopadnout jinak – stejně jako
 * serverový `isTransient`, jinak by tlačítko slibovalo, co server neudělá.
 */

import { describe, expect, it } from 'vitest';

import { type DraftFinalReason, isTransient } from '@/app/api/play/_upgrade';

import { FINAL_REASON_TEXT, noticeOf } from '../UpgradeBanner';

const REASONS = Object.keys(FINAL_REASON_TEXT) as DraftFinalReason[];

describe('noticeOf', () => {
  it('idle nic neukáže', () => {
    expect(noticeOf({ kind: 'idle' }, 0)).toBeNull();
  });

  it('working ukáže uběhlé sekundy, žádná procenta a žádnou akci', () => {
    const notice = noticeOf({ kind: 'working', since: 10_000, deadlineAt: 295_000 }, 47_900);
    expect(notice?.text).toBe('AI version in progress · 37 s');
    expect(notice?.text).not.toContain('%');
    expect(notice?.action).toBeNull();
  });

  it('ready řekne název hry a nabídne Play AI version (P28D T7, P33 T5)', () => {
    expect(noticeOf({ kind: 'ready', versionId: 'a'.repeat(32) }, 0, 'Knight Rides Dragon')).toEqual({ text: 'AI version ready: “Knight Rides Dragon”', action: { kind: 'open', label: 'Play AI version' } });
    // Než název dorazí (nebo když nedorazí), proužek nečeká.
    expect(noticeOf({ kind: 'ready', versionId: 'a'.repeat(32) }, 0)).toEqual({ text: 'AI version ready', action: { kind: 'open', label: 'Play AI version' } });
  });

  it('všech 9 důvodů má vlastní větu', () => {
    expect(REASONS).toHaveLength(9);
    expect(new Set(REASONS.map((reason) => FINAL_REASON_TEXT[reason])).size).toBe(9);
    expect(noticeOf({ kind: 'final', reason: 'MODEL_UNAVAILABLE' }, 0)?.text).toContain('The AI is busy right now');
    expect(noticeOf({ kind: 'final', reason: 'NOT_PLAYABLE' }, 0)?.text).toBe("The quick version stays – the AI one wasn't playable in our test run.");
  });

  it('neúspěch nikoho neobviňuje (P33 T5)', () => {
    for (const reason of REASONS) expect(FINAL_REASON_TEXT[reason]).not.toMatch(/mistake|could not read|failed/i);
  });

  it.each(REASONS)('Try again u %s právě když je důvod přechodný', (reason) => {
    const retry = noticeOf({ kind: 'final', reason }, 0)?.action?.kind === 'retry';
    expect(retry).toBe(isTransient({ status: 'draft-final', reason }) && reason !== 'NOT_FROM_SENTENCE');
  });

  it('offline i lost nabídnou Check again', () => {
    for (const kind of ['offline', 'lost'] as const) {
      expect(noticeOf({ kind }, 0)).toEqual({ text: 'We lost track of the AI version.', action: { kind: 'retry', label: 'Check again' } });
    }
  });
});
