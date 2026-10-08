'use client';

import { useEffect, type RefObject } from 'react';
import { AXIS_MAX, BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { isTyping } from '../input';
import type { ArcadeSession } from '../session';

/** Pointer distance caps charge; simulation ticks, not a timer, supply power. */
export function ballInput(session: ArcadeSession) {
  const dribbles = session.world.control.id === 'assembly_control';
  const keys = new Set<string>();
  let movement: { id: number; x: number; y: number; buttons: number } | null = null;
  const direction = (key: string) => key === 'arrowleft' || key === 'a' ? BUTTON.LEFT : key === 'arrowright' || key === 'd' ? BUTTON.RIGHT : key === 'arrowup' || key === 'w' ? BUTTON.UP : key === 'arrowdown' || key === 's' ? BUTTON.DOWN : 0;
  const movementButtons = () => [...keys].reduce((buttons, key) => buttons | direction(key), movement?.buttons ?? 0);
  let pointer: { id: number; x: number; y: number } | null = null;
  let charging = false, keyboard = false, axis = 0, limit = 1;
  const sync = () => {
    const state = session.state(), p = bodyBase(state[HEADER.player]!);
    session.hold(axis);
    session.holdButtons(movementButtons() | (charging && Math.max(0, state[p + BODY.aux1]!) < limit ? BUTTON.HOLD : 0));
  };
  const cancel = () => {
    pointer = null; movement = null; keys.clear(); charging = false; keyboard = false; axis = 0;
    // On a composed pitch DOWN alone dribbles; DOWN+UP is the charge reset there.
    session.hold(0); session.holdButtons(0); session.press(dribbles ? BUTTON.DOWN | BUTTON.UP : BUTTON.DOWN);
  };
  const release = () => {
    if (!charging) return;
    charging = false; keyboard = false; pointer = null;
    session.holdButtons(movementButtons()); session.hold(0); session.press(BUTTON.TAP, axis);
  };
  const unsubscribe = session.subscribe(sync);
  return {
    down(id: number, x: number, y: number, dribble = false) {
      if (dribbles && dribble) { if (movement === null) movement = { id, x, y, buttons: 0 }; sync(); return; }
      if (pointer !== null || keyboard) return;
      pointer = { id, x, y }; charging = true; limit = 1; axis = 0; sync();
    },
    move(id: number, x: number, y: number) {
      if (movement?.id === id) {
        const dx = x - movement.x, dy = y - movement.y;
        movement.buttons = (Math.abs(dx) < 12 ? 0 : dx < 0 ? BUTTON.LEFT : BUTTON.RIGHT) | (Math.abs(dy) < 12 ? 0 : dy < 0 ? BUTTON.UP : BUTTON.DOWN);
        sync(); return;
      }
      if (pointer?.id !== id) return;
      axis = Math.round(Math.max(-AXIS_MAX, Math.min(AXIS_MAX, (x - pointer.x) * 10)));
      limit = Math.max(1, Math.min(60, Math.round(Math.abs(y - pointer.y) / 3)));
      sync();
    },
    up(id: number) { if (movement?.id === id) { movement = null; sync(); } else if (pointer?.id === id) release(); },
    cancel(id?: number) { if (id !== undefined && movement?.id === id) { movement = null; sync(); } else if (id === undefined || pointer?.id === id) cancel(); },
    key(key: string, down: boolean): boolean {
      if (dribbles && direction(key)) { if (down) keys.add(key); else keys.delete(key); sync(); return true; }
      if (['arrowleft', 'a', 'arrowright', 'd', ...(dribbles ? ['q', 'e'] : [])].includes(key)) {
        if (down) { axis = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, axis + (key === 'arrowleft' || key === 'a' || key === 'q' ? -80 : 80))); sync(); }
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
    const down = (event: PointerEvent) => { element.setPointerCapture(event.pointerId); input.down(event.pointerId, event.clientX, event.clientY, event.clientX < element.getBoundingClientRect().left + element.clientWidth * .35); };
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
