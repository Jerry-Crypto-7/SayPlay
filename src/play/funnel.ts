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

/** Jeden den trychtýře; chybějící čítač je 0. */
export interface FunnelDay {
  readonly day: string;
  readonly counts: Readonly<Record<FunnelStage, number>>;
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

/** Stupeň nové hry: bez rodiče `say`, s rodičem `remix`; autorská verze od AI (`upgrade`) není ani jedno. */
export function publishStageOf(game: { readonly parentId: string | null; readonly relation?: 'upgrade' }): FunnelStage | null {
  if (game.relation === 'upgrade') return null;
  return game.parentId === null ? 'say' : 'remix';
}

/** Den v UTC (`2026-10-08`). */
export function funnelDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
