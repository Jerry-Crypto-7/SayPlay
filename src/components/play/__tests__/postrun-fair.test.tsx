/**
 * P73B T4: po hře karta výsledku nabídne „Why this game is fair“ – list s tím, co brána ověřila (robot vyhrál
 * za X s z tiku jeho výhry, nečinný hráč nevyhraje, přehrání je stejné) a „Watch the robot win“. Pin: čas robota
 * a vynechaný bod by na snímku vypadaly hotově i se špatným číslem.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { FairSheet, fairLinesOf } from '../FairSheet';
import type { CheckFacts } from '../lab';
import { PostRun, type RunFacts } from '../PostRun';
import type { RemixJob } from '../RemixBox';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

const job: RemixJob = { view: { kind: 'idle' }, sent: '', submit: () => undefined };
const lost: RunFacts = { won: false, tick: 400, hz: 60, survive: false, goal: null, extra: [] };
const CHECKS: CheckFacts = { botSeconds: 2310 / 60, idleNeverWins: true, replayEqual: true };

const card = (onFair?: () => void) => renderToStaticMarkup(<PostRun versionId="v1" remix={job} facts={lost} onReplay={() => undefined} {...(onFair === undefined ? {} : { onFair })} />);

describe('why this game is fair, after the game', () => {
  it('the result card links to it only when the version carries checks', () => {
    expect(card(() => undefined)).toMatch(/data-testid="play-fair"[^>]*aria-haspopup="dialog"[^>]*>Why this game is fair</);
    expect(card()).not.toContain('play-fair');
  });

  it('the link is no second main action', () => {
    expect(card(() => undefined).match(/data-variant="primary"/g)).toHaveLength(1);
  });

  it('three points: the robot time from its winning tick, the idle player and the replay', () => {
    expect(fairLinesOf(CHECKS, 'Lose all 3 lives.')).toEqual(['A robot beat it in 38.5 s.', 'Doing nothing never wins.', 'Replaying the robot gives the same result every time.']);
  });

  it('a game that cannot be lost skips the idle player', () => {
    expect(fairLinesOf(CHECKS, null)).not.toContain('Doing nothing never wins.');
  });

  it('under the points a button plays the robot run, when the game has one', () => {
    const open = (onWatch?: () => void) =>
      renderToStaticMarkup(<FairSheet open onClose={() => undefined} checks={CHECKS} lose="Lose all 3 lives." {...(onWatch === undefined ? {} : { onWatch })} />);
    const html = open(() => undefined);
    expect(html).toContain('Why this game is fair');
    expect(html).toMatch(/play-fair-list.*A robot beat it in 38\.5 s\..*data-testid="play-fair-watch"[^>]*>.*Watch the robot win/s);
    expect(open()).not.toContain('play-fair-watch');
  });
});
