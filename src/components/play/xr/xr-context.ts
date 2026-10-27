'use client';

/**
 * Kontext VR stránky (P65 T1, plní ho `XrGate`). Tenhle soubor knihovnu XR nenačítá: čtou ho `StageHost`
 * a „Enter VR“ i bez `?vr=1`, a ta cesta nesmí stáhnout ani bajt XR.
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

import type { ArcadeSession } from '../arcade/session';
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

/** Hra, kterou ve VR řídí ovladače (P65 T2): ohlašuje ji `ArcadeStage`, čte `XrRig`. */
let game: ArcadeSession | null = null;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((listener) => listener());

/** Hraje se `session`; vrací odhlášení (jen vlastní – další hra už mohla převzít). */
export function playingInVr(session: ArcadeSession): () => void {
  game = session;
  notify();
  return () => {
    if (game !== session) return;
    game = null;
    notify();
  };
}

/** Ohlásí hru, která hraje (`enabled`), když je na stránce VR; jinak nic – 2D se nemění. */
export function XrGame({ session, enabled }: { readonly session: ArcadeSession; readonly enabled: boolean }): null {
  const vr = useXrControls() !== null;
  useEffect(() => (vr && enabled ? playingInVr(session) : undefined), [vr, enabled, session]);
  return null;
}

export function useXrGame(): ArcadeSession | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => game,
    () => null,
  );
}
