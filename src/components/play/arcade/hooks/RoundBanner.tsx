/**
 * Banner kola (P66 T4): „Round 2 of 3“ na `round_start`, zhasne do 1 s a hra pod ním běží – ťuky jdou skrz
 * (`play-hooks.css`). Hra bez kol (`rounds` 1) banner nemá. Jen DOM ze zpráv jádra, mimo hash.
 */

import type { HookEffect } from '@/play/arcade/hooks/contract';

/** Jak dlouho banner visí (ms, CSS `play-hook-round`). */
export const ROUND_BANNER_MS = 900;

/** Nápis kola: `round` je index 0..`rounds`−1. */
export const roundText = (round: number, rounds: number): string => `Round ${round + 1} of ${rounds}`;

export interface ShownRound {
  readonly round: number;
  readonly rounds: number;
  /** Čas kresby (ms) nástupu. */
  readonly at: number;
  readonly key: number;
}

/** Začátek kola v tiku (poslední, kdyby jich bylo víc); hra s jedním kolem ani tik bez něj nic. */
export function roundStartOf(effects: readonly HookEffect[]): { readonly round: number; readonly rounds: number } | null {
  let start: { readonly round: number; readonly rounds: number } | null = null;
  for (const effect of effects) if (effect.kind === 'round_start' && effect.rounds > 1) start = { round: effect.round, rounds: effect.rounds };
  return start;
}

export function RoundBanner({ banner }: { readonly banner: ShownRound | null }) {
  if (banner === null) return null;
  return (
    <p key={banner.key} className="play-hook-round" data-testid="hook-round-banner" data-round={banner.round} role="status">
      {roundText(banner.round, banner.rounds)}
    </p>
  );
}
