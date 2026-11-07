/**
 * Malovaná obloha místa (P75 T3): obraz ve stylu konceptu A za celou scénou.
 *
 * První snímek se kreslí s dnešní oblohou a stahování začne až po něm – obraz
 * nezdrží start hry. Když dorazí, prolne se přes dnešní oblohu za `PAINT_FADE_S`;
 * když nedorazí (síť, chyba), zůstane dnešní obloha. Telefon bere menší obraz.
 *
 * Bez R3F, ať se dá ověřit po snímcích; kreslí ji `Sky` v `StyleRig`.
 */

import { Color } from 'three';

import { type Look, type LookId, LOOKS, PAINTED_SKIES } from '@/play/arcade/look';

import type { QualityTier } from './quality';

/** Délka prolnutí (s) – plán chce do 1 s. */
export const PAINT_FADE_S = 0.8;
/** Nejdelší krok prolnutí za snímek (s): po nečinném plátně (`frameloop="demand"`) by jeden snímek přeskočil celé prolnutí. */
const MAX_STEP_S = 1 / 30;
/** Nálada smí obraz ztmavit libovolně, zesvětlit jen o kus. */
const TINT_MAX = 1.15;

export interface PaintedSky {
  readonly url: string;
  /** Řádek horizontu obrazu jako `v` textury (zdola). */
  readonly horizon: number;
  /** Násobek barev obrazu: poměr obzoru scény (s náladou – bouřka, noc) k obzoru místa. */
  readonly tint: Color;
}

export function paintedSkyOf(look: Look, lookId: LookId, tier: QualityTier): PaintedSky | null {
  const row = PAINTED_SKIES[lookId];
  if (row === undefined || look.ceiling !== undefined) return null;
  const [said, base] = [new Color(look.horizon), new Color(LOOKS[lookId].horizon)];
  const ratio = (scene: number, place: number) => (place <= 0.001 ? 1 : Math.min(TINT_MAX, scene / place));
  return {
    url: `/play/env/diorama-${lookId}${tier === 'high' ? '' : '-low'}.webp`,
    horizon: 1 - row,
    tint: new Color(ratio(said.r, base.r), ratio(said.g, base.g), ratio(said.b, base.b)),
  };
}

/** Stáhne obraz; zavolá `ready`, nebo `failed`. */
export type PaintLoad = (url: string, ready: () => void, failed: () => void) => void;

export interface PaintStep {
  /** 0 = dnešní obloha, 1 = malovaná. */
  readonly amount: number;
  /** Chce další snímek (plátno na požádání musí kreslit dál). */
  readonly busy: boolean;
}

/** Průběh malované oblohy po snímcích; volá se jednou za snímek s `delta` v sekundách. */
export function paintFade(url: string | null, load: PaintLoad): (delta: number) => PaintStep {
  let frames = 0;
  let state: 'waiting' | 'ready' | 'failed' = 'waiting';
  let amount = 0;
  return (delta) => {
    frames += 1;
    if (url === null) return { amount: 0, busy: false };
    // Snímek 1 se kreslí bez obrazu; stahovat se začne až ve snímku po něm.
    if (frames === 2)
      load(
        url,
        () => void (state = 'ready'),
        () => void (state = 'failed'),
      );
    if (state === 'ready') amount = Math.min(1, amount + Math.min(delta, MAX_STEP_S) / PAINT_FADE_S);
    return { amount, busy: frames < 2 || (state === 'ready' && amount < 1) };
  };
}
