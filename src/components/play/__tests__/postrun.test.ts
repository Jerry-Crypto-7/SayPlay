import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostRun, type RunFacts, retryKey, runResult } from '../PostRun';
import type { RemixJob } from '../RemixBox';

/**
 * Výsledek (P34 T6, dřív karta P33 T4) má právě jednu hlavní akci: po výhře
 * „Dare a friend to beat it“, po prohře „Try again“ a Dare mezi papírovými.
 * Dvě stejně výrazná tlačítka vypadají na snímku v pořádku a hráč stejně
 * neví, co zmáčknout – proto se hlavní akce počítají, ne prohlížejí.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

const job: RemixJob = { view: { kind: 'idle' }, sent: '', submit: () => undefined };

const facts = (won: boolean): RunFacts => ({
  won,
  tick: 246,
  hz: 20,
  survive: false,
  goal: { count: won ? 5 : 3, need: 5, label: 'collected' },
  extra: [{ value: '0', label: 'times caught' }],
});

const card = (won: boolean, clip: Blob | null = null) =>
  renderToStaticMarkup(createElement(PostRun, { versionId: 'v1', remix: job, facts: facts(won), clip, onReplay: () => undefined }));

const primaries = (markup: string): string[] => markup.match(/<[^>]*data-variant="primary"[^>]*>/g) ?? [];

describe('PostRun', () => {
  it('after a win has exactly one primary action, and it is Dare a friend to beat it', () => {
    for (const markup of [card(true), card(true, new Blob(['clip'], { type: 'video/webm' }))]) {
      expect(primaries(markup)).toHaveLength(1);
      expect(primaries(markup)[0]).toContain('data-testid="play-share"');
    }
    expect(card(true)).toMatch(/data-testid="play-share"[^>]*>Dare a friend to beat it</);
    expect(card(true)).toMatch(/data-variant="secondary"[^>]*data-testid="play-replay"[^>]*>Play again</);
  });

  it('after a loss swaps the primary action to Try again and moves Dare among the secondary ones', () => {
    const markup = card(false);
    expect(primaries(markup)).toHaveLength(1);
    expect(primaries(markup)[0]).toContain('data-testid="play-replay"');
    expect(markup).toMatch(/data-testid="play-replay"[^>]*>Try again</);
    expect(markup).toMatch(/data-variant="secondary"[^>]*data-testid="play-share"[^>]*>Dare a friend</);
    expect(markup).toContain('>So close.<');
    expect(markup).not.toContain('data-testid="play-badge"');
  });

  it('keeps the change field behind Remix it until the player asks for it', () => {
    const markup = card(true);
    expect(markup).toContain('>Remix it<');
    expect(markup).not.toContain('data-testid="remix-box"');
  });

  it('shows only the numbers the run has, time always last', () => {
    expect(runResult(facts(true)).stats).toEqual([
      { value: '5/5', label: 'collected' },
      { value: '0', label: 'times caught' },
      { value: '12.3s', label: 'time' },
    ]);
    expect(runResult({ ...facts(true), goal: null, extra: [] }).stats).toEqual([{ value: '12.3s', label: 'time' }]);
  });
});

/** Node nemá DOM: cíl klávesy pozná `isTyping`, tlačítko i otevřený list podle `HTMLElement` a `closest`. */
class Element {
  readonly isContentEditable = false;
  constructor(private readonly within: readonly string[]) {}
  closest(selector: string): object | null {
    return selector.split(',').some((part) => this.within.includes(part.trim())) ? {} : null;
  }
}

describe('retry keys on the result (P36B T3)', () => {
  beforeEach(() => vi.stubGlobal('HTMLElement', Element));
  afterEach(() => vi.unstubAllGlobals());

  const key = (value: string, within: readonly string[] = [], extra: Partial<KeyboardEvent> = {}) =>
    retryKey({ key: value, repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: new Element(within) as unknown as EventTarget, ...extra });

  it('R, Space and Enter start a new run', () => {
    expect(key('r')).toBe(true);
    expect(key('R')).toBe(true);
    expect(key(' ')).toBe(true);
    expect(key('Enter')).toBe(true);
    expect(key('x')).toBe(false);
    expect(key('Escape')).toBe(false);
  });

  it('Space and Enter on a focused button press that button, R still retries', () => {
    expect(key(' ', ['button'])).toBe(false);
    expect(key('Enter', ['a[href]'])).toBe(false);
    expect(key('r', ['button'])).toBe(true);
  });

  it('never while typing, inside an open sheet, held down or with a browser shortcut', () => {
    expect(key('r', ['input'])).toBe(false);
    expect(key('Enter', ['[role="dialog"]'])).toBe(false);
    expect(key('r', [], { repeat: true })).toBe(false);
    expect(key('r', [], { ctrlKey: true })).toBe(false);
    expect(key('r', [], { metaKey: true })).toBe(false);
  });
});
