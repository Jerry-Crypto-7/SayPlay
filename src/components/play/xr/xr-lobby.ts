'use client';

/**
 * Stav VR lobby (P67 T2): karty vět, klávesnice a „Make it!“ ve scéně. Žije jen v kódu XR (chunk `XrRoot`):
 * `xr-context.ts` jde do prvního JS každého telefonu, a to dvakrát (layout i feed), proto tam lobby nepatří.
 * Otevře ho „Enter VR“ na domově `/play` (`enterVr({ lobby: true })`) a „New game“ na panelu výsledku.
 * `made` = „Make it!“ poslal hráče na novou hru: lobby zmizí, jakmile je na obrazovce jiná hra než `from` (ta, nad
 * kterou stálo) – mezera mezi dvěma hrami při navigaci ho nezavře.
 */

import type { ArcadeSession } from '../arcade/session';
import { shared, useShared } from './xr-context';

export type XrLobbyState = { readonly made: false } | { readonly made: true; readonly from: ArcadeSession | null };

const lobby = shared<XrLobbyState | null>(null);

export function openXrLobby(): void {
  lobby.set({ made: false });
}

export function closeXrLobby(): void {
  if (lobby.get() !== null) lobby.set(null);
}

/** „Make it!“ vrátil adresu nové hry; `from` je hra na obrazovce v tu chvíli (`null` = žádná). */
export function madeInXrLobby(from: ArcadeSession | null): void {
  lobby.set({ made: true, from });
}

export function useXrLobby(): XrLobbyState | null {
  return useShared(lobby, null);
}

/** Lobby je na obrazovce: otevřené a hra, kterou udělalo, ještě nepřišla. */
export const lobbyShown = (state: XrLobbyState | null, shown: ArcadeSession | null): boolean => state !== null && !(state.made && shown !== null && shown !== state.from);
