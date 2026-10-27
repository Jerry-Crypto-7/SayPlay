'use client';

/**
 * Kontext VR stránky (P65 T1, plní ho `XrGate`). Tenhle soubor knihovnu XR nenačítá: čtou ho `StageHost`
 * a „Enter VR“ i bez `?vr=1`, a ta cesta nesmí stáhnout ani bajt XR.
 */

import { createContext, useContext } from 'react';

import type { StageTunnel } from '../feed/stage-tunnel';

/**
 * Trvalé plátno s XR relací, do kterého kreslí každá hra pod `/play`, dokud žije layout. `null` = VR na stránce
 * není (bez `?vr=1` nebo bez podpory) a hra má vlastní plátno jako dřív.
 */
export const XrHostContext = createContext<StageTunnel | null>(null);

/** Ovládání relace pro „Enter VR“ / „Exit VR“. `null` = VR na stránce není. */
export interface XrControls {
  readonly presenting: boolean;
  enter(): Promise<void>;
  exit(): void;
}

export const XrControlsContext = createContext<XrControls | null>(null);

export function useXrHost(): StageTunnel | null {
  return useContext(XrHostContext);
}

export function useXrControls(): XrControls | null {
  return useContext(XrControlsContext);
}
