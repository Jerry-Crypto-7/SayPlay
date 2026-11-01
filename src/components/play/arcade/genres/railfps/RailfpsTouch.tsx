'use client';

/**
 * Dotykový adaptér střelnice z očí (P68-F T5, vstup `genre`, registr `genres/touch-registry.ts`). Volá jen
 * `session.press` / `session.hold`, osou jen z `RAILFPS_AXES` (`sectorToAxis`), takže záznam, Dare ani serverový
 * replay se nemění.
 *
 * - **Ťuk** (prst se nepohne dál než `SLOP_PX`): sloupec obrazovky → sektor podle natočení a pole, které scéna
 *   opravdu nakreslila (`data-railfps-yaw` / `data-railfps-fov` plochy hry) → `press(FIRE, sectorToAxis(s))`. Jádro
 *   natočí na sektor a vystřelí, až dorazí. Rána padá při puštění, aby tah k rozhlédnutí nevystřelil.
 * - **Tah** vodorovně: úhel, o který prst přejel po obrazovce, krát `DRAG_GAIN` od natočení na začátku tahu →
 *   `hold(sectorToAxis(s))` při každé změně sektoru; puštění → `hold(0)` (osa 0 = žádný vstup, cíl zůstane).
 * - **Klávesy**: plocha je pro vstup `genre` nemapuje (`ArcadeStage` – šipky jen u běžce a plošinovky, F jen se
 *   zbraní `blaster`), takže tady: šipky / A-D = o sektor (`LEFT` / `RIGHT`), F / J / Enter / mezerník = rána.
 *
 * Adaptér nic nekreslí – zaměřovač a značku sektoru kreslí scéna. Posluchače visí na ploše hry (rodič kotvy),
 * pohyb a puštění na `window`, aby prst, který z plochy sjede, nenechal osu drženou.
 */

import { useEffect, useRef } from 'react';

import { size } from '@/brand/tokens';
import { BUTTON } from '@/play/arcade/contract';
import { sectorToAxis } from '@/play/arcade/pieces/railfps-world';

import { isTyping } from '../../input';
import type { GenreTouchProps } from '../touch-registry';
import { screenAngle, screenToSector, sectorOfYaw } from './railfps-camera';

/** Pohyb prstu (px), od kterého je dotek tah, ne ťuk: čtvrtina nejmenšího dotykového cíle. */
const SLOP_PX = size['touch-min'] / 4;
/**
 * Tah natočí o tolikrát víc, než kolik úhlu prst přejel po obrazovce: na výšku je vidět necelé 2,5 sektoru,
 * celá šířka obrazovky tak natočí o ~3,7 sektoru, na šířku o ~8.
 */
const DRAG_GAIN = 1.5;

const KEYS: Readonly<Record<string, number>> = {
  arrowleft: BUTTON.LEFT,
  a: BUTTON.LEFT,
  arrowright: BUTTON.RIGHT,
  d: BUTTON.RIGHT,
  f: BUTTON.FIRE,
  j: BUTTON.FIRE,
  enter: BUTTON.FIRE,
  ' ': BUTTON.FIRE,
};

interface Touch {
  readonly x: number;
  /** Úhel bodu dotyku od osy kamery a natočení kamery na začátku. */
  readonly angle: number;
  readonly yaw: number;
  dragging: boolean;
  sector: number | null;
}

export function RailfpsTouch({ session }: GenreTouchProps) {
  const anchor = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const stage = anchor.current?.parentElement;
    if (stage == null) return;
    /** Co scéna naposledy nakreslila a kde na obrazovce je plátno; `null`, dokud nenakreslila první snímek. */
    const view = (clientX: number): { readonly ndcX: number; readonly yaw: number; readonly fov: number; readonly aspect: number } | null => {
      const yaw = Number(stage.dataset.railfpsYaw);
      const fov = Number(stage.dataset.railfpsFov);
      const box = (stage.querySelector('canvas') ?? stage).getBoundingClientRect();
      if (!Number.isFinite(yaw) || !Number.isFinite(fov) || box.width === 0 || box.height === 0) return null;
      return { ndcX: ((clientX - box.left) / box.width) * 2 - 1, yaw, fov, aspect: box.width / box.height };
    };

    const touches = new Map<number, Touch>();
    let looking: number | null = null;
    const stopLooking = (): void => {
      if (looking === null) return;
      looking = null;
      session.hold(0);
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const at = view(event.clientX);
      if (at === null) return;
      touches.set(event.pointerId, { x: event.clientX, angle: screenAngle(at.ndcX, at.aspect, at.fov), yaw: at.yaw, dragging: false, sector: null });
    };
    const onMove = (event: PointerEvent) => {
      const touch = touches.get(event.pointerId);
      if (touch === undefined) return;
      if (!touch.dragging) {
        // Rozhlíží se jen jeden prst naráz; další prsty zůstanou ťuky.
        if (Math.abs(event.clientX - touch.x) < SLOP_PX || looking !== null) return;
        touch.dragging = true;
        looking = event.pointerId;
      }
      const at = view(event.clientX);
      if (at === null) return;
      // Úhel od osy kamery, ne směr ve světě: kamera se za prstem točí a světový úhel by tah sám dál roztáčel.
      const sector = sectorOfYaw(touch.yaw + DRAG_GAIN * (screenAngle(at.ndcX, at.aspect, at.fov) - touch.angle));
      if (sector === touch.sector) return;
      touch.sector = sector;
      session.hold(sectorToAxis(sector));
    };
    const onUp = (event: PointerEvent) => {
      const touch = touches.get(event.pointerId);
      if (touch === undefined) return;
      touches.delete(event.pointerId);
      if (touch.dragging) {
        if (looking === event.pointerId) stopLooking();
        return;
      }
      const at = view(event.clientX);
      if (at !== null) session.press(BUTTON.FIRE, sectorToAxis(screenToSector(at.ndcX, at.yaw, at.aspect, at.fov)));
    };
    const onCancel = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      if (looking === event.pointerId) stopLooking();
    };
    const onBlur = () => {
      touches.clear();
      stopLooking();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target)) return;
      const button = KEYS[event.key.toLowerCase()];
      if (button === undefined) return;
      event.preventDefault();
      session.press(button);
    };

    stage.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
    return () => {
      stage.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
      onBlur();
    };
  }, [session]);

  return <span ref={anchor} hidden data-testid="railfps-touch" />;
}
