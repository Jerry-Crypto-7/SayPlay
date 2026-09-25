import { useEffect, useRef } from 'react';
import type { PerspectiveCamera, Vector3 } from 'three';

/**
 * Úvodní průlet (P28D T6, F-29): první 1,5 s kamera přijíždí z širokého
 * záběru na kulisy k hernímu pohledu, ať hráč prostředí věty uvidí dřív, než
 * se začne dívat jen na hrdinu. Jen kamera – jádro, hash ani vstup o něm
 * nevědí. První vstup průlet ukončí.
 */

export const INTRO_S = 1.5;
/** O kolik dál je kamera na začátku průletu (násobek vzdálenosti k bodu pohledu). */
const INTRO_PULL = 1.8;
/** O kolik metrů výš začíná. */
const INTRO_RISE = 4;

/** Kolik průletu zbývá (1 = začátek, 0 = herní pohled); ease-out, ať hráč brzy vidí hrdinu zblízka. */
export function introLeft(elapsed: number): number {
  const t = Math.min(1, Math.max(0, elapsed / INTRO_S));
  return (1 - t) ** 3;
}

/** Posune už postavenou herní kameru po dráze průletu; `look` je bod, na který kamera míří. */
export function applyIntro(camera: PerspectiveCamera, look: Vector3, left: number): void {
  if (left <= 0) return;
  camera.position.sub(look).multiplyScalar(1 + INTRO_PULL * left).add(look);
  camera.position.y += INTRO_RISE * left;
  camera.lookAt(look);
}

/**
 * Vteřiny od prvního snímku; po prvním vstupu hned konec průletu. Nástěnné
 * hodiny, ne `three.clock`: plátno po konci běhu přepne na `frameloop="demand"`
 * (P28E T2) a tím hodiny R3F vynuluje – průlet by se rozjel znovu a kamera
 * odjela 2,8× dál. Kamera je mimo hash, wall-clock tu smí.
 */
export function useIntroClock(): () => number {
  const start = useRef<number | null>(null);
  const done = useRef(false);
  useEffect(() => {
    const end = () => {
      done.current = true;
    };
    window.addEventListener('keydown', end, { once: true });
    window.addEventListener('pointerdown', end, { once: true });
    return () => {
      window.removeEventListener('keydown', end);
      window.removeEventListener('pointerdown', end);
    };
  }, []);
  return () => {
    if (done.current) return INTRO_S;
    const now = performance.now() / 1000;
    start.current ??= now;
    return now - start.current;
  };
}
