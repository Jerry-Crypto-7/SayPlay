/**
 * Váha událostí (P36C T7): kolik trvá hit-stop, blikání po zásahu, zpomalení
 * a přiblížení výhry a ztmavnutí prohry. Čisté funkce času kresby (ms) – scény
 * je čtou ve `useFrame`, do stavu hry ani hashe nepíšou nic.
 *
 * „Méně pohybu“ (`prefers-reduced-motion`) vypne zpomalení, přiblížení i otřes;
 * hit-stop (kresba stojí), blikání a ztmavnutí zůstávají – nic se jimi nehýbe.
 */

/** Hit-stop: kresba stojí tolik ms po zásahu – v aréně (`FightFx.tsx`) i mimo ni. */
export const HIT_STOP_MS = 60;

/**
 * Blikání hrdiny po zásahu (ms) a perioda (ms). Jádro této větve nezranitelnost
 * nevystavuje; po sloučení P36A (`graceOf`) délku určí milost hráče.
 */
export const BLINK_MS = 600;
const BLINK_PERIOD_MS = 120;

/** Výhra: zpomalení efektů (podíl rychlosti) na `WIN_SLOW_MS` a přiblížení kamery. */
export const WIN_SLOW_MS = 500;
export const WIN_SLOW_SCALE = 0.3;
export const WIN_ZOOM = 1.18;

/** Prohra: scéna se odbarví a ztmaví za tolik ms (CSS `data-fx="lose"` v `play.css`). */
export const LOSE_FADE_MS = 600;

/** Největší posun kamery při otřesu po zásahu hráče (m). */
export const SHAKE_M = 0.14;

/** Stojí kresba `ms` po zásahu? */
export const hitStopHeld = (ms: number): boolean => ms >= 0 && ms < HIT_STOP_MS;

/** Je hrdina `ms` po zásahu zrovna zhasnutý? Bliká až po hit-stopu, ve stoje by zmizel celý. */
export function blinkHidden(ms: number): boolean {
  const since = ms - HIT_STOP_MS;
  return since >= 0 && since < BLINK_MS && Math.floor(since / (BLINK_PERIOD_MS / 2)) % 2 === 0;
}

/** Rychlost času efektů `ms` po výhře: první půl sekundy zpomaleně, s „méně pohybu“ vždy 1. */
export const winTimeScale = (ms: number, reduced: boolean): number => (reduced || ms < 0 || ms >= WIN_SLOW_MS ? 1 : WIN_SLOW_SCALE);

/** Přiblížení kamery `ms` po výhře: náběh za `WIN_SLOW_MS` (ease-out), pak drží do restartu. */
export function winZoom(ms: number, reduced: boolean): number {
  if (reduced || ms < 0) return 1;
  const t = Math.min(1, ms / WIN_SLOW_MS);
  return 1 + (WIN_ZOOM - 1) * (1 - (1 - t) ** 3);
}

/** Výchylka otřesu (m) z doznívání 0..1; s „méně pohybu“ nula. */
export const shakeAmount = (shake: number, reduced: boolean): number => (reduced ? 0 : shake * shake * SHAKE_M);

/**
 * Násobič komba z efektů tiku. Jádro P36A vydá `{ kind: 'combo', multiplier }`
 * (P36A T5); tahle větev ho ještě nemá, odezva „×N“ na něj čeká.
 */
export function comboOf(effects: readonly { readonly kind: string }[]): number | null {
  let best: number | null = null;
  for (const effect of effects) {
    const multiplier = (effect as { readonly multiplier?: unknown }).multiplier;
    if (effect.kind === 'combo' && typeof multiplier === 'number' && multiplier > 1) best = Math.max(best ?? 0, multiplier);
  }
  return best;
}

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
