'use client';

/**
 * Kulisa, která se ukáže až s přeloženým programem shaderu (P68-M T2). Modely ulice a rostliny vegetace doběhnou po
 * prvním snímku a three by program nového materiálu přeložil v prvním snímku, který je kreslí: na Pixelu 7 (CPU ×4)
 * stálo sedm takových programů ~435 ms hlavního vlákna právě ve chvíli, kdy hráč (i sonda času do hratelnosti) poprvé
 * ťuká. Tenhle modul je bez `@react-three/fiber` – `Scenery` ho importuje stránka gridu staticky (P29C T5); renderer
 * dodá plátno hry kontextem (`WarmerProvider` ve `warm.tsx`). Bez kontextu se díl ukáže hned jako dřív.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import type { Object3D } from 'three';

export interface Warmer {
  /** Má podstrom materiál bez přeloženého programu? */
  cold(part: Object3D): boolean;
  /** Přeloží programy podstromu mimo hlavní vlákno; splní se, až jsou hotové. */
  warm(part: Object3D): Promise<void>;
}

export const WarmerContext = createContext<Warmer | null>(null);

/** `part`, až má přeložené programy: studený se přeloží a vrátí až potom, teplý hned. `null` zůstává `null`. */
export function useWarmed<T extends Object3D>(part: T | null): T | null {
  const warmer = useContext(WarmerContext);
  const [warmed, setWarmed] = useState<T | null>(null);
  const cold = warmer !== null && part !== null && part !== warmed && warmer.cold(part);
  useEffect(() => {
    if (!cold || warmer === null || part === null) return;
    let live = true;
    void warmer.warm(part).then(() => {
      if (live) setWarmed(part);
    });
    return () => {
      live = false;
    };
  }, [cold, warmer, part]);
  return cold ? null : part;
}
