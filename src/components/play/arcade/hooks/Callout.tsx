/**
 * Hláška háčků (P66 T4): krátký štítek kitu pod horním pásem HUD, nikdy přes hrdinu (`play-hooks.css`), z uzavřeného
 * seznamu `CALLOUTS`. Jádro hlásí milníky komba, vyčištěné kolo a epický nález (`callout`); vstup bosse
 * (`boss_enter`) dá „Boss!“ sám. Visí jedna naráz – přijde-li jich v tiku víc, vyhraje nejdůležitější, nová
 * přebije starou. Přebitý rekord a výzvu kamaráda sem pošle `ArcadePlay` (T11, `cheerView`). Jen DOM, mimo hash.
 */

import type { CalloutId, HookEffect } from '@/play/arcade/hooks/contract';

import { AHEAD, NEW_BEST } from '../../starters';

/**
 * Viditelný text (anglicky, sentence case, `docs/brand/docs/11-voice-copy.md`). Násobič je „×“ jako na pilulce
 * komba v HUD (`PowerupBadge.tsx`), ať jedno kombo nemá na obrazovce dva zápisy.
 */
export const CALLOUT_TEXT: Readonly<Record<CalloutId, string>> = {
  combo_2: 'Combo ×2',
  combo_3: 'Combo ×3',
  combo_max: 'Max combo!',
  round_clear: 'Round clear!',
  epic_find: 'Epic find!',
  boss: 'Boss!',
  new_best: NEW_BEST,
  // Body výzvy přebité za běhu (T11): vyhrát ještě musí, „You beat it!“ řekne až výsledek (`AHEAD`, P36B T7).
  beat_it: AHEAD,
};

/** Jak dlouho hláška visí (ms, CSS `play-hook-callout`). */
export const CALLOUT_MS = 1200;

/** Pořadí důležitosti od nejmenší: v jednom tiku vyhraje hláška víc vpravo. */
const CALLOUT_RANK: readonly CalloutId[] = ['combo_2', 'combo_3', 'combo_max', 'epic_find', 'round_clear', 'boss', 'beat_it', 'new_best'];

/** Hláška tiku: nejdůležitější z `callout` a `boss_enter`; tik bez nich `null`. */
export function calloutOf(effects: readonly HookEffect[]): CalloutId | null {
  let best: CalloutId | null = null;
  for (const effect of effects) {
    const id = effect.kind === 'callout' ? effect.callout : effect.kind === 'boss_enter' ? 'boss' : null;
    if (id !== null && (best === null || CALLOUT_RANK.indexOf(id) > CALLOUT_RANK.indexOf(best))) best = id;
  }
  return best;
}

export interface ShownCallout {
  readonly id: CalloutId;
  /** Čas kresby (ms) nástupu; `key` přehraje nástup, když táž hláška přijde znovu po zhasnutí. */
  readonly at: number;
  readonly key: number;
}

/** Hláška `id` v čase `now`: táž, která ještě visí, se nepřehraje znovu (jádro ji mohlo poslat i o tik později). */
export function showCallout(current: ShownCallout | null, id: CalloutId, now: number, key: number): ShownCallout {
  return current !== null && current.id === id && now - current.at < CALLOUT_MS ? current : { id, at: now, key };
}

export function Callout({ callout }: { readonly callout: ShownCallout | null }) {
  if (callout === null) return null;
  // Boss je hrozba (rajčatový štítek jako banner průběhu), ostatní odměna (slunečný).
  const tone = callout.id === 'boss' ? 'sp-world-tag' : 'sp-world-tag sp-world-tag--goal';
  return (
    <p key={callout.key} className={`${tone} play-hook-callout`} data-testid="hook-callout" data-callout={callout.id} role="status">
      {CALLOUT_TEXT[callout.id]}
    </p>
  );
}
