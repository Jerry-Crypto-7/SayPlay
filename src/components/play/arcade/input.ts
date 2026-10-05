/**
 * Sdílená pravidla vstupu her (P28B T1, T4). Hry poslouchají klávesy na `window`,
 * takže bez `isTyping` by si vzaly písmena a mezerník z pole remixu.
 */

import { BUTTON } from '@/play/arcade/contract';

import type { ArcadeSession } from './session';

/** Klávesa do pole formuláře patří větě, ne hře ani feedu. */
export const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);

export const SWIPE_PX = 30;

/**
 * Nejdelší ťuk. Běžný trvá 50–150 ms; 200 ms unese i pomalejší prst, delší
 * stisk bez tahu je položený prst, ne skok.
 */
export const TAP_MS = 200;

interface Point {
  readonly clientX: number;
  readonly clientY: number;
  /** `PointerEvent.timeStamp` – hodiny vstupu, ne replaye; do záznamu jde jen tik stisku. */
  readonly timeStamp: number;
}

/**
 * Dotyk běžce (P36C T1). Do P28B T4 skok padal už při položení prstu, takže
 * každý tah do strany skočil – i do překážky. Teď o gestu rozhodne tah:
 * za `SWIPE_PX` do strany = pruh, dolů = skluz, nahoru = skok hned při
 * překročení prahu (bez čekání na puštění). Bez tahu je skok až puštění
 * do `TAP_MS` – ťuk tím přidá svou délku (50–150 ms ≈ 3–9 tiků), tah
 * nahoru jen čas do 30 px (≈ 1–2 tiky).
 */
export function runnerGesture(session: Pick<ArcadeSession, 'press'>) {
  let start: { x: number; y: number; at: number } | null = null;
  return {
    down(event: Point): void {
      start = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    },
    move(event: Point): void {
      if (start === null) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
      start = null;
      if (Math.abs(dx) > Math.abs(dy)) session.press(dx < 0 ? BUTTON.LEFT : BUTTON.RIGHT);
      else session.press(dy > 0 ? BUTTON.DOWN : BUTTON.TAP);
    },
    /** Puštění: bez rozhodnutého tahu a do `TAP_MS` je to ťuk = skok. */
    up(event: Point): void {
      if (start !== null && event.timeStamp - start.at <= TAP_MS) session.press(BUTTON.TAP);
      start = null;
    },
    /** Zrušený dotyk (`pointercancel`) nic nedokončí. */
    cancel(): void {
      start = null;
    },
  };
}
