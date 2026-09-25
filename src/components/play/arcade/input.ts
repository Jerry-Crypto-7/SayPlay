/**
 * Sdílená pravidla vstupu her (P28B T1, T4). Hry poslouchají klávesy na `window`,
 * takže bez `isTyping` by si vzaly písmena a mezerník z pole remixu.
 */

import { BUTTON } from '@/play/arcade/contract';

import type { ArcadeSession } from './session';

/** Klávesa do pole formuláře patří větě, ne hře ani feedu. */
export const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);

export const SWIPE_PX = 30;

interface Point {
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Dotyk běžce (P28B T4): skok padne hned při stisku – čekání na puštění
 * stálo u ťuku desítky milisekund. Tah za `SWIPE_PX` pak jednou změní pruh
 * (do strany) nebo skluz (dolů); tah nahoru nic nepřidá, skok už padl.
 */
export function runnerGesture(session: Pick<ArcadeSession, 'press'>) {
  let start: { x: number; y: number } | null = null;
  return {
    down(event: Point): void {
      start = { x: event.clientX, y: event.clientY };
      session.press(BUTTON.TAP);
    },
    move(event: Point): void {
      if (start === null) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
      start = null;
      if (Math.abs(dx) > Math.abs(dy)) session.press(dx < 0 ? BUTTON.LEFT : BUTTON.RIGHT);
      else if (dy > 0) session.press(BUTTON.DOWN);
    },
    /** Puštění i zrušení (`pointercancel`) gesto ukončí. */
    end(): void {
      start = null;
    },
  };
}
