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

/**
 * Místo v nádobě (j jádra) pod zlomkem šíře plátna `fraction`, podle krajů dosahu `edges` (zlomky pro −dosah a +dosah).
 * Oříznuté na dosah: prst za krajem míří na kraj, jinak by pust čekal na místo, kam dávkovač nikdy nedojede.
 */
export function spotOf(fraction: number, edges: readonly [number, number], reach: number): number {
  const [left, right] = edges;
  if (right === left) return 0;
  const x = Math.round(-reach + ((fraction - left) / (right - left)) * 2 * reach);
  return Math.max(-reach, Math.min(reach, x)) || 0;
}

/** Čekající pust: místo v nádobě (prst), `'here'` = kdekoli, kde dávkovač právě je (klávesa), `null` = nic nečeká. */
export type PendingDrop = number | 'here' | null;

/** Má čekající pust padnout teď? Předmět musí být připravený (`clock` 0) a u prstu dávkovač nad cílem. */
export function dropNow(pending: PendingDrop, dropperX: number, clock: number): boolean {
  if (pending === null || clock > 0) return false;
  return pending === 'here' || Math.abs(dropperX - pending) <= AIM;
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
    let pending: PendingDrop = null;
    const held = new Set<number>();
    const dropperX = (): number => session.state()[bodyBase(session.state()[HEADER.player] as number) + BODY.x] as number;
    const aim = (x: number): void => session.hold(axisFor(x, reach));
    const spot = (event: PointerEvent): number | null => {
      const edges = edgesOf(element);
      if (edges === null) return null;
      const rect = element.getBoundingClientRect();
      return spotOf((event.clientX - rect.left) / rect.width, edges, reach);
    };
    const settle = (): void => {
      if (!dropNow(pending, dropperX(), clockOf(session.state()))) return;
      pending = null;
      session.press(BUTTON.TAP);
      // Držená šipka jede dál; stojí se jen, když nic nedrží ani prst, ani klávesa.
      if (finger === null && held.size === 0) session.hold(0);
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
      const x = spot(event);
      if (x === null) {
        pending = 'here';
      } else {
        pending = x;
        aim(x);
      }
      settle();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const action = keyAction(event.key);
      if (action === null) return;
      event.preventDefault();
      if (event.repeat) return;
      if (action === 0) {
        // Klávesa pustí tam, kde dávkovač bude, až je předmět připravený – i když mezitím jede pod šipkou.
        pending = 'here';
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
      else if (typeof pending !== 'number') session.hold(0);
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
