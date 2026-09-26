'use client';

/**
 * Prostředí hry z věty (P29C T5) jako kontext. Zvlášť od `Panorama.tsx`, aby
 * obal hry (`PlayShell`, feed) netahal three.js do úvodního balíku stránky:
 * s importem panoramatu tam grid kreslil první snímek o ~220 ms později.
 */

import { createContext, type ReactNode, useMemo } from 'react';

import { type EnvEntry, envFor, seedOf } from '@/play/arcade/look/env';
import type { GameSpecV1 } from '@/play/spec';

/** Prostředí hry z věty – dává ho obal hry, jeviště ho předá do scény. */
export const PlayEnv = createContext<EnvEntry | null>(null);

/** Obal hry: panorama z `theme` a id verze (tatáž hra má vždy totéž pozadí). */
export function WithPlayEnv({ theme, versionId, children }: { readonly theme: GameSpecV1['theme']; readonly versionId: string; readonly children: ReactNode }) {
  const env = useMemo(() => envFor(theme, seedOf(versionId)), [theme, versionId]);
  return <PlayEnv.Provider value={env}>{children}</PlayEnv.Provider>;
}
