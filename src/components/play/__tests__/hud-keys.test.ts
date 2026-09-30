/**
 * Klávesy HUD a řádek cíle (P34 T5, kit `05-layout.md` a `08-game-hud.md`):
 * Space pauza, R restart, Esc zavřít, M zvuk – nikdy při psaní do pole ani
 * se zkratkou prohlížeče. Mezerník, který hra použila (skok, výstřel), pauzu
 * nezapne, a na tlačítku ho zmáčkne. Řádek cíle zmizí po 4 s hry a při pauze
 * se vrátí.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GameHud, clockText, objectiveShown } from '../ui/GameHud';
import { type HudKeyEvent, type HudKeyState, hudKey } from '../ui/PauseCard';

/** Node nemá DOM: `isTyping` a tlačítko poznají cíl podle `HTMLElement` a `closest`. */
class Element {
  readonly isContentEditable = false;
  constructor(private readonly tag: 'canvas' | 'input' | 'button') {}
  closest(selector: string): object | null {
    return selector.split(',').some((part) => part.trim().startsWith(this.tag)) ? {} : null;
  }
}

const PLAYING: HudKeyState = { paused: false, spaceIsGameKey: false };
const PAUSED: HudKeyState = { paused: true, spaceIsGameKey: false };

const press = (key: string, state: HudKeyState, extra: Partial<HudKeyEvent> = {}) =>
  hudKey({ key, repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: new Element('canvas') as unknown as EventTarget, ...extra }, state);

describe('HUD keys', () => {
  beforeEach(() => vi.stubGlobal('HTMLElement', Element));
  afterEach(() => vi.unstubAllGlobals());

  it('Space pauses a running game and resumes a paused one', () => {
    expect(press(' ', PLAYING)).toBe('pause');
    expect(press(' ', PAUSED)).toBe('resume');
  });

  it('Space the game already used (jump, fire, pick up) does not pause', () => {
    expect(press(' ', { paused: false, spaceIsGameKey: true })).toBeNull();
    // Hra v pauze klávesu nehraje – karta ji zavře.
    expect(press(' ', { paused: true, spaceIsGameKey: true })).toBe('resume');
  });

  it('Space on a focused button presses the button, not the pause', () => {
    expect(press(' ', PLAYING, { target: new Element('button') as unknown as EventTarget })).toBeNull();
    expect(press(' ', PAUSED, { target: new Element('button') as unknown as EventTarget })).toBeNull();
  });

  it('R restarts, M is the sound key, whether paused or not', () => {
    for (const state of [PLAYING, PAUSED]) {
      expect(press('r', state)).toBe('restart');
      expect(press('R', state)).toBe('restart');
      expect(press('m', state)).toBe('mute');
      expect(press('M', state)).toBe('mute');
    }
  });

  it('Esc closes the pause card, and without one opens it (the way out is Quit on the card)', () => {
    expect(press('Escape', PAUSED)).toBe('resume');
    expect(press('Escape', PLAYING)).toBe('pause');
  });

  it('ignores typing in a field, held keys, browser shortcuts and other keys', () => {
    const field = new Element('input') as unknown as EventTarget;
    for (const key of [' ', 'r', 'm', 'Escape']) expect(press(key, PLAYING, { target: field }), key).toBeNull();
    expect(press(' ', PLAYING, { repeat: true })).toBeNull();
    expect(press('r', PLAYING, { ctrlKey: true })).toBeNull();
    expect(press('r', PLAYING, { metaKey: true })).toBeNull();
    expect(press('m', PLAYING, { altKey: true })).toBeNull();
    for (const key of ['ArrowUp', 'Enter', 'Tab', 'p', '1']) expect(press(key, PLAYING), key).toBeNull();
  });
});

describe('objective line', () => {
  const HZ = 60;

  it('shows for the first 4 s of play and hides after', () => {
    expect(objectiveShown(0, HZ, false)).toBe(true);
    expect(objectiveShown(4 * HZ - 1, HZ, false)).toBe(true);
    expect(objectiveShown(4 * HZ, HZ, false)).toBe(false);
  });

  it('comes back when the game is paused', () => {
    expect(objectiveShown(30 * HZ, HZ, true)).toBe(true);
  });

  it('the HUD marks the line shown or hidden, text kept for the reader', () => {
    const hud = (objective: boolean) =>
      renderToStaticMarkup(createElement(GameHud, { title: 'Egg run', goalLine: 'Grab the eggs, then run for the gate!', clock: { seconds: 14.2, countdown: false }, objective }));
    expect(hud(true)).toContain('data-testid="play-goal" data-shown="true"');
    expect(hud(false)).toContain('data-testid="play-goal" data-shown="false"');
    expect(hud(false)).toContain('Grab the eggs, then run for the gate!');
    expect(hud(true)).toContain('14.2s');
  });

  it('the clock reads like the kit and never goes below zero', () => {
    expect(clockText(14.24)).toBe('14.2s');
    expect(clockText(-3)).toBe('0.0s');
  });
});
