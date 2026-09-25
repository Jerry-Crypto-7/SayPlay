/**
 * Časové popisky HUD. Mimo `Hud.tsx` schválně (P28E-R2): HUD mřížky táhne
 * runtime a jeho Zod schémata, a arkáda, která potřebuje jen tyhle funkce,
 * by je jinak vyhodnocovala při každém startu.
 */

import type { GameSpecV1 } from '@/play/spec';

/** Uplynulý čas pro hráče (P28B F-15): „28.1 s“, nikdy tiky. */
export const secondsOf = (tick: number, hz: number): string => `${(tick / hz).toFixed(1)} s`;

/** Zbývající čas mechaniky `timer`, nebo `null`, když hra žádný nemá. */
export function timerLeft(spec: GameSpecV1, elapsedSeconds: number): string | null {
  const timer = spec.mechanics.find((entry) => entry.id === 'timer');
  const seconds = timer?.params.seconds;
  return typeof seconds === 'number' ? `${Math.max(0, seconds - elapsedSeconds)}s left` : null;
}
