/**
 * Vzduch a světlo Toy Boxu (P70D T2). Audit 4. 11.: šedá mlha přes les i pláž začínala
 * ve třetině dohledu, takže druhá a třetí překážka běžce už byly v oparu.
 *
 * - Mlha jen na dálku: začíná nejdřív v `FOG_START` viditelné hloubky. Konec mlhy je
 *   vzdálená rovina kamery (`FarAtFog`), ten se nemění – kreslí se stejně daleko jako dřív.
 * - Barva mlhy je obzor místa sytější o `FOG_SATURATION`: bledý obzor (les `#cfeedd`)
 *   ACES dotáhl do šedobílé. Odstín se nemění, takže nic nesklouzne do fialové.
 *   Obloha u obzoru dostane tutéž barvu, jinak by na hranici terénu a oblohy zůstal šev.
 * - Jasnější polokoule a ostřejší slunce s tvrdším stínem (kit: tvrdé stíny).
 *
 * Mimo hash: čte jen vzhled, jádro o něm neví.
 */
import { Color, SRGBColorSpace } from 'three';

import type { Look } from '@/play/arcade/look';

import type { GradeFamily } from './grade';

/** Mlha začíná nejdřív v tomto podílu viditelné hloubky (AC T2: ≥ 60 %). */
export const FOG_START = 0.6;
/** Kolik sytosti (HSL, 0–1) přibude obzoru: z oblohy místa, ne šedá. */
export const FOG_SATURATION = 0.18;
/** Násobek síly polokoule (výplň stínů) a slunce (klíčové světlo). */
export const HEMI_LIFT = 1.2;
export const SUN_LIFT = 1.1;
/** Poloměr PCF stínu slunce (dřív 4): tvrdší hrana stínu pod hrdinou a překážkami. */
export const SHADOW_RADIUS = 1.5;

export interface Air {
  /** Barva mlhy, pozadí a oblohy u obzoru (`#rrggbb`). */
  readonly color: string;
  readonly near: number;
  readonly far: number;
}

const hsl = { h: 0, s: 0, l: 0 };

/** Mlha sady, jak ji rig kreslí. */
export function airOf(look: Pick<Look, 'fog' | 'horizon'>): Air {
  const [near, far] = look.fog;
  // HSL v sRGB, jak barvu vidí oko a jak ji píše paleta.
  const { h, s, l } = new Color(look.horizon).getHSL(hsl, SRGBColorSpace);
  return { color: `#${new Color().setHSL(h, Math.min(1, s + FOG_SATURATION), l, SRGBColorSpace).getHexString()}`, near: Math.max(near, FOG_START * far), far };
}

/**
 * Zlatá hodina (P73D T4): nejvyšší výška slunce (sinus elevace, ~38°), barva, ke které se slunce
 * rodiny ohřeje, a jak moc. Noc, pod vodou a interiér si svůj tón nechají (0). Níž = delší stín
 * hrdiny a obrys čitelný proti zemi; silnější slunce vrátí zemi, co šikmý dopad vzal (nejvýš ×1,2).
 */
export const GOLDEN_UP = 0.62;
export const GOLDEN_SUN = '#ffc68c';
export const GOLDEN_WARMTH: Readonly<Record<GradeFamily, number>> = { green: 0.3, warm: 0.25, cold: 0.12, water: 0, indoor: 0, dark: 0 };
const GOLDEN_GAIN_MOST = 1.2;
/** Protisvětlo (obrys hrdiny): síla k slunci sady a podíl barvy oblohy u obzoru. */
export const BACK_LIGHT = 0.45;
export const BACK_SKY = 0.5;

/** Slunce sady v zlaté hodině rodiny; mimo ni (noc, pod vodou, interiér) beze změny. */
export function goldenHour<T extends Pick<Look, 'sunDir' | 'sunColor' | 'sun'>>(look: T, family: GradeFamily): T {
  const warmth = GOLDEN_WARMTH[family];
  if (warmth === 0) return look;
  const [left, up, forward] = look.sunDir;
  const length = Math.hypot(left, up, forward);
  const rise = up / length;
  // Teplejší slunce (sopka) se nemíchá: zlatá by jeho oranžovou ochladila.
  const [own, gold] = [new Color(look.sunColor), new Color(GOLDEN_SUN)];
  const sunColor = own.r - own.b >= gold.r - gold.b ? look.sunColor : `#${own.lerp(gold, warmth).getHexString()}`;
  if (rise <= GOLDEN_UP) return { ...look, sunColor };
  // Vodorovnou složku natáhnout tak, aby jednotkový směr měl výšku `GOLDEN_UP`; strana a směr zůstanou.
  const flat = Math.hypot(left, forward) / length;
  const stretch = Math.sqrt(1 - GOLDEN_UP ** 2) / flat;
  return { ...look, sunColor, sunDir: [(left / length) * stretch, GOLDEN_UP, (forward / length) * stretch], sun: look.sun * Math.min(GOLDEN_GAIN_MOST, Math.sqrt(rise / GOLDEN_UP)) };
}

/** Polokoule a slunce sady po zvednutí (vstup už prošel `lightFloor`). */
export function liftLight<T extends Pick<Look, 'light' | 'sun'>>(look: T): T {
  return { ...look, light: [look.light[0], look.light[1], look.light[2] * HEMI_LIFT], sun: look.sun * SUN_LIFT };
}
