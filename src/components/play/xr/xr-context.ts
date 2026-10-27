'use client';

/**
 * Kontext VR stránky (P65 T1, plní ho `XrGate`). Tenhle soubor knihovnu XR nenačítá: čtou ho `StageHost`
 * a „Enter VR“ i bez `?vr=1`, a ta cesta nesmí stáhnout ani bajt XR.
 */

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';

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

/** Hodnota sdílená se scénou XR: plátno R3F je vlastní React kořen a kontext stránky čte jen přes most. */
function shared<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    set(next: T): void {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function useShared<T>(store: ReturnType<typeof shared<T>>, server: T): T {
  return useSyncExternalStore(store.subscribe, store.get, () => server);
}

/** Hra, kterou ve VR řídí ovladače (P65 T2): ohlašuje ji `ArcadeStage`, čte `XrRig`. */
const game = shared<ArcadeSession | null>(null);

/** Hraje se `session`; vrací odhlášení (jen vlastní – další hra už mohla převzít). */
export function playingInVr(session: ArcadeSession): () => void {
  game.set(session);
  return () => {
    if (game.get() === session) game.set(null);
  };
}

/** Ohlásí hru, která hraje (`enabled`), když je na stránce VR; jinak nic – 2D se nemění. */
export function XrGame({ session, enabled }: { readonly session: ArcadeSession; readonly enabled: boolean }): null {
  const vr = useXrControls() !== null;
  useEffect(() => (vr && enabled ? playingInVr(session) : undefined), [vr, enabled, session]);
  return null;
}

export function useXrGame(): ArcadeSession | null {
  return useShared(game, null);
}

/** Počítadlo HUD pro panel VR (P65 T5): popisek jako v `data-testid="hud-counter-…"` a text, který ukazuje DOM HUD. */
export interface XrCounter {
  readonly label: string;
  readonly text: string;
}

/** Co ukazují 3D panely VR (P65 T5): tatáž data jako DOM HUD a výsledek `ArcadePlay`, jen kreslená ve scéně. */
export interface XrHudView {
  /** Hra na obrazovce – i po konci běhu, kdy ji `XrGame` už neohlašuje (výsledek leží na zamrzlé scéně). */
  readonly session: ArcadeSession;
  readonly goalLine: string;
  readonly counters: readonly XrCounter[];
  /** Výsledek běhu hráče, jakmile ho 2D ukáže (`PostRun`); `null` = hraje se. */
  readonly result: 'won' | 'lost' | null;
  /** „Again“: nový běh od tiku 0, jako „Play again“ výsledku. */
  again(): void;
}

const hud = shared<XrHudView | null>(null);

const sameHud = (a: XrHudView | null, b: XrHudView): boolean =>
  a !== null &&
  a.session === b.session &&
  a.goalLine === b.goalLine &&
  a.result === b.result &&
  a.counters.length === b.counters.length &&
  a.counters.every((counter, index) => counter.label === b.counters[index]!.label && counter.text === b.counters[index]!.text);

/**
 * Ohlásí HUD hry na obrazovce, když je na stránce VR (`view` = `null`: hra neběží na obrazovce, třeba ve feedu).
 * Stejný obsah se znovu neohlašuje – `ArcadePlay` se překresluje každý tik.
 */
export function XrHudSource({ view }: { readonly view: XrHudView | null }): null {
  const vr = useXrControls() !== null;
  const session = vr ? (view?.session ?? null) : null;
  useEffect(() => {
    if (session === null) return undefined;
    return () => {
      if (hud.get()?.session === session) hud.set(null);
    };
  }, [session]);
  useEffect(() => {
    if (vr && view !== null && !sameHud(hud.get(), view)) hud.set(view);
  });
  return null;
}

export function useXrHud(): XrHudView | null {
  return useShared(hud, null);
}

/**
 * Panel „AI version ready“ (P65 T5): `arrived` = stránka sama přešla na hru ze čtení (ve 2D „Matched your idea“),
 * `ready` = hotová verze čeká na klepnutí jako tlačítko přepínače verze ve 2D; `open` ji otevře.
 */
export type XrNotice = { readonly kind: 'arrived' } | { readonly kind: 'ready'; open(): void };

const notice = shared<XrNotice | null>(null);

/** `UpgradeBanner` ohlásí, co by ve 2D ukázal; jen když je na stránce VR. `open` se volá vždy nejnovější. */
export function useXrNoticeSource(value: XrNotice | null): void {
  const vr = useXrControls() !== null;
  const kind = vr ? (value?.kind ?? null) : null;
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  useEffect(() => {
    if (kind === null) return undefined;
    const mine: XrNotice = kind === 'arrived' ? { kind } : { kind, open: () => (latest.current?.kind === 'ready' ? latest.current.open() : undefined) };
    notice.set(mine);
    return () => {
      if (notice.get() === mine) notice.set(null);
    };
  }, [kind]);
}

export function useXrNotice(): XrNotice | null {
  return useShared(notice, null);
}
