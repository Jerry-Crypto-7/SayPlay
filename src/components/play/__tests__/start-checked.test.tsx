/**
 * P73B T3: řádek „Checked“ na kartě startu říká jen to, co publikační brána opravdu ověřila (`checkFacts` nad
 * uloženou zprávou), verze bez brány ho nemá a ťuk na něj hru nespustí. Pin: věta, která slibuje kontrolu,
 * jež neproběhla, by na snímku vypadala stejně dobře.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QualityReport } from '@/play/contracts';

import { wakesGame } from '../arcade/ready-gate';
import { checkedLineOf, fairLinesOf } from '../FairSheet';
import { FirstPrompt } from '../FirstPrompt';
import { checkFacts, type ReadFacts } from '../lab';
import { CheckedLine, StartRead } from '../StartRead';

const keypoint = (assertionId: string, passed = true) => ({ assertionId, mechanicId: null, passed, hashBefore: '', hashAfter: '', ticks: 0, failures: [] });

const ARCADE: QualityReport = {
  specHash: 's',
  worldHash: 'w',
  keypoints: ['bot_wins', 'idle_loses', 'replay_equal', 'within_limits'].map((id) => keypoint(id)),
  witness: { certified: true, winsAtTick: 1404 },
  replayEqual: true,
  budgets: { entities: 10, rules: 4, triangles: null },
  publishEligible: true,
};

const GRID: QualityReport = { ...ARCADE, keypoints: [keypoint('collect-3')], witness: { certified: true, winsAtTick: 300 } };

const READ: ReadFacts = { authorship: 'draft', readBy: 'keywords', sentence: null, game: 'Runner', world: 'city · sunny', place: 'city', you: 'cat', against: ['seagulls'] };

afterEach(() => vi.unstubAllGlobals());

describe('what the publish gate checked', () => {
  it('an arcade game passed all three checks the line names', () => {
    expect(checkFacts(ARCADE, true)).toEqual({ botSeconds: 1404 / 60, idleNeverWins: true, replayEqual: true });
  });

  it('a grid game is not checked for an idle player, so the line never says it', () => {
    const facts = checkFacts(GRID, false);
    expect(facts).toEqual({ botSeconds: 15, idleNeverWins: false, replayEqual: true });
    expect(checkedLineOf(facts!, 'Get caught.')).toBe('Checked: a robot beat it · plays the same every time');
  });

  it('a version the gate did not pass has no line at all', () => {
    expect(checkFacts({ ...ARCADE, publishEligible: false }, true)).toBeNull();
    expect(checkFacts({ ...ARCADE, witness: { certified: false, winsAtTick: null } }, true)).toBeNull();
    expect(checkFacts({ ...ARCADE, keypoints: [keypoint('bot_wins', false), ...ARCADE.keypoints.slice(1)] }, true)).toBeNull();
  });

  it('a failed check drops only its own part', () => {
    const facts = checkFacts({ ...ARCADE, keypoints: ARCADE.keypoints.map((k) => (k.assertionId === 'idle_loses' ? { ...k, passed: false } : k)) }, true);
    expect(checkedLineOf(facts!, 'Lose all lives.')).toBe('Checked: a robot beat it · plays the same every time');
  });

  it('says the three checks in plain words', () => {
    expect(checkedLineOf(checkFacts(ARCADE, true)!, 'Lose all lives.')).toBe('Checked: a robot beat it · doing nothing never wins · plays the same every time');
  });

  it('a game that cannot be lost leaves the idle player out', () => {
    const facts = checkFacts(ARCADE, true)!;
    expect(checkedLineOf(facts, null)).toBe('Checked: a robot beat it · plays the same every time');
    expect(fairLinesOf(facts, null)).toEqual(['A robot beat it in 23.4 s.', 'Replaying the robot gives the same result every time.']);
    expect(fairLinesOf(facts, 'Lose all lives.')).toHaveLength(3);
  });
});

describe('the Checked line on the start card', () => {
  const card = (checked: boolean) =>
    renderToStaticMarkup(
      <FirstPrompt
        read={<StartRead read={READ}>{checked && <CheckedLine checks={checkFacts(ARCADE, true)!} lose="Lose all lives." onOpen={() => {}} />}</StartRead>}
        controlsHint="Tap to jump."
        goal="Deliver 5 pizzas."
      />,
    );

  it('sits under the read, keeps the game waiting and is outside the hidden part of the card', () => {
    const html = card(true);
    expect(html).toMatch(/play-start-read-line.*data-testid="play-start-checked"[^>]*data-keeps-waiting=""[^>]*aria-haspopup="dialog"/s);
    expect(html.indexOf('play-start-checked')).toBeLessThan(html.indexOf('aria-hidden="true"'));
  });

  it('no gate, no line', () => {
    expect(card(false)).not.toContain('play-start-checked');
  });

  it('a key pressed on the line does not start the game', () => {
    // Node nemá DOM: `keepsWaiting` hledá `[data-keeps-waiting]` přes `closest`.
    class Element {
      readonly isContentEditable = false;
      constructor(private readonly within: string | null) {}
      closest(selector: string): object | null {
        return this.within !== null && selector.includes(this.within) ? {} : null;
      }
    }
    vi.stubGlobal('HTMLElement', Element);
    const press = (target: Element) => wakesGame({ key: 'Enter', repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: target as unknown as EventTarget });
    expect(press(new Element(null))).toBe(true);
    expect(press(new Element('[data-keeps-waiting]'))).toBe(false);
    expect(press(new Element('.play-fair-sheet'))).toBe(false);
  });
});
