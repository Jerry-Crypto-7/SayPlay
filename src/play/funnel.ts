/**
 * Trychtýř smyčky (P44B T12): kolik her vzniklo z věty, kolikrát se hrály, dohrály, sdílely,
 * kolik odkazů se otevřelo a kolikrát kamarád porazil výzvu nebo hru remixoval – po dnech (UTC).
 * Každý stupeň se na relaci a hru počítá nejvýš jednou za den (`VersionStore.countFunnel`),
 * novou hru počítá `put` jednou (je nová právě jednou). Čte to interní `/play/stats` (T13).
 */

import type { LoopEventName } from './loop-events';

export const FUNNEL_STAGES = ['say', 'play', 'finish', 'share', 'open', 'beat', 'remix'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Nejdelší okno, které `VersionStore.funnel` vrátí. */
export const FUNNEL_MAX_DAYS = 30;

/**
 * Návrat hráče za den (P63 T5, `VersionStore.countVisitor`): `first` = návštěvníci, kteří ten den přišli poprvé,
 * `return` = návštěvníci viděni už v dřívější den, každý nejvýš jednou za den. `d1` / `d7` = kolik z nových
 * toho dne přišlo znovu přesně 1. / 7. den po prvním.
 */
export interface VisitorDay {
  readonly first: number;
  readonly return: number;
  readonly d1: number;
  readonly d7: number;
}

/** Jeden den trychtýře; chybějící čítač je 0. */
export interface FunnelDay {
  readonly day: string;
  readonly counts: Readonly<Record<FunnelStage, number>>;
  readonly visitors: VisitorDay;
}

/** Dny po prvním, pro které trychtýř drží návrat (D1, D7). */
export const RETENTION_AFTER = [1, 7] as const;
export type RetentionAfter = (typeof RETENTION_AFTER)[number];

/**
 * D1 / D7 z dnů trychtýře (od nejstaršího po dnešek): z nových návštěvníků dnů, jejichž 1. / 7. den už celý uplynul,
 * kolik se ten den vrátilo. `null`, když takový den nikoho nového nemá – podíl z nuly by lhal.
 */
export function retention(days: readonly FunnelDay[], after: RetentionAfter): { readonly hit: number; readonly of: number } | null {
  // Poslední den je dnešek a ještě běží: den `i` má svůj `after`. den za sebou, když i + after < poslední.
  const finished = days.slice(0, Math.max(0, days.length - 1 - after));
  const of = finished.reduce((sum, day) => sum + day.visitors.first, 0);
  if (of === 0) return null;
  return { hit: finished.reduce((sum, day) => sum + (after === 1 ? day.visitors.d1 : day.visitors.d7), 0), of };
}

/** Stupeň z události klienta (`POST /api/play/events`); `null` = do trychtýře nepatří. */
export function funnelStageOf(name: LoopEventName): FunnelStage | null {
  switch (name) {
    case 'first_input':
      return 'play';
    case 'win':
    case 'lose':
      return 'finish';
    case 'share':
      return 'share';
    case 'shared_open':
      return 'open';
    default:
      return null;
  }
}

/** Stupeň nové hry: bez rodiče `say`, s rodičem `remix`; autorská verze od AI (`upgrade`) ani hra ze čtení (`reading`) není ani jedno. */
export function publishStageOf(game: { readonly parentId: string | null; readonly relation?: 'upgrade' | 'remix' | 'reading' }): FunnelStage | null {
  if (game.relation === 'upgrade' || game.relation === 'reading') return null;
  return game.parentId === null ? 'say' : 'remix';
}

/** Den v UTC (`2026-10-08`). */
export function funnelDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Celé dny mezi dvěma dny UTC (`2026-10-08` → `2026-10-15` = 7). */
export function funnelDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / (24 * 3600 * 1000));
}
