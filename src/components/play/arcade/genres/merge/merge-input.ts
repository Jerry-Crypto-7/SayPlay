/**
 * Vstup slučování (P54C T11): prst na plátně je místo, nad které dávkovač jede (osa ovládání `merge` je cíl, ne
 * rychlost – `axisFor`), puštění prstu pustí předmět. Šipky a A/D jedou ke kraji nádoby a po puštění stojí,
 * mezerník, Enter a šipka dolů pustí. Kam prst míří, říká scéna: zapíše `data-drop-edges` (kde na šířce plátna leží
 * levý a pravý kraj dosahu dávkovače).
 *
 * Pust čeká, až je předmět připravený a dávkovač nad cílem (`settle`): ťuk během přebíjení nebo daleko od dávkovače
 * se neztratí, pustí se, jakmile to jde. Scéna volá `settle` každý snímek; jádro dostane jen obyčejné stisky,
 * záznam se přehraje stejně.
 */

import { useEffect, useRef } from 'react';

import { BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { axisFor, clockOf, dropLimit, sizeOf } from '@/play/arcade/pieces/merge-drop';

import { isTyping } from '../../input';
import type { ArcadeSession } from '../../session';

/** Jak blízko cíle (j) dávkovač pustí předmět čekajícího pustu. */
const AIM = 20;

/** Místo v nádobě (j jádra) pod zlomkem šíře plátna `fraction`, podle krajů dosahu `edges` (zlomky pro −dosah a +dosah). */
export function spotOf(fraction: number, edges: readonly [number, number], reach: number): number {
  const [left, right] = edges;
  if (right === left) return 0;
  return Math.round(-reach + ((fraction - left) / (right - left)) * 2 * reach);
}

/** Kraje dosahu z `data-drop-edges`, nebo `null`, dokud je scéna nezapsala. */
export function edgesOf(element: HTMLElement): readonly [number, number] | null {
  const parts = (element.dataset.dropEdges ?? '').split(',').map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) ? [parts[0] as number, parts[1] as number] : null;
}

/** Klávesa → směr (−1 vlevo, +1 vpravo), pust (0), nebo `null` = klávesa hře nepatří. */
export function keyAction(key: string): -1 | 0 | 1 | null {
  switch (key.toLowerCase()) {
    case 'arrowleft':
    case 'a':
      return -1;
    case 'arrowright':
    case 'd':
      return 1;
    case ' ':
    case 'enter':
    case 'arrowdown':
    case 's':
      return 0;
    default:
      return null;
  }
}

export interface MergeInput {
  /** Pustí čekající předmět, je-li připravený a dávkovač nad cílem; scéna volá každý snímek. */
  settle(): void;
}

export function useMergeInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): React.RefObject<MergeInput> {
  const controller = useRef<MergeInput>({ settle: () => undefined });
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const reach = dropLimit(sizeOf(1));
    let finger: number | null = null;
    /** Cíl, nad kterým se má pustit (j jádra); `null` = nic nečeká. */
    let pending: number | null = null;
    const dropperX = (): number => session.state()[bodyBase(session.state()[HEADER.player] as number) + BODY.x] as number;
    const aim = (x: number): void => session.hold(axisFor(x, reach));
    const spot = (event: PointerEvent): number | null => {
      const edges = edgesOf(element);
      if (edges === null) return null;
      const rect = element.getBoundingClientRect();
      return spotOf((event.clientX - rect.left) / rect.width, edges, reach);
    };
    const settle = (): void => {
      if (pending === null || clockOf(session.state()) > 0 || Math.abs(dropperX() - pending) > AIM) return;
      pending = null;
      session.press(BUTTON.TAP);
      if (finger === null) session.hold(0);
    };
    controller.current = { settle };
    const onDown = (event: PointerEvent) => {
      if (finger !== null) return;
      finger = event.pointerId;
      pending = null;
      element.setPointerCapture(event.pointerId);
      const x = spot(event);
      if (x !== null) aim(x);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== finger) return;
      const x = spot(event);
      if (x !== null) aim(x);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== finger) return;
      finger = null;
      if (event.type !== 'pointerup') return;
      // Pustí se nad místem, kam prst naposled mířil (dávkovač tam ještě dojede, je-li daleko).
      pending = spot(event) ?? dropperX();
      aim(pending);
      settle();
    };
    const held = new Set<number>();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const action = keyAction(event.key);
      if (action === null) return;
      event.preventDefault();
      if (event.repeat) return;
      if (action === 0) {
        pending = dropperX();
        settle();
        return;
      }
      held.add(action);
      aim(action * reach);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const action = keyAction(event.key);
      if (action === null || action === 0) return;
      held.delete(action);
      const other = [...held].at(-1);
      // Puštěná šipka zastaví dávkovač, kde je; druhá držená šipka jede dál.
      if (other !== undefined) aim(other * reach);
      else if (pending === null) session.hold(0);
    };
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      controller.current = { settle: () => undefined };
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [session, target, active]);
  return controller;
}
