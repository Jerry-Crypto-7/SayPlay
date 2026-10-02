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
 * Výzva kamaráda (P36B T7): výsledek, který server ověřil přehráním jeho
 * vstupů (`DareRecord`) – bez jména, jen čísla. Body rozhodují první, při
 * shodě čas; hvězdy ne (kamarádovy nikdo nespočítal).
 */
export interface Dare {
  readonly score: number;
  readonly ticks: number;
  /** Kamarád hrál se živými změnami – jeho výsledek patří změněné hře. */
  readonly liveChanges: number;
}

const points = (value: number): string => value.toLocaleString('en-US');

/** Cíl výzvy v HUD: body („Beat 2,450“), u výzvy bez bodů čas („Beat 31.0s“, přežití „Survive 90.0s“). */
export function dareGoal(dare: Dare, hz: number, survive: boolean): BestGoal {
  if (dare.score > 0) return { text: `Beat ${points(dare.score)}`, score: dare.score };
  return { text: `${survive ? 'Survive' : 'Beat'} ${clockText(dare.ticks / hz)}`, score: null };
}

/** Karta startu výzvy: body i čas kamaráda („Beat 2,450 in 31.0s“); bez bodů jen čas. */
export function dareStart(dare: Dare, hz: number, survive: boolean): string {
  return dare.score > 0 ? `Beat ${points(dare.score)} in ${clockText(dare.ticks / hz)}` : dareGoal(dare, hz, survive).text;
}

/** Konec běhu proti kamarádovi: porazil ho (jen výhra může) a o kolik. */
export function dareVerdict(run: { readonly won: boolean; readonly score: number; readonly ticks: number }, dare: Dare, hz: number, survive: boolean): { readonly beat: boolean; readonly text: string } {
  const diff = run.score - dare.score;
  if (!run.won) {
    if (diff < 0) return { beat: false, text: `${points(-diff)} short of your friend's ${points(dare.score)}` };
    if (survive) return { beat: false, text: `${Math.max(1, Math.round((dare.ticks - run.ticks) / hz))} s short of your friend` };
    return { beat: false, text: `Your friend did it in ${clockText(dare.ticks / hz)}.` };
  }
  if (diff > 0) return { beat: true, text: `${points(diff)} more than your friend's ${points(dare.score)}` };
  if (diff < 0) return { beat: false, text: `${points(-diff)} short of your friend's ${points(dare.score)}` };
  // Přežití bez rozdílu v bodech: každá výhra trvá stejně, vydržet jako kamarád je výzvu splnit.
  if (survive) return { beat: true, text: 'You lasted as long as your friend.' };
  const faster = dare.ticks - run.ticks;
  if (faster > 0) return { beat: true, text: `${clockText(faster / hz)} faster than your friend` };
  if (faster < 0) return { beat: false, text: `${clockText(-faster / hz)} slower than your friend` };
  return { beat: false, text: 'Tied with your friend.' };
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
