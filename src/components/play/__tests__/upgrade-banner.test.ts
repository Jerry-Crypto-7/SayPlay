/**
 * Co proužek AI verze řekne (P27C T2): věta pro každý stav, nejvýš jedna akce,
 * `Try again` jen tam, kde nový pokus může dopadnout jinak – stejně jako
 * serverový `isTransient`, jinak by tlačítko slibovalo, co server neudělá.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type DraftFinalReason, isTransient } from '@/app/api/play/_upgrade';

import { chainSwitchOf, committedNow, FINAL_REASON_TEXT, followUpgrade, noticeOf, POLL_MS, QUIET_END, readingMove, type UpgradeView } from '../UpgradeBanner';

const REASONS = Object.keys(FINAL_REASON_TEXT) as DraftFinalReason[];

// P58D T3: hra ze čtení přijde ~3 s po větě; kdo ještě nehraje, přejde sám, rozehranou hru nikdo nevymění.
describe('readingMove', () => {
  const quick = 'q'.repeat(32);
  const reading = 'r'.repeat(32);
  const working = (more: Partial<Extract<UpgradeView, { kind: 'working' }>> = {}): UpgradeView => ({ kind: 'working', since: 0, deadlineAt: 285_000, ...more });

  it('auto přechod jen do prvního dotyku (hodiny hry stojí na nule)', () => {
    expect(readingMove(working({ reading }), quick, committedNow(0, false), new Set())).toEqual({ kind: 'switch', versionId: reading });
  });

  // P70A T2: dřív přepnulo i v prvních 6 s hraní – hráči se hra vyměnila pod rukama.
  it('nabídka hned po prvním dotyku, po výhře i po prohře', () => {
    expect(readingMove(working({ reading }), quick, committedNow(1 / 60, false), new Set())).toEqual({ kind: 'offer', versionId: reading });
    expect(readingMove(working({ reading }), quick, committedNow(5.9, false), new Set())).toEqual({ kind: 'offer', versionId: reading });
    expect(readingMove(working({ reading }), quick, committedNow(0, true), new Set())).toEqual({ kind: 'offer', versionId: reading });
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

// P58E T3: řetěz skončí `CHAIN` hned po čtení a hru ze čtení nese až konec – přechod je týž jako v P58D.
describe('a chain and its reading game', () => {
  const chain = 'c'.repeat(32);
  const reading = 'r'.repeat(32);
  const chainEnd = (more: { reading?: string } = {}): UpgradeView => ({ kind: 'final', reason: 'CHAIN', ...more });

  it('the chain page moves to the reading game the end names, or offers it after six seconds of play', () => {
    expect(readingMove(chainEnd({ reading }), chain, false, new Set())).toEqual({ kind: 'switch', versionId: reading });
    const offered = readingMove(chainEnd({ reading }), chain, true, new Set());
    expect(offered).toEqual({ kind: 'offer', versionId: reading });
    expect(chainSwitchOf(offered, null)).toEqual({ offer: reading });
  });

  it('the chain page shows nothing while the reading is out and when the reading kept the chain', () => {
    expect(chainSwitchOf(readingMove({ kind: 'working', since: 0, deadlineAt: 285_000 }, chain, true, new Set()), null)).toBeNull();
    expect(chainSwitchOf(readingMove(chainEnd(), chain, true, new Set()), null)).toBeNull();
  });

  it('the reading game of a chain keeps its switch, with Quick back to the chain and nothing offered', () => {
    expect(chainSwitchOf(readingMove(chainEnd({ reading }), reading, false, new Set()), chain)).toEqual({ offer: null });
  });

  it('a chain end offers no Try again', () => {
    expect(noticeOf(chainEnd())?.action).toBeNull();
  });
});

describe('followUpgrade', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function viewsOf(answers: readonly unknown[]): Promise<UpgradeView[]> {
    vi.useFakeTimers();
    const queue = [...answers];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(queue.shift()))));
    const views: UpgradeView[] = [];
    const stop = followUpgrade('/api/play/games/x/upgrade', (view) => views.push(view));
    for (let poll = 0; poll < answers.length; poll += 1) await vi.advanceTimersByTimeAsync(POLL_MS);
    stop();
    return views;
  }

  // Id z odpovědi serveru projde jen tvarem hex (`readingOf`).
  const reading = 'b'.repeat(32);
  const deadlineAt = new Date(Date.now() + 285_000).toISOString();

  it('keeps the reading game a chain end names, and the end is CHAIN, not FAILED', async () => {
    expect((await viewsOf([{ status: 'draft-final', reason: 'CHAIN', reading: { versionId: reading } }])).at(-1)).toEqual({ kind: 'final', reason: 'CHAIN', reading });
  });

  it('an AI-version end after a pending reading carries no reading: the quick page does not move on a failure (P58D)', async () => {
    const views = await viewsOf([{ status: 'pending', deadlineAt, reading: { versionId: reading } }, { status: 'draft-final', reason: 'MODEL_UNAVAILABLE' }]);
    expect(views.at(-1)).toEqual({ kind: 'final', reason: 'MODEL_UNAVAILABLE' });
  });
});

describe('noticeOf', () => {
  it('an unchanged upgrade never claims all requested actions are present', () => {
    expect(noticeOf({ kind: 'final', reason: 'UNCHANGED' })?.text).toBe(QUIET_END);
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

  // P83B T3: porotce viděl „came back garbled“ u hratelné hry. Každý chybový kód má jednu neutrální větu; vlastní
  // mají jen hry, ke kterým AI verze z principu není (P58E T1 přidal `CHAIN`).
  const BY_DESIGN: readonly DraftFinalReason[] = ['NOT_FROM_SENTENCE', 'CHAIN'];
  it.each(REASONS.filter((reason) => !BY_DESIGN.includes(reason)))('chybový kód %s řekne jen neutrální větu', (reason) => {
    expect(noticeOf({ kind: 'final', reason })?.text).toBe(QUIET_END);
  });

  it('jen hry bez AI verze z principu řeknou proč', () => {
    expect(REASONS).toHaveLength(12);
    for (const reason of BY_DESIGN) expect(FINAL_REASON_TEXT[reason]).toMatch(/no full-detail version/);
  });

  it('neúspěch nikoho neobviňuje ani neříká, co se pokazilo (P33 T5, P83B T3)', () => {
    for (const reason of REASONS) expect(FINAL_REASON_TEXT[reason]).not.toMatch(/mistake|could not read|failed|garbled|couldn't|can't|lost|test run|checks/i);
  });

  it.each(REASONS)('Try again u %s právě když je důvod přechodný', (reason) => {
    const retry = noticeOf({ kind: 'final', reason })?.action?.kind === 'retry';
    expect(retry).toBe(isTransient({ status: 'draft-final', reason }) && reason !== 'NOT_FROM_SENTENCE');
  });

  it('offline nabídne Check again', () => {
    expect(noticeOf({ kind: 'offline' })).toEqual({ text: 'We lost track of the full-detail version.', action: { kind: 'retry', label: 'Check again' } });
  });

  it('po stropu (lost) řádek zmizí – žádná hláška ani akce (P83B T3)', () => {
    expect(noticeOf({ kind: 'lost' })).toBeNull();
  });
});
