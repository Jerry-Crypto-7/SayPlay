/**
 * P68V: popisky počítadel HUD, které hry `stunt` a `minigolf` ukazují a které `e2e/hud-labels.ts`
 * (`HUD_COUNTER_LABELS`, vlastní P68-I) zatím nezná. e2e pruhu ověřuje popisky proti
 * `HUD_COUNTER_LABELS` ∪ tomuto seznamu; P68-I je při zapojení hry dopíše do sdíleného seznamu
 * (požadavek v `integration.md` → „Popisky HUD“). Malými písmeny jako sdílený seznam.
 */

export const P68V_HUD_LABELS: readonly string[] = [
  /** `stunt`: trosky rozbité nárazem. */
  'smash',
  /** `stunt`: skoky (tiky ve vzduchu přepočtené na skoky). */
  'air',
  /** `minigolf`: počet ran. */
  'strokes',
  /** `minigolf`: par jamky. */
  'par',
];
