/**
 * Pauza při odchodu (P28B T6): okno bez fokusu hru zastaví stejně jako
 * skrytá záložka, a po odpojení už ne.
 */

import { describe, expect, it } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { readGameSpec } from '@/play/spec';

import { pauseWhenAway } from '../focus';
import { TICK_MS, createArcadeSession } from '../session';

const world = (() => {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

const page = () => ({ win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState }) });

describe('pause when the player leaves', () => {
  it('a window blur pauses the clock', () => {
    const session = createArcadeSession(world);
    const { win, doc } = page();
    const stop = pauseWhenAway(session, win, doc);
    session.advance(TICK_MS * 3);
    win.dispatchEvent(new Event('blur'));
    expect(session.paused()).toBe(true);
    const tick = session.snapshot().tick;
    session.advance(TICK_MS * 10);
    expect(session.snapshot().tick).toBe(tick);
    stop();
  });

  it('a hidden tab pauses; after detaching a blur does nothing', () => {
    const session = createArcadeSession(world);
    const { win, doc } = page();
    const stop = pauseWhenAway(session, win, doc);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(session.paused()).toBe(true);
    session.resume();
    stop();
    win.dispatchEvent(new Event('blur'));
    expect(session.paused()).toBe(false);
  });
});
