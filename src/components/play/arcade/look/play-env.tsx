'use client';

/**
 * Prostředí hry z věty (P29C T5) jako kontext. Zvlášť od `Panorama.tsx`, aby
 * obal hry (`PlayShell`, feed) netahal three.js do úvodního balíku stránky:
 * s importem panoramatu tam grid kreslil první snímek o ~220 ms později.
 */

import { createContext, type ReactNode, useMemo } from 'react';

import { type EnvEntry, envFor, seedOf, settingInLibrary } from '@/play/arcade/look/env';
import type { GameSpecV1 } from '@/play/spec';

export interface PlayEnvValue extends EnvEntry {
  /**
   * Kde se ptát na vlastní panorama (P29C T7) – jen publikovaná hra, jejíž
   * prostředí knihovna nezná. `null` = knihovní panorama je konečné.
   */
  readonly poll: string | null;
}

/** Prostředí hry z věty – dává ho obal hry, jeviště ho předá do scény. */
export const PlayEnv = createContext<PlayEnvValue | null>(null);

/** Id publikované verze (`VERSION_ID_PATTERN`); demo a náhledy vlastní panorama nemají. */
const PUBLISHED_ID = /^[a-f0-9]{8,64}$/;

/** Obal hry: panorama z `theme` a id verze (tatáž hra má vždy totéž pozadí). */
export function WithPlayEnv({ theme, versionId, children }: { readonly theme: GameSpecV1['theme']; readonly versionId: string; readonly children: ReactNode }) {
  const env = useMemo(
    () => ({
      ...envFor(theme, seedOf(versionId)),
      poll: PUBLISHED_ID.test(versionId) && !settingInLibrary(theme.setting) ? `/api/play/games/${versionId}/env` : null,
    }),
    [theme, versionId],
  );
  return <PlayEnv.Provider value={env}>{children}</PlayEnv.Provider>;
}
