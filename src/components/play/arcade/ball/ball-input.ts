'use client';

import { useEffect, type RefObject } from 'react';
import { AXIS_MAX, BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { isTyping } from '../input';
import type { ArcadeSession } from '../session';

/** Pointer distance caps charge; simulation ticks, not a timer, supply power. */
export function ballInput(session: ArcadeSession) {
  let pointer: { id: number; x: number; y: number } | null = null;
  let charging = false, keyboard = false, axis = 0, limit = 1;
  const sync = () => {
    const state = session.state(), p = bodyBase(state[HEADER.player]!);
    session.hold(axis);
    session.holdButtons(charging && Math.max(0, state[p + BODY.aux1]!) < limit ? BUTTON.HOLD : 0);
  };
  const cancel = () => {
    pointer = null; charging = false; keyboard = false; axis = 0;
    session.hold(0); session.holdButtons(0); session.press(BUTTON.DOWN);
  };
  const release = () => {
    if (!charging) return;
    charging = false; keyboard = false; pointer = null;
    session.holdButtons(0); session.hold(0); session.press(BUTTON.TAP, axis);
  };
  const unsubscribe = session.subscribe(sync);
  return {
    down(id: number, x: number, y: number) {
      if (pointer !== null || keyboard) return;
      pointer = { id, x, y }; charging = true; limit = 1; axis = 0; sync();
    },
    move(id: number, x: number, y: number) {
      if (pointer?.id !== id) return;
      axis = Math.round(Math.max(-AXIS_MAX, Math.min(AXIS_MAX, (x - pointer.x) * 10)));
      limit = Math.max(1, Math.min(60, Math.round(Math.abs(y - pointer.y) / 3)));
      sync();
    },
    up(id: number) { if (pointer?.id === id) release(); },
    cancel(id?: number) { if (id === undefined || pointer?.id === id) cancel(); },
    key(key: string, down: boolean): boolean {
      if (['arrowleft', 'a', 'arrowright', 'd'].includes(key)) {
        if (down) { axis = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, axis + (key === 'arrowleft' || key === 'a' ? -80 : 80))); sync(); }
        return true;
      }
      if (key === ' ') {
        if (down && !charging) { keyboard = true; charging = true; limit = 60; sync(); }
        else if (!down && keyboard) release();
        return true;
      }
      if (key === 'escape') { if (down) cancel(); return true; }
      return false;
    },
    dispose() { unsubscribe(); cancel(); },
  };
}

export function useBallInput(session: ArcadeSession, target: RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const input = ballInput(session);
    const down = (event: PointerEvent) => { element.setPointerCapture(event.pointerId); input.down(event.pointerId, event.clientX, event.clientY); };
    const move = (event: PointerEvent) => input.move(event.pointerId, event.clientX, event.clientY);
    const up = (event: PointerEvent) => input.up(event.pointerId);
    const cancel = (event: PointerEvent) => input.cancel(event.pointerId);
    const blur = () => input.cancel();
    const keyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      if (input.key(event.key.toLowerCase(), true)) event.preventDefault();
    };
    const keyUp = (event: KeyboardEvent) => { if (input.key(event.key.toLowerCase(), false)) event.preventDefault(); };
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', blur);
    element.addEventListener('pointerdown', down); element.addEventListener('pointermove', move); element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', cancel); element.addEventListener('lostpointercapture', cancel);
    return () => {
      input.dispose();
      window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur);
      element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', cancel); element.removeEventListener('lostpointercapture', cancel);
    };
  }, [session, target, active]);
}
