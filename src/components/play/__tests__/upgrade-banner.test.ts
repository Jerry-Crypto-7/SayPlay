/**
 * Co proužek AI verze řekne (P27C T2): věta pro každý stav, nejvýš jedna akce,
 * `Try again` jen tam, kde nový pokus může dopadnout jinak – stejně jako
 * serverový `isTransient`, jinak by tlačítko slibovalo, co server neudělá.
 */

import { describe, expect, it } from 'vitest';

import { type DraftFinalReason, isTransient } from '@/app/api/play/_upgrade';

import { COMMITTED_MS, committedNow, FINAL_REASON_TEXT, noticeOf, readingMove, type UpgradeView } from '../UpgradeBanner';

const REASONS = Object.keys(FINAL_REASON_TEXT) as DraftFinalReason[];

// P58D T3: hra ze čtení přijde ~3 s po větě; kdo ještě nehraje, přejde sám, rozehranou hru nikdo nevymění.
describe('readingMove', () => {
  const quick = 'q'.repeat(32);
  const reading = 'r'.repeat(32);
  const working = (more: Partial<Extract<UpgradeView, { kind: 'working' }>> = {}): UpgradeView => ({ kind: 'working', since: 0, deadlineAt: 285_000, ...more });

  it('auto přechod před vstupem i v prvních sekundách hraní', () => {
    expect(readingMove(working({ reading }), quick, committedNow(0, false), new Set())).toEqual({ kind: 'switch', versionId: reading });
    expect(readingMove(working({ reading }), quick, committedNow((COMMITTED_MS - 1) / 1000, false), new Set())).toEqual({ kind: 'switch', versionId: reading });
  });

  it('nabídka po 6 s hraní, po výhře i po prohře', () => {
    expect(readingMove(working({ reading }), quick, committedNow(COMMITTED_MS / 1000, false), new Set())).toEqual({ kind: 'offer', versionId: reading });
    expect(readingMove(working({ reading }), quick, committedNow(2, true), new Set())).toEqual({ kind: 'offer', versionId: reading });
  });

  it('hráč, který se z hry ze čtení vrátil na rychlou, už jen dostane nabídku', () => {
    expect(readingMove(working({ reading }), quick, false, new Set([reading]))).toEqual({ kind: 'offer', versionId: reading });
  });

  it('bez čtení, na hře ze čtení samé a mimo práci nic', () => {
    expect(readingMove(working(), quick, false, new Set())).toBeNull();
    expect(readingMove(working({ reading }), reading, false, new Set())).toBeNull();
    expect(readingMove({ kind: 'ready', versionId: 'a'.repeat(32) }, quick, false, new Set())).toBeNull();
    expect(readingMove({ kind: 'final', reason: 'UNCHANGED' }, quick, false, new Set())).toBeNull();
  });
});

describe('noticeOf', () => {
  it('an unchanged upgrade never claims all requested actions are present', () => {
    expect(noticeOf({ kind: 'final', reason: 'UNCHANGED' })?.text).toBe("The full-detail version didn't add more. Keep playing the quick one.");
  });
  it('idle nic neukáže', () => {
    expect(noticeOf({ kind: 'idle' })).toBeNull();
  });

  // P34 T4: pilulka kitu místo počítadla sekund – kromě pulzující tečky se nic nehýbe samo (`09-motion.md`).
  it('working řekne větu kitu, bez sekund, procent a akce', () => {
    const notice = noticeOf({ kind: 'working', since: 10_000, deadlineAt: 295_000 });
    expect(notice?.text).toBe('Quick version · the full-detail one is on its way');
    expect(notice?.text).not.toMatch(/%|\d/);
    expect(notice?.action).toBeNull();
  });

  it('ready řekne název hry a nabídne Play it (P28D T7, P34 T4)', () => {
    expect(noticeOf({ kind: 'ready', versionId: 'a'.repeat(32) }, 'Knight Rides Dragon')).toEqual({ text: 'Full-detail version ready: “Knight Rides Dragon”', action: { kind: 'open', label: 'Play it' } });
    // Než název dorazí (nebo když nedorazí), toast nečeká.
    expect(noticeOf({ kind: 'ready', versionId: 'a'.repeat(32) })).toEqual({ text: 'Full-detail version ready', action: { kind: 'open', label: 'Play it' } });
  });

  it('všech 10 důvodů má vlastní větu', () => {
    expect(REASONS).toHaveLength(11);
    expect(REASONS).toContain('ACTION_LOST');
    expect(new Set(REASONS.map((reason) => FINAL_REASON_TEXT[reason])).size).toBe(11);
    expect(noticeOf({ kind: 'final', reason: 'MODEL_UNAVAILABLE' })?.text).toContain("Couldn't make the full-detail version right now");
    expect(noticeOf({ kind: 'final', reason: 'NOT_PLAYABLE' })?.text).toBe("The full-detail version wasn't playable in a test run. The quick one stays.");
  });

  it('neúspěch nikoho neobviňuje (P33 T5)', () => {
    for (const reason of REASONS) expect(FINAL_REASON_TEXT[reason]).not.toMatch(/mistake|could not read|failed/i);
  });

  it.each(REASONS)('Try again u %s právě když je důvod přechodný', (reason) => {
    const retry = noticeOf({ kind: 'final', reason })?.action?.kind === 'retry';
    expect(retry).toBe(isTransient({ status: 'draft-final', reason }) && reason !== 'NOT_FROM_SENTENCE');
  });

  it('offline i lost nabídnou Check again', () => {
    for (const kind of ['offline', 'lost'] as const) {
      expect(noticeOf({ kind })).toEqual({ text: 'We lost track of the full-detail version.', action: { kind: 'retry', label: 'Check again' } });
    }
  });
});
