/**
 * Vstup pruhů (P54C T4): plátno se dělí na pět svislých pásů, jeden na pruh.
 * Prst položený do pásu je ťuk v jeho pruhu a držení, tah drží osu pruhu pod
 * prstem. Šipky posunou o pruh, mezerník je ťuk a držení v pruhu, kde hráč stojí.
 * Co ťuk a držení udělá, rozhoduje pravidlo žánru (`pieces/lanes.ts`).
 */

import { useEffect } from 'react';

import { BUTTON } from '@/play/arcade/contract';
import { LANES, axisOfLane } from '@/play/arcade/pieces/lanes';

import { isTyping } from '../../input';
import type { ArcadeSession } from '../../session';

/** Vodorovná poloha prstu na plátně (0 = levý okraj, 1 = pravý) → osa pruhu pod ním. */
export const laneAxisAt = (fraction: number): number => axisOfLane(Math.min(LANES.count - 1, Math.max(0, Math.floor(fraction * LANES.count))));

export function useLanesInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    let finger: number | null = null;
    const axisAt = (event: PointerEvent): number => {
      const box = element.getBoundingClientRect();
      return laneAxisAt((event.clientX - box.left) / Math.max(1, box.width));
    };
    const onDown = (event: PointerEvent) => {
      if (finger !== null) return;
      finger = event.pointerId;
      element.setPointerCapture(event.pointerId);
      const axis = axisAt(event);
      session.press(BUTTON.TAP, axis);
      session.hold(axis);
      session.holdButtons(BUTTON.HOLD);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId === finger) session.hold(axisAt(event));
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== finger) return;
      finger = null;
      session.hold(0);
      session.holdButtons(0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'arrowleft' || key === 'a') session.press(BUTTON.LEFT);
      else if (key === 'arrowright' || key === 'd') session.press(BUTTON.RIGHT);
      else if (key === ' ') {
        if (!event.repeat) session.press(BUTTON.TAP);
        session.holdButtons(BUTTON.HOLD);
      } else return;
      event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') session.holdButtons(0);
    };
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      session.hold(0);
      session.holdButtons(0);
    };
  }, [session, target, active]);
}
