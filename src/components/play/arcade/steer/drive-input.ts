import { AXIS_MAX, BUTTON } from '@/play/arcade/contract';

export type DriveInputMode = 'drive' | 'shoot' | 'land';
type Key = 'left' | 'right' | 'brake' | 'thrust' | 'fire';
const DRAG_PX = 90;

/** Pointer ownership persists until release: lifting steering never steals fire. */
export function driveInput(mode: DriveInputMode) {
  const keys = new Set<string>();
  const pointers = new Map<number, { x: number; axis: number; steering: boolean }>();
  const keyOf = (key: string): Key | null =>
    ['arrowleft', 'a'].includes(key) ? 'left' : ['arrowright', 'd'].includes(key) ? 'right' :
      ['arrowdown', 's'].includes(key) ? 'brake' : mode === 'land' && ['arrowup', 'w', ' '].includes(key) ? 'thrust' :
        mode === 'shoot' && key === ' ' ? 'fire' : null;
  const has = (action: Key): boolean => [...keys].some(key => keyOf(key) === action);
  return {
    key(key: string, down: boolean): boolean {
      if (keyOf(key) === null) return false;
      if (down) keys.add(key); else keys.delete(key);
      return true;
    },
    keyAxis: () => ((has('right') ? 1 : 0) - (has('left') ? 1 : 0)) * AXIS_MAX,
    down(id: number, x: number): void {
      if (pointers.has(id)) return;
      pointers.set(id, { x, axis: 0, steering: ![...pointers.values()].some(pointer => pointer.steering) });
    },
    move(id: number, x: number): void {
      const pointer = pointers.get(id);
      if (pointer !== undefined) pointer.axis = Math.round(Math.max(-1, Math.min(1, (x - pointer.x) / DRAG_PX)) * AXIS_MAX);
    },
    up(id: number): void { pointers.delete(id); },
    clear(): void { keys.clear(); pointers.clear(); },
    snapshot(wheelAxis = 0) {
      const ordered = [...pointers.values()];
      const drag = (mode === 'shoot' ? ordered.find(pointer => pointer.steering) : ordered[0])?.axis ?? 0;
      const second = mode === 'shoot' ? ordered.some(pointer => !pointer.steering) : ordered.length > 1;
      return {
        axis: wheelAxis !== 0 ? wheelAxis : drag,
        buttons: (has('brake') || second && mode === 'drive' ? BUTTON.DOWN : 0) |
          (has('thrust') || second && mode === 'land' ? BUTTON.UP : 0) |
          (has('fire') || second && mode === 'shoot' ? BUTTON.FIRE : 0),
      };
    },
  };
}
