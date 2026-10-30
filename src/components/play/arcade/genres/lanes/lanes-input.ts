/**
 * Vstup pruhů (P54C T4): plátno se dělí na pět svislých pásů, jeden na pruh.
 * Prst položený do pásu je ťuk v jeho pruhu a držení, tah drží osu pruhu pod
 * prstem. Šipky posunou o pruh, mezerník je ťuk a držení v pruhu, kde hráč stojí.
 * Co ťuk a držení udělá, rozhoduje pravidlo žánru (`pieces/lanes.ts`).
 *
 * Mřížka (P66 T2, šipky): když scéna plátnu zapíše `data-lane-cells`, prst místo pruhu vybere buňku pod sebou
 * a ťuk ji nese v ose (`cellAxisAt`); držení ani tah nic nenesou. Bez atributu se nic nemění.
 */

import { useEffect } from 'react';

import { BUTTON } from '@/play/arcade/contract';
import { LANES, axisOfCell, axisOfLane } from '@/play/arcade/pieces/lanes';

import { isTyping } from '../../input';
import type { ArcadeSession } from '../../session';

/**
 * Vodorovná poloha prstu na plátně (0 = levý okraj, 1 = pravý) → osa pruhu pod ním. `edges` jsou hranice
 * pruhů, které scéna promítla na plátno (`data-lane-edges`, zleva doprava, P54C T5); bez nich pět stejných pásů.
 */
export function laneAxisAt(fraction: number, edges?: readonly number[]): number {
  const lane = edges !== undefined && edges.length === LANES.count - 1 && edges.every(Number.isFinite)
    ? edges.filter((edge) => fraction >= edge).length
    : Math.min(LANES.count - 1, Math.max(0, Math.floor(fraction * LANES.count)));
  return axisOfLane(lane);
}

/**
 * Poloha prstu (zlomky plátna, 0 = levý a horní okraj) → osa buňky pod ním, nebo `null` mimo mřížku. `cells` je
 * `data-lane-cells`, který scéna zapíše: „sloupce,řady,vlevo,nahoře,vpravo,dole“ (hranice mřížky na plátně ve
 * zlomcích); buňky se číslují po řadách zleva shora (`axisOfCell`).
 */
export function cellAxisAt(x: number, y: number, cells: string): number | null {
  const [cols = 0, rows = 0, left = 0, top = 0, right = 0, bottom = 0] = cells.split(',').map(Number);
  if (x < left || x >= right || y < top || y >= bottom) return null;
  const col = Math.floor(((x - left) / (right - left)) * cols);
  const row = Math.floor(((y - top) / (bottom - top)) * rows);
  return axisOfCell(row * cols + col);
}

export function useLanesInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    let finger: number | null = null;
    const axisAt = (event: PointerEvent): number => {
      const box = element.getBoundingClientRect();
      return laneAxisAt((event.clientX - box.left) / Math.max(1, box.width), element.dataset.laneEdges?.split(',').map(Number));
    };
    const onDown = (event: PointerEvent) => {
      if (finger !== null) return;
      const cells = element.dataset.laneCells;
      if (cells !== undefined) {
        const box = element.getBoundingClientRect();
        const axis = cellAxisAt((event.clientX - box.left) / Math.max(1, box.width), (event.clientY - box.top) / Math.max(1, box.height), cells);
        if (axis !== null) session.press(BUTTON.TAP, axis);
        return;
      }
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
