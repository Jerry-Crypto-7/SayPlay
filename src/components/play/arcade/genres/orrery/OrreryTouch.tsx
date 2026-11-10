'use client';

/**
 * Dotykový adaptér klikací simulace (P83C T3, vstup `genre`): prst (nebo myš) položený na věc pošle `TAP` s číslem
 * věci v ose (`axisOfCell`, jádro `orreryControl`). Věc pod prstem najde z `data-orrery-things`, které plátnu píše
 * `OrreryScene`: nejbližší střed, na který prst dosáhne – dosah je poloměr věci na plátně, nejméně `REACH_MIN_PX`
 * (cíl klepnutí ≥ 44 px i u malé věci na telefonu). Prst mimo věci nic nepošle.
 *
 * Klávesnice: šipky vlevo / vpravo (A / D) posunou kurzor po věcech, mezerník klepne na věc pod kurzorem (`TAP`
 * s osou 0). Jen přes relaci (`session.press`), takže tvar záznamu, Dare ani serverový replay se nemění.
 */

import { useEffect, useRef } from 'react';

import { BUTTON } from '@/play/arcade/contract';
import { axisOfCell } from '@/play/arcade/pieces/lanes';

import { isTyping } from '../../input';
import type { GenreTouchProps } from '../touch-registry';

/** Nejmenší dosah prstu od středu věci (px): polovina cíle 44 px. */
export const REACH_MIN_PX = 22;

/** Věc pod bodem (`x`, `y` v px plochy `width × height`) podle `data-orrery-things`; mimo dosah všech `null`. */
export function thingAt(things: string | undefined, x: number, y: number, width: number, height: number): number | null {
  if (things === undefined || things === '') return null;
  let best: number | null = null;
  let nearest = Number.POSITIVE_INFINITY;
  things.split(';').forEach((spot, index) => {
    const [fx, fy, radius] = spot.split(',').map(Number) as [number, number, number];
    const distance = Math.hypot(fx * width - x, fy * height - y);
    if (distance <= Math.max(radius, REACH_MIN_PX) && distance < nearest) {
      nearest = distance;
      best = index;
    }
  });
  return best;
}

const KEYS: Readonly<Record<string, number>> = { arrowleft: BUTTON.LEFT, a: BUTTON.LEFT, arrowright: BUTTON.RIGHT, d: BUTTON.RIGHT, ' ': BUTTON.TAP };

export function OrreryTouch({ session }: GenreTouchProps) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const surface = anchor.current?.parentElement;
    if (surface == null) return;
    const onDown = (event: PointerEvent) => {
      if (event.button > 0) return;
      const box = surface.getBoundingClientRect();
      const thing = thingAt(surface.dataset.orreryThings, event.clientX - box.left, event.clientY - box.top, box.width, box.height);
      if (thing !== null) session.press(BUTTON.TAP, axisOfCell(thing));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target)) return;
      const button = KEYS[event.key.toLowerCase()];
      if (button === undefined) return;
      event.preventDefault();
      session.press(button, 0);
    };
    surface.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      surface.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [session]);
  return <span ref={anchor} hidden />;
}
