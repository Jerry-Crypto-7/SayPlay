/**
 * Úrovně kvality rigu (P32A T2): kolik postprocessingu, jak ostrý obraz a jak
 * velký stín si zařízení dovolí, aby běžec na telefonu držel 30 FPS.
 *
 * Start podle `devicePixelRatio` (telefon má hustý displej a slabší GPU), pak
 * podle průběžného FPS: pod `DOWN_FPS` souvisle `DOWN_MS` → o úroveň níž,
 * nad `UP_FPS` souvisle `UP_MS` → o úroveň výš. Pásmo mezi prahy nedělá nic.
 * Proti kmitání: úroveň, ze které hra spadla brzy po návratu na ni, se už
 * nezkouší (strop klesne).
 *
 * Mimo hash: úroveň mění jen obraz, jádro ji nečte. Sonda ji hlásí jako
 * `data-quality` na `arcade-stage`.
 */

import type { Look } from '@/play/arcade/look';

export const QUALITY_TIERS = ['low', 'medium', 'high'] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

export interface TierSettings {
  readonly bloom: boolean;
  /** N8AO; `half` = v polovičním rozlišení s levnějším vzorkováním. */
  readonly ao: 'full' | 'half' | false;
  /** Hrana stínové mapy slunce (px). */
  readonly shadowMapSize: number;
  /**
   * Polovina výřezu stínu (m). Stínový průchod kreslí každé tělo ve výřezu znovu a
   * při nízkém slunci zezadu ±18 m pokryje ~50 m trati: běžec na Pixel 7 se 4× CPU
   * ~270 draw callů a ~20 FPS i na `low`, s ±12 ~170 (měřeno 29. 9.).
   */
  readonly shadowHalf: number;
  /** Strop poměru pixelů plátna. */
  readonly dpr: number;
  /** Hranování: SMAA průchodem skládače, nebo MSAA jeho cíle kreslení. */
  readonly aa: 'smaa' | 'msaa';
}

/**
 * Skládač (ACES a ladění barev) kreslí na každé úrovni, `low` jen bez AO a bloomu
 * a hranuje levnějším MSAA (P37B T7). Dřív `low` skládač neměl a tónoval renderer:
 * přepnutí úrovně tím změnilo cíl kreslení scény a tónování, three přeložil
 * shadery všech materiálů a telefon (Pixel 7, CPU 4×) stál 1–2 s pod 10 FPS.
 */
export const TIER_SETTINGS: Readonly<Record<QualityTier, TierSettings>> = {
  high: { bloom: true, ao: 'full', shadowMapSize: 2048, shadowHalf: 18, dpr: 2, aa: 'smaa' },
  medium: { bloom: true, ao: 'half', shadowMapSize: 2048, shadowHalf: 12, dpr: 1.5, aa: 'smaa' },
  low: { bloom: false, ao: false, shadowMapSize: 1024, shadowHalf: 5, dpr: 1, aa: 'msaa' },
};

/**
 * Rezerva nad cílem 40 FPS (P37B T7): na `medium` se telefon (Pixel 7, CPU 4×)
 * držel 40–45 FPS a o snímky pod 40 se dělil s šumem. Sestup už nic nepřekládá
 * (skládač kreslí na každé úrovni), takže dřívější sestup nic nestojí.
 */
export const DOWN_FPS = 45;
export const DOWN_MS = 3000;
export const UP_FPS = 55;
export const UP_MS = 8000;
/** Pád do této doby po návratu = vyšší úroveň nestačí, strop se sníží. */
export const PROBATION_MS = 20_000;
/** Mezera mezi vzorky delší než tohle (pauza, skrytá záložka) začíná měření znovu. */
export const GAP_MS = 1500;

export interface QualityState {
  readonly tier: QualityTier;
  /** Nejvyšší úroveň, na kterou se hra ještě smí vrátit. */
  readonly ceiling: QualityTier;
  /** Od kdy (ms) je FPS souvisle pod prahem sestupu, resp. nad prahem návratu. */
  readonly slowSince: number | null;
  readonly fastSince: number | null;
  /** Kdy úroveň naposled stoupla. */
  readonly raisedAt: number | null;
  readonly lastAt: number | null;
}

const rank = (tier: QualityTier): number => QUALITY_TIERS.indexOf(tier);

/**
 * Telefon (dotyk) a hustý displej startují na `medium`, desktop na `high` (P56B T8: start na `low` dával telefonu
 * levný první snímek bez bloomu a AO). Kdo `medium` neudrží, za `DOWN_MS` spadne na `low`; volný čas snímku vrací výš.
 */
export function startQuality(devicePixelRatio: number, coarsePointer = false): QualityState {
  return { tier: coarsePointer || devicePixelRatio > 2 ? 'medium' : 'high', ceiling: 'high', slowSince: null, fastSince: null, raisedAt: null, lastAt: null };
}

/**
 * Jeden vzorek: FPS za úsek od předchozího vzorku do `now` (ms). Souvislý úsek
 * začíná začátkem svého prvního vzorku; první vzorek po pauze jen začne měřit.
 */
export function sampleQuality(state: QualityState, fps: number, now: number): QualityState {
  const resumed = state.lastAt === null || now - state.lastAt > GAP_MS;
  const slowSince = resumed ? null : state.slowSince;
  const fastSince = resumed ? null : state.fastSince;
  const start = resumed ? now : state.lastAt!;
  const at = { ...state, lastAt: now };

  if (fps < DOWN_FPS) {
    const since = slowSince ?? start;
    if (now - since < DOWN_MS || state.tier === 'low') return { ...at, slowSince: since, fastSince: null };
    const tier = QUALITY_TIERS[rank(state.tier) - 1]!;
    const failedRetry = state.raisedAt !== null && now - state.raisedAt < PROBATION_MS;
    return { ...at, tier, ceiling: failedRetry ? tier : state.ceiling, slowSince: null, fastSince: null, raisedAt: null };
  }
  if (fps >= UP_FPS) {
    const since = fastSince ?? start;
    if (now - since < UP_MS || rank(state.tier) >= rank(state.ceiling)) return { ...at, slowSince: null, fastSince: since };
    return { ...at, tier: QUALITY_TIERS[rank(state.tier) + 1]!, slowSince: null, fastSince: null, raisedAt: now };
  }
  return { ...at, slowSince: null, fastSince: null };
}

/**
 * Práh jasu bloomu: nad nejjasnější matně osvětlenou bílou plochou sady
 * (slunce + polokoule, Lambert /π), takže září jen emise a slunce na obloze,
 * ne sníh na slunci.
 */
export function bloomThreshold(look: Pick<Look, 'sun' | 'light'>): number {
  return Math.max(1, (look.sun + look.light[2]) / Math.PI) * 1.1;
}
