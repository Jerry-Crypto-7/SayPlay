'use client';

import { useEffect, type RefObject } from 'react';
import { AXIS_MAX, BUTTON } from '@/play/arcade/contract';
import { isTyping } from '../input';
import type { ArcadeSession } from '../session';

/** One finger owns both movement axes; secondary fingers never take it over. */
export function glideInput(shoot: boolean) {
  const keys = new Set<string>();
  const pointers = new Map<number, { x: number; y: number; dx: number; dy: number; steering: boolean }>();
  const recognised = (key: string) => ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's', 'shift', 'b'].includes(key) || shoot && key === ' ';
  const any = (...names: string[]) => names.some(name => keys.has(name));
  return {
    key(key: string, down: boolean): boolean {
      if (!recognised(key)) return false;
      if (down) keys.add(key); else keys.delete(key);
      return true;
    },
    down(id: number, x: number, y: number): void {
      if (!pointers.has(id)) pointers.set(id, { x, y, dx: 0, dy: 0, steering: ![...pointers.values()].some(pointer => pointer.steering) });
    },
    move(id: number, x: number, y: number): void {
      const pointer = pointers.get(id);
      if (pointer !== undefined) { pointer.dx = x - pointer.x; pointer.dy = y - pointer.y; }
    },
    up(id: number): void { pointers.delete(id); },
    clear(): void { keys.clear(); pointers.clear(); },
    snapshot() {
      const primary = [...pointers.values()].find(pointer => pointer.steering);
      const second = [...pointers.values()].some(pointer => !pointer.steering);
      const horizontal = Number(any('arrowright', 'd')) - Number(any('arrowleft', 'a'));
      const vertical = Number(any('arrowup', 'w')) - Number(any('arrowdown', 's'));
      const dy = primary?.dy ?? 0;
      return {
        axis: horizontal !== 0 ? horizontal * AXIS_MAX : Math.round(Math.max(-1, Math.min(1, (primary?.dx ?? 0) / 90)) * AXIS_MAX),
        buttons: (vertical > 0 || vertical === 0 && dy < -12 ? BUTTON.UP : 0) |
          (vertical < 0 || vertical === 0 && dy > 12 ? BUTTON.DOWN : 0) |
          (any('shift', 'b') || second && !shoot ? BUTTON.HOLD : 0) |
          (shoot && (any(' ') || second) ? BUTTON.FIRE : 0),
      };
    },
  };
}

export function useGlideInput(session: ArcadeSession, target: RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const input = glideInput(session.world.rules.some(rule => rule.id === 'blaster'));
    const sync = () => {
      const held = input.snapshot();
      session.hold(held.axis); session.holdButtons(held.buttons);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target) || !input.key(event.key.toLowerCase(), true)) return;
      event.preventDefault(); sync();
    };
    const keyUp = (event: KeyboardEvent) => { if (input.key(event.key.toLowerCase(), false)) sync(); };
    const down = (event: PointerEvent) => {
      element.setPointerCapture(event.pointerId);
      input.down(event.pointerId, event.clientX, event.clientY); sync();
    };
    const move = (event: PointerEvent) => { input.move(event.pointerId, event.clientX, event.clientY); sync(); };
    const up = (event: PointerEvent) => { input.up(event.pointerId); sync(); };
    const release = () => { input.clear(); sync(); };
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', release);
    element.addEventListener('pointerdown', down); element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up); element.addEventListener('lostpointercapture', up);
    return () => {
      release();
      window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); element.removeEventListener('lostpointercapture', up);
    };
  }, [session, target, active]);
}
