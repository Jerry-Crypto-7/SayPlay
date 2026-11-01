/**
 * Čistá část ověření skriptu úrovně (P68 T13): zdroj a data úrovně ze záznamu volání. Bez překladače her, takže ji
 * smí i klientská laboratoř (`/play/lab/scripts`); řešitelnost robotem přidává `validate.ts`, který tohle re-exportuje.
 *
 * 1. **Zdroj** (`scriptSourceIssues`, před VM): hodiny, globální náhoda, časovače, síť a moduly hostitele v kódu =
 *    chyba ověření. Sandbox je stejně smaže; tady se o nich model dozví dřív, než VM poběží.
 * 2. **Data úrovně** (`scriptLevelFromRecording`): ze záznamu volání API postaví data cílové hry a pohlídá meze –
 *    mřížka, start a cíl, pásy (`hopScriptBands`) a schéma `hopScriptLevel`, které drží i uložený spec.
 */

import { HOP, HOP_MID, type HopScriptLevel, hopScriptBands, hopScriptLevel } from '@/play/arcade/pieces/hop-course';

import type { ScriptGame, ScriptRecording } from './api';

/** Nejdelší kód skriptu (znaky). */
export const SCRIPT_MAX_CHARS = 16_000;

const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/\bDate\b/, 'Date: the script gets no clock'],
  [/\bMath\s*\.\s*random\b/, 'Math.random: use api.rng.int(a, b), the seeded host randomness'],
  [/\bperformance\b/, 'performance: the script gets no clock'],
  [/\bcrypto\b/, 'crypto: use api.rng.int(a, b)'],
  [/\b(?:setTimeout|setInterval|queueMicrotask)\b/, 'timers: the script runs once, synchronously'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket)\b/, 'network: the script has no network'],
  [/\b(?:require|process)\b|\bimport\s*\(/, 'host modules: the script has no modules'],
];

/** Chyby ověření zdroje; prázdné pole = zdroj smí do VM. */
export function scriptSourceIssues(code: string): string[] {
  const issues = FORBIDDEN.filter(([pattern]) => pattern.test(code)).map(([, why]) => `forbidden identifier ${why}`);
  if (code.length > SCRIPT_MAX_CHARS) issues.push(`the script has ${code.length} characters, at most ${SCRIPT_MAX_CHARS}`);
  return issues;
}

export type LevelFromRecording = { readonly ok: true; readonly levelData: HopScriptLevel } | { readonly ok: false; readonly issues: readonly string[] };

/** Data úrovně hry `game` ze záznamu volání; meze mřížky, startu, cíle a pásů, pak schéma uložených dat. */
export function scriptLevelFromRecording(game: ScriptGame, recording: ScriptRecording, params: { readonly rows: number }): LevelFromRecording {
  const issues: string[] = [];
  if (recording.paths.length > 0) issues.push(`${game} takes no path: lay rows with api.place(kind, x, z)`);
  if (recording.places.length === 0) issues.push('the script placed nothing: a course needs at least one road, river or rail row');
  const lanes: HopScriptLevel['lanes'][number][] = [];
  for (const [kind, x, z] of recording.places) {
    if (x < 0 || x >= HOP.cols) issues.push(`column ${x} is off the grid: x is 0..${HOP.cols - 1} (below ${HOP_MID} traffic comes from the left, above from the right)`);
    if (z < HOP.startGrass) issues.push(`row ${z} is a start row: rows 0..${HOP.startGrass - 1} stay grass`);
    else lanes.push({ row: z, kind: kind as HopScriptLevel['lanes'][number]['kind'], side: x < HOP_MID ? 'left' : x > HOP_MID ? 'right' : 'any' });
  }
  const levelData = { game, rows: params.rows, lanes };
  if (lanes.length > 0) issues.push(...hopScriptBands(levelData).issues);
  if (issues.length > 0) return { ok: false, issues };
  const parsed = hopScriptLevel.safeParse(levelData);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`) };
  return { ok: true, levelData: parsed.data };
}
