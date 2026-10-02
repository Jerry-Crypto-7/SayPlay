/**
 * Osobní rekord hry v prohlížeči (P36B T2): `localStorage` pod `sp-best:<versionId>`
 * – skóre, tiky a hvězdy nejlepší výhry. Úložiště je jen pomůcka (vzor
 * `pending-upgrades.ts`): v anonymním okně nebo při plném úložišti vyhodí
 * výjimku a výsledek se vykreslí bez rekordu. Leží mimo hashovaný stav.
 */

import { clockText } from './ui/GameHud';

export const BEST_PREFIX = 'sp-best:';

export interface Best {
  readonly score: number;
  readonly ticks: number;
  /** 0–3; hra bez hvězd (mřížka) ukládá 0 a soudí se časem. */
  readonly stars: number;
}

/** Co výsledek o rekordu ví: předchozí rekord (`null` = žádný nebo nečitelný) a jestli ho tenhle běh překonal. */
export interface BestOutcome {
  readonly previous: Best | null;
  readonly isNew: boolean;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** `localStorage`, nebo `null`, když už samotný přístup k němu vyhodí (Safari private, zakázané cookies). */
function browserStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function isBest(value: unknown): value is Best {
  if (typeof value !== 'object' || value === null) return false;
  const { score, ticks, stars } = value as Record<string, unknown>;
  return count(score) && count(ticks) && ticks >= 0 && count(stars);
}

/** Lepší běh: víc hvězd, při shodě víc bodů, při shodě rychlejší. */
export function beats(run: Best, best: Best): boolean {
  if (run.stars !== best.stars) return run.stars > best.stars;
  if (run.score !== best.score) return run.score > best.score;
  return run.ticks < best.ticks;
}

export function readBest(versionId: string, store: Store | null = browserStore()): Best | null {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(BEST_PREFIX + versionId) ?? 'null');
    return isBest(parsed) ? { score: parsed.score, ticks: parsed.ticks, stars: parsed.stars } : null;
  } catch {
    return null;
  }
}

/** Cíl k překonání během běhu (P36B T4): text položky HUD a body, které ho přebijí (`null` = rozhodne až čas na konci). */
export interface BestGoal {
  readonly text: string;
  readonly score: number | null;
}

/**
 * Rekord jako cíl v HUD: u rekordu s body jeho body („Best 2,450“), jinak jeho
 * čas („Best 31.0s“). Hra na přežití bez bodů cíl nemá – každá její výhra trvá
 * stejně dlouho. Bez rekordu cíl není.
 */
export function bestGoal(best: Best | null, hz: number, survive: boolean): BestGoal | null {
  if (best === null) return null;
  if (best.score > 0) return { text: `Best ${best.score.toLocaleString('en-US')}`, score: best.score };
  return survive ? null : { text: `Best ${clockText(best.ticks / hz)}`, score: null };
}

/**
 * Konec běhu: výhra, která je první nebo lepší, se zapíše. „New best!“ je jen
 * překonaný dřívější rekord – první výhra nemá co překonat. Prohra jen čte.
 */
export function settleBest(versionId: string, run: Best & { readonly won: boolean }, store: Store | null = browserStore()): BestOutcome {
  const previous = readBest(versionId, store);
  if (!run.won) return { previous, isNew: false };
  const better = previous === null || beats(run, previous);
  if (better) {
    try {
      store?.setItem(BEST_PREFIX + versionId, JSON.stringify({ score: run.score, ticks: run.ticks, stars: run.stars }));
    } catch {
      // Plné nebo zakázané úložiště: rekord se nezapíše, hra jede dál.
    }
  }
  return { previous, isNew: previous !== null && better };
}
