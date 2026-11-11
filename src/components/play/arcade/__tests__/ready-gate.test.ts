/**
 * Hra čeká na první dotek (P33 T11): bez vstupu hodiny stojí, první vstup
 * padne do tiku 0, restart znovu čeká a ukázka robota nečeká.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BUTTON } from '@/play/arcade/contract';
import { readGameSpec } from '@/play/spec';

import { FirstPrompt, controlLines, desktopKeys } from '../../FirstPrompt';
import { holdUntilTouch, playStateOf, wakesGame } from '../ready-gate';
import { TICK_MS, createArcadeSession } from '../session';

const world = (() => {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

/** `seconds` simulovaného času po snímcích 60 Hz, jak ho posílá plátno. */
function wait(session: { advance(ms: number): number }, seconds: number): void {
  for (let ms = 0; ms < seconds * 1000; ms += TICK_MS) session.advance(TICK_MS);
}

describe('ready gate', () => {
  it('ten seconds without input leave the runner on tick 0, still running', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    wait(session, 10);
    expect(session.snapshot().tick).toBe(0);
    expect(session.snapshot().runState).toBe('running');
    expect(session.inputs()).toEqual([]);
    expect(session.waiting()).toBe(true);
  });

  it('the first input lands on tick 0 and the clock runs from there', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    wait(session, 2);
    session.begin();
    session.press(BUTTON.TAP);
    wait(session, 1);
    expect(session.inputs()[0]).toMatchObject({ tick: 0, buttons: BUTTON.TAP });
    expect(session.snapshot().tick).toBeGreaterThan(50);
  });

  it('a touch that maps to no input still starts the game', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    session.begin();
    wait(session, 1);
    expect(session.snapshot().tick).toBeGreaterThan(50);
    expect(session.inputs()).toEqual([]);
  });

  it('Play again waits for the next touch', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    session.begin();
    wait(session, 1);
    session.restart();
    wait(session, 10);
    expect(session.snapshot().tick).toBe(0);
    expect(session.waiting()).toBe(true);
  });

  // P68R T3: scéna, která do prvního doteku kreslí na požádání, se probudí jen tímhle ohlášením.
  it('the first touch tells subscribers once, and again after Play again', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    const heard = vi.fn(() => session.waiting());
    const off = session.subscribe(heard);
    wait(session, 1);
    expect(heard).not.toHaveBeenCalled();
    session.begin();
    session.begin();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveLastReturnedWith(false);
    session.restart();
    heard.mockClear();
    session.begin();
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    session.restart();
    heard.mockClear();
    session.begin();
    expect(heard).not.toHaveBeenCalled();
  });

  it('the robot demo plays without a touch', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    session.startDemo();
    wait(session, 1);
    expect(session.snapshot().tick).toBeGreaterThan(50);
  });

  it('only a real key wakes the game, never Tab, Escape, a modifier or typing', () => {
    // Node nemá DOM: `isTyping` pozná pole formuláře podle `HTMLElement` a `closest`.
    class Element {
      readonly isContentEditable = false;
      constructor(private readonly field: boolean) {}
      closest(): object | null {
        return this.field ? {} : null;
      }
    }
    vi.stubGlobal('HTMLElement', Element);
    const key = (value: string, extra: Partial<Parameters<typeof wakesGame>[0]> = {}) =>
      wakesGame({ key: value, repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: new Element(false) as unknown as EventTarget, ...extra });
    expect(key('a', { target: new Element(true) as unknown as EventTarget })).toBe(false);
    expect(key(' ')).toBe(true);
    expect(key('ArrowLeft')).toBe(true);
    expect(key('Tab')).toBe(false);
    expect(key('Escape')).toBe(false);
    expect(key('Shift')).toBe(false);
    expect(key('c', { ctrlKey: true })).toBe(false);
    expect(key(' ', { repeat: true })).toBe(false);
    vi.unstubAllGlobals();
  });
});

