/**
 * Ověření skriptu úrovně (P68 T13, pilot za `PLAY_SCRIPTS`), ve třech krocích:
 *
 * 1. **Zdroj** – zakázaná jména (`scriptSourceIssues`, `level.ts`).
 * 2. **Data úrovně** – meze mřížky, startu, cíle a pásů a schéma uložených dat (`scriptLevelFromRecording`, `level.ts`).
 * 3. **Řešitelnost robotem** (`scriptedSpecIssues`, tady): svět ze specu s daty úrovně (překlad + „hratelné
 *    z konstrukce“) a herní aserce nad stopou stavu – robot hry vyhraje a nečinný hráč prohraje do 90 s.
 *
 * Kroky 1 a 2 žijí v `level.ts`, protože je volá i klientská laboratoř; krok 3 potřebuje překladač her (`node:crypto`),
 * takže tenhle modul je jen pro server a testy.
 */

import { arcadeWorldOf } from '@/play/arcade/compile';
import { P68_ASSERTIONS, assertGame } from '@/play/arcade/gameplay-assert';
import type { GameSpecV1 } from '@/play/spec';

export { type LevelFromRecording, SCRIPT_MAX_CHARS, scriptLevelFromRecording, scriptSourceIssues } from './level';

/** Herní aserce, které úroveň ze skriptu musí splnit: výhra robota a prohra nečinného do `maxTicks` (90 s). */
export const SCRIPT_PLAY_CHECKS: ReadonlySet<string> = new Set(['bot-wins', 'idle-loses']);

/**
 * Chyby specu s daty úrovně na semínku `seed`: překlad světa (meze, rozvržení, „hratelné z konstrukce“) a herní
 * aserce nad stopou stavu. Prázdné pole = úroveň je hratelná a robot ji vyřeší.
 */
export function scriptedSpecIssues(spec: GameSpecV1, seed: number): string[] {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) return [...made.issues];
  const game = spec.scriptLevel?.levelData.game ?? 'hop';
  const doc = { ...P68_ASSERTIONS, every: P68_ASSERTIONS.every.filter((requirement) => SCRIPT_PLAY_CHECKS.has(requirement.id)), games: { [game]: [] } };
  return assertGame(game, made.world, undefined, doc)
    .filter((result) => !result.pass)
    .map((result) => `${result.id}: ${result.evidence}`);
}
