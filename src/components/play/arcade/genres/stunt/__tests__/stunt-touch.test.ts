/**
 * Palec závodu s triky (P68V T4, `stunt-touch.ts`). Test level pin: tah a brzda musí dát tentýž `ArcadeInput` jako
 * klávesnice řízení (`steer/drive-input.ts`: šipky a A/D = osa, S / ↓ = brzda) – jinak by záznam hry prstem byl jiná
 * hra než na desktopu a robot ze sondy by dotykem neřídil.
 */

import { describe, expect, it } from 'vitest';

import { AXIS_MAX, type ArcadeInput, BUTTON, NO_INPUT } from '@/play/arcade/contract';

import { driveInput } from '../../../steer/drive-input';
import { STUNT_TOUCH, stuntAxis, stuntDragPx, stuntTouch } from '../stunt-touch';

/** Ustálený vstup klávesnice řízení (volant `key-steer.ts` dojede na `keyAxis`). */
function keys(...pressed: string[]): ArcadeInput {
  const input = driveInput('drive');
  for (const key of pressed) input.key(key, true);
  return input.snapshot(input.keyAxis());
}

const X0 = 200;

describe('stunt thumb controls (stuntTouch)', () => {
  it('a full drag right or left and the brake button give the same input as the arrows and S / ↓', () => {
    const touch = stuntTouch();
    touch.down(1, X0, 'steer');
    touch.move(1, X0 + STUNT_TOUCH.fullPx + 30);
    expect(touch.input()).toEqual(keys('arrowright'));
    expect(touch.input()).toEqual(keys('d'));
    touch.move(1, X0 - STUNT_TOUCH.fullPx);
    expect(touch.input()).toEqual(keys('arrowleft'));
    touch.up(1);
    expect(touch.input()).toEqual(keys());

    touch.down(7, 600, 'brake');
    expect(touch.input()).toEqual(keys('arrowdown'));
    expect(touch.input()).toEqual(keys('s'));
    touch.down(2, X0, 'steer');
    touch.move(2, X0 - 2 * STUNT_TOUCH.fullPx);
    expect(touch.input()).toEqual(keys('arrowleft', 'arrowdown'));
    touch.up(7);
    expect(touch.input()).toEqual(keys('arrowleft'));
    touch.up(2);
    expect(touch.input()).toEqual(NO_INPUT);
  });

  it('a drag inside the dead zone is axis 0, past it the axis grows to full at fullPx', () => {
    for (const dx of [0, 1, -5, STUNT_TOUCH.deadPx, -STUNT_TOUCH.deadPx]) expect(stuntAxis(dx)).toBe(0);
    const touch = stuntTouch();
    touch.down(1, X0, 'steer');
    touch.move(1, X0 + STUNT_TOUCH.deadPx - 1);
    expect(touch.input()).toEqual(NO_INPUT);
    expect(stuntAxis(STUNT_TOUCH.deadPx + 1)).toBeGreaterThan(0);
    expect(stuntAxis(-(STUNT_TOUCH.deadPx + 1))).toBeLessThan(0);
    expect(stuntAxis((STUNT_TOUCH.deadPx + STUNT_TOUCH.fullPx) / 2)).toBeGreaterThan(0);
    expect(stuntAxis((STUNT_TOUCH.deadPx + STUNT_TOUCH.fullPx) / 2)).toBeLessThan(AXIS_MAX);
    expect(stuntAxis(STUNT_TOUCH.fullPx)).toBe(AXIS_MAX);
    expect(stuntAxis(-10 * STUNT_TOUCH.fullPx)).toBe(-AXIS_MAX);
  });

  it('stuntDragPx is the drag the e2e finger needs for an axis the bot wants', () => {
    for (const axis of [-AXIS_MAX, -640, -1, 0, 1, 250, 999, AXIS_MAX]) expect(Math.abs(stuntAxis(stuntDragPx(axis)) - axis)).toBeLessThanOrEqual(1);
  });

  it('the first finger on the pad steers; a second one does not steal it and the brake finger never steers', () => {
    const touch = stuntTouch();
    touch.down(1, X0, 'steer');
    touch.down(2, X0 + 300, 'steer');
    touch.move(2, X0 + 600);
    touch.down(3, 700, 'brake');
    touch.move(3, 100);
    expect(touch.input()).toEqual({ axis: 0, buttons: BUTTON.DOWN });
    touch.move(1, X0 + STUNT_TOUCH.fullPx);
    expect(touch.input()).toEqual({ axis: AXIS_MAX, buttons: BUTTON.DOWN });
    expect(touch.active()).toBe(true);
    touch.clear();
    expect(touch.active()).toBe(false);
    expect(touch.input()).toEqual(NO_INPUT);
  });
});
