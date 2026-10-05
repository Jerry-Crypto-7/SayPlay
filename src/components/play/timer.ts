import type { GameSpecV1 } from '@/play/spec';

// Mimo `Hud.tsx` schválně (P28E-R2): HUD mřížky táhne runtime a jeho Zod
// schémata, a arkáda, která potřebuje jen tyhle funkce, by je jinak
// vyhodnocovala při každém startu.

/** Zbývající čas mechaniky `timer`, nebo `null`, když hra žádný nemá. */
export function timerLeft(spec: GameSpecV1, elapsedSeconds: number): string | null {
  const timer = spec.mechanics.find((entry) => entry.id === 'timer');
  const seconds = timer?.params.seconds;
  return typeof seconds === 'number' ? `${Math.max(0, seconds - elapsedSeconds)}s left` : null;
}
