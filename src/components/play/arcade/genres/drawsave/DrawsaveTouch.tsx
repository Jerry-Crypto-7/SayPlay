'use client';

/**
 * Dotykový adaptér hry kresli a zachraň (P68-S T14, vstup `genre`): tah prstem (nebo myší) přes mřížku desky kreslí.
 * Prst položený na buňku (`data-lane-cells`, které plátnu zapisuje `DrawsaveScene`) začne tah; po dobu tahu drží
 * `HOLD` a v ose buňku pod prstem (`cellAxisAt`, `DRAWSAVE_STROKE` v `genre/p68-contract.ts`), zvednutí tah ukončí.
 * Prst položený mimo mřížku nic nezačne; tah, který z mřížky vyjede, drží poslední buňku.
 *
 * Jen přes relaci: každá nová buňka jde i jako stisk (`session.press(HOLD, osa)`), ať padne do příštího tiku, i když
 * prst mezi dvěma tiky jede dál nebo se zvedne; držená osa (`session.hold`) a držené `HOLD` (`session.holdButtons`,
 * držená půlka téhož API) nesou tah tiky mezi buňkami. Tvar záznamu, Dare ani serverový replay se nemění.
 *
 * Adaptér dostane jen relaci, plochu hry najde jako rodiče svého neviditelného kotvicího prvku (`ArcadeStage` ho
 * kreslí přímo do `.play-stage`). Pohyb a zvednutí poslouchá na okně, ať myš tažená z plátna tah neztratí.
 */

import { useEffect, useRef } from 'react';

import { BUTTON } from '@/play/arcade/contract';
import { DRAWSAVE_STROKE } from '@/play/genre/p68-contract';

import { cellAxisAt } from '../lanes/lanes-input';
import type { GenreTouchProps } from '../touch-registry';

const HOLD = BUTTON[DRAWSAVE_STROKE.hold];

export function DrawsaveTouch({ session }: GenreTouchProps) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const surface = anchor.current?.parentElement;
    if (surface == null) return;
    let finger: number | null = null;
    let last = 0;
    const axisAt = (event: PointerEvent): number | null => {
      const cells = surface.dataset.laneCells;
      if (cells === undefined) return null;
      const box = surface.getBoundingClientRect();
      return cellAxisAt((event.clientX - box.left) / Math.max(1, box.width), (event.clientY - box.top) / Math.max(1, box.height), cells);
    };
    const reach = (axis: number | null): void => {
      if (axis === null || axis === last) return;
      last = axis;
      session.press(HOLD, axis);
      session.hold(axis);
    };
    const onDown = (event: PointerEvent) => {
      if (finger !== null || event.button > 0) return;
      const axis = axisAt(event);
      if (axis === null) return;
      finger = event.pointerId;
      last = 0;
      session.holdButtons(HOLD);
      reach(axis);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId === finger) reach(axisAt(event));
    };
    const lift = (): void => {
      finger = null;
      last = 0;
      session.hold(0);
      session.holdButtons(0);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId === finger) lift();
    };
    surface.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      surface.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (finger !== null) lift();
    };
  }, [session]);
  return <span ref={anchor} hidden />;
}