// P85: `data-state` čte automat místo plátna – špatná přednost by vypadala správně a lhala (konec ukázky jako výhra hráče).
describe('play state in the DOM', () => {
  const base = { loading: false, demo: false, runState: 'running', paused: false, waiting: false } as const;

  it('goes loading → ready → running → won or lost along a player run', () => {
    expect(playStateOf({ ...base, loading: true, waiting: true })).toBe('loading');
    expect(playStateOf({ ...base, waiting: true })).toBe('ready');
    expect(playStateOf(base)).toBe('running');
    expect(playStateOf({ ...base, runState: 'won' })).toBe('won');
    expect(playStateOf({ ...base, runState: 'lost' })).toBe('lost');
    expect(playStateOf({ ...base, runState: 'runtimeFault' })).toBe('lost');
  });

  it('a robot demo, even one that ended in a win, is never the player result', () => {
    expect(playStateOf({ ...base, demo: true })).toBe('demo');
    expect(playStateOf({ ...base, demo: true, runState: 'won' })).toBe('demo');
  });

  it('loading wins over everything, an ended run over a pause, a pause over the first-touch wait', () => {
    expect(playStateOf({ ...base, loading: true, demo: true, runState: 'won', paused: true })).toBe('loading');
    expect(playStateOf({ ...base, runState: 'lost', paused: true })).toBe('lost');
    expect(playStateOf({ ...base, paused: true, waiting: true })).toBe('paused');
  });
});

describe('ready prompt', () => {
  // P70C T2: desktop (server nezná dotyk) kliká nebo mačká Space; karta nese cíl, prohru a ovládání v tomto pořadí.
  it('says how to win, how to lose, the one command and click or Space to start', () => {
    const html = renderToStaticMarkup(
      createElement(FirstPrompt, { controlsHint: 'Tap or Space to jump, swipe or arrows to change lane.', goal: 'Reach the flag.', lose: 'Lose all 3 lives.' }),
    );
    expect(html).toContain('Click or press Space');
    expect(html).not.toContain('Tap to start');
    expect(html).not.toContain('play-first-prompt-keys');
    const order = ['play-first-prompt-goal', 'play-first-prompt-lose', 'play-first-prompt-action', 'play-first-prompt-start'].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(html).toContain('>Reach the flag.<');
    expect(html).toContain('>Lose all 3 lives.<');
    expect(html).toContain('Tap to jump');
    // Hra, která prohrát nejde, řádek prohry nemá.
    expect(renderToStaticMarkup(createElement(FirstPrompt, { controlsHint: 'Tap to jump.', lose: null }))).not.toContain('play-first-prompt-lose');
  });

  // P39 T10: plošinovka se střelbou ukáže skok i střelbu, ne jen „Arrows to move“.
  it('lists every control of the hint under the first command', () => {
    const platformShoot = 'Arrows or A/D to move, Space or tap to jump. F or Fire to shoot.';
    expect(controlLines(platformShoot)).toEqual(['Space to jump', 'F to shoot']);
    const html = renderToStaticMarkup(createElement(FirstPrompt, { controlsHint: platformShoot }));
    expect(html).toContain('Arrows to move');
    expect(html).toContain('Space to jump');
    expect(html).toContain('F to shoot');
    // Rada, která nic neovládá, na kartu nepatří; směr tahu „up or down“ zůstane celý.
    expect(controlLines('Drag or arrows to move, Attack or J to strike. Step aside when it winds up.')).toEqual(['Attack or J to strike']);
    expect(controlLines('Hold to power up, drag up or down to aim, let go to throw.')).toEqual(['Drag up or down to aim', 'Let go to throw']);
    expect(controlLines('Tap the lane, or D F J K, on the beat. M toggles sound.')).toEqual([]);
    // Prst: zóny plošinovky říkají běh a skok, střelbu doplní nápověda hry bez klávesy.
    expect(controlLines('Hold left to run, tap right to jump.', platformShoot)).toEqual(['Tap right to jump', 'Fire to shoot']);
  });

  it('names the key the hint offers next to touch', () => {
    expect(desktopKeys('Tap or Space to jump, swipe or arrows to change lane.')).toBe('or press Space');
    expect(desktopKeys('Drag or arrows to steer. Down or a second finger brakes.')).toBe('or use the arrow keys');
    expect(desktopKeys('Tap right or Space to strike, tap left or Down to dodge.')).toBe('or press Space');
    expect(desktopKeys('Tap an egg to walk to it. Tap again to pick it up.')).toBeNull();
  });
});
