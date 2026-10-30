/**
 * Vzácnost sebraných věcí na obrazovce (P66 T4). Za hry: na `rare_found` pilulka v rámečku vzácnosti vpravo pod
 * časovačem s počtem nálezů té vzácnosti v běhu („2 rare“). Ve výsledku řádek nálezů podle vzácnosti
 * (`FoundRow`, `PostRun.tsx`) z počtů, které drží stav jádra. Barvy jen z tokenů kitu (`play-hooks.css`): běžná
 * papír a inkoust, vzácná modrozelená (mint + sky), epická slunečná – nic fialového. Jen DOM, mimo hash.
 */

import { RARITY, type Rarity } from '@/play/arcade/hooks/contract';

/** Jak dlouho pilulka nálezu visí (ms). */
export const RARITY_TOAST_MS = 1600;

export type FoundRarity = Exclude<Rarity, 'common'>;

export interface ShownFind {
  readonly rarity: FoundRarity;
  /** Kolik věcí té vzácnosti hráč v běhu našel, včetně téhle. */
  readonly count: number;
  /** Čas kresby (ms) nástupu. */
  readonly at: number;
  readonly key: number;
}

/** Popisek počítadla (`data-testid="hud-counter-rare|epic"`, seznam `e2e/hud-labels.ts`) je jméno vzácnosti. */
export function RarityToast({ toast }: { readonly toast: ShownFind | null }) {
  if (toast === null) return null;
  return (
    <p key={toast.key} className="sp-hud-pill play-hook-rarity" data-rarity={toast.rarity} data-testid={`hud-counter-${toast.rarity}`} data-count={toast.count} role="status">
      {toast.count} {toast.rarity}
    </p>
  );
}

/** Řádek výsledku: nálezy běhu podle vzácnosti v pořadí `RARITY`; běh bez nálezu řádek nemá. */
export function FoundRow({ found }: { readonly found: Readonly<Record<Rarity, number>> }) {
  if (RARITY.every((rarity) => found[rarity] === 0)) return null;
  return (
    <p className="play-result-best play-result-found" data-testid="play-found">
      You found{' '}
      {RARITY.map((rarity, index) => (
        <span key={rarity}>
          {index > 0 && ' '}
          <span className="play-found-tier" data-rarity={rarity} data-count={found[rarity]}>
            {found[rarity]} {rarity}
          </span>
        </span>
      ))}
    </p>
  );
}
