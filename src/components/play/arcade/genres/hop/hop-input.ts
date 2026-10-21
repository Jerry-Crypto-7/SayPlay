/**
 * Vstup přeskákání silnice (P54C T9): ťuk kamkoli na plátno = skok vpřed, tah prstem = skok tím směrem
 * (nahoru vpřed, dolů zpět, do strany o sloupec). Tah se pozná, jakmile prst ujede `SWIPE_PX` – skok vyrazí
 * hned, ne až po zvednutí; prst zvednutý blíž je ťuk. Šipky a WASD skáčou svým směrem, mezerník vpřed.
 * Kamera kouká po +z a x jádra je zrcadlené (`HopScene`), takže tah doprava na plátně je `RIGHT` (sloupec +1).
 * Co skok udělá, rozhoduje ovládání `hop` (`pieces/hop.ts`): vstup během skoku se nečte.
 */

import { useEffect } from 'react';

import { BUTTON } from '@/play/arcade/contract';

import { isTyping } from '../../input';
import type { ArcadeSession } from '../../session';

/** Kolik pixelů musí prst ujet, aby to byl tah, ne ťuk. */
export const SWIPE_PX = 24;

/** Tlačítko tahu o `dx`, `dy` pixelů (y dolů, jako na plátně); 0 = zatím ťuk. */
export function swipeButton(dx: number, dy: number): number {
  if (Math.hypot(dx, dy) < SWIPE_PX) return 0;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? BUTTON.RIGHT : BUTTON.LEFT;
  return dy < 0 ? BUTTON.UP : BUTTON.DOWN;
}

/** Klávesa → tlačítko skoku; 0 = klávesa hře nepatří. */
export function keyButton(key: string): number {
  switch (key.toLowerCase()) {
    case 'arrowup':
    case 'w':
      return BUTTON.UP;
    case 'arrowdown':
    case 's':
      return BUTTON.DOWN;
    case 'arrowleft':
    case 'a':
      return BUTTON.LEFT;
    case 'arrowright':
    case 'd':
      return BUTTON.RIGHT;
    case ' ':
      return BUTTON.TAP;
    default:
      return 0;
  }
}

export function useHopInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    // Prst na skle: kde začal a jestli už tahem skočil.
    let finger: { readonly id: number; readonly x: number; readonly y: number; swiped: boolean } | null = null;
    const onDown = (event: PointerEvent) => {
      if (finger !== null) return;
      finger = { id: event.pointerId, x: event.clientX, y: event.clientY, swiped: false };
      element.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (finger === null || event.pointerId !== finger.id || finger.swiped) return;
      const button = swipeButton(event.clientX - finger.x, event.clientY - finger.y);
      if (button === 0) return;
      finger.swiped = true;
      session.press(button);
    };
    const onUp = (event: PointerEvent) => {
      if (finger === null || event.pointerId !== finger.id) return;
      const tapped = !finger.swiped && swipeButton(event.clientX - finger.x, event.clientY - finger.y) === 0;
      finger = null;
      if (tapped && event.type === 'pointerup') session.press(BUTTON.TAP);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const button = keyButton(event.key);
      if (button === 0) return;
      event.preventDefault();
      // Držená klávesa neskáče dál: každý skok je jeden stisk, jako ťuk.
      if (!event.repeat) session.press(button);
    };
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [session, target, active]);
}
