/**
 * Měřidlo P47B (T2) nad měřidlem P46: chtěné akce bere z ručního štítku
 * `wants`, když ho věta má (panel P47B), jinak z regexu P46 (věty P46A – čísla
 * P46 zůstanou srovnatelná). Řádek navíc nese `dropped` (chtěná akce, kterou hra
 * nemá, s důvodem), `spurious` (akce ze slovesa, kterou štítek nechce – počítá se
 * nad pastmi) a `draftMs` (čas rychlé verze).
 *
 * Holdout se čte jen s `P47B_OPEN_HOLDOUT=1` (T12, jednou).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadRapier } from '@/play/arcade/physics/world';
import { CAPABILITIES } from '@/play/capabilities';
import { generatorTakes } from '@/play/compose/compile';
import { type DraftMeta, draftGameSpecWithMeta } from '@/play/draft';
import { saidAbilities } from '@/play/draft/controls';

import { type ActionKind, type ActionRow, type ActionSentence, actionRowOf, actionSummary, readSentences } from '../p46/actions';

export const P47B_DIR = join(process.cwd(), 'evals', 'play', 'p47b');

const VERB_SETS = {
  dev: join(P47B_DIR, 'verb-dev.json'),
  holdout: join(P47B_DIR, 'verb-holdout.json'),
  p46a: join(process.cwd(), 'evals', 'play', 'p46', 'action-sentences.json'),
} as const;
export type VerbSet = keyof typeof VERB_SETS;

export interface VerbRow extends ActionRow {
  /** Věta se štítkem `wants: []` – past, která akci jen připomíná. */
  readonly trap: boolean;
  /** Chtěné akce, které hra nemá, s důvodem (`VERB_UNPROVED:dash`, `control shooter takes no dash`). */
  readonly dropped: readonly { readonly action: ActionKind; readonly reason: string }[];
  /** Akce ze slovesa (`abilities`, doplněk střelby), které věta nechce; mechanika žánru se nepočítá. */
  readonly spurious: readonly ActionKind[];
  readonly draftMs: number;
}

/** Věty sady; panel P47B se štítky, věty P46A bez nich. */
export function verbSentences(set: VerbSet, { env = process.env }: { env?: Record<string, string | undefined> } = {}): ActionSentence[] {
  if (set === 'holdout' && env.P47B_OPEN_HOLDOUT !== '1') throw new Error('p47b: the holdout is read once, by T12 only (P47B_OPEN_HOLDOUT=1)');
  if (set === 'p46a') return readSentences(VERB_SETS.p46a);
  const corpus = JSON.parse(readFileSync(VERB_SETS[set], 'utf8')) as { sentences: (ActionSentence & { wants: ActionKind[] })[] };
  return corpus.sentences.map(({ id, text, wants }) => ({ id, text, wants }));
}

/** Proč chtěná akce ve hře chybí – první důvod, který platí. */
export function dropReason(action: ActionKind, text: string, meta: Pick<DraftMeta, 'spec' | 'composition'>): string {
  if (!saidAbilities(text.toLowerCase()).includes(action)) return 'lexicon misses the verb';
  const unproved = `VERB_UNPROVED:${action}`;
  if (meta.composition?.issues.some((issue) => issue.includes(unproved))) return unproved;
  const { control } = meta.spec;
  if (control === undefined || control === 'tap_go') return 'grid fallback';
  if (!CAPABILITIES[control].abilities.includes(action)) return `control ${control} takes no ${action}`;
  const generator = (meta.spec.controlParams as { generator?: string } | undefined)?.generator;
  if (!generatorTakes(generator, action)) return `generator ${generator} takes no ${action}`;
  return 'dropped without a recorded reason';
}

/** Řádek nad hotovým návrhem – měřidlo i test jím projdou stejně. */
export async function verbRowOf(sentence: ActionSentence, meta: Pick<DraftMeta, 'spec' | 'composition'>, draftMs: number): Promise<VerbRow> {
  const row = await actionRowOf(sentence, meta.spec);
  const said = new Set<ActionKind>(meta.spec.abilities ?? []);
  if (meta.spec.addons?.includes('shoot')) said.add('shoot');
  return {
    ...row,
    trap: sentence.wants !== undefined && sentence.wants.length === 0,
    dropped: row.wanted.filter((action) => !row.present.includes(action)).map((action) => ({ action, reason: dropReason(action, sentence.text, meta) })),
    spurious: [...said].filter((action) => !row.wanted.includes(action)),
    draftMs,
  };
}

export async function verbRow(sentence: ActionSentence): Promise<VerbRow> {
  // Jako živá cesta (`api/play/games`): fyzika je načtená dřív, než rychlá verze ověřuje svět – mimo měřený čas.
  await loadRapier();
  const started = performance.now();
  const meta = draftGameSpecWithMeta(sentence.text, 1);
  return verbRowOf(sentence, meta, Math.round(performance.now() - started));
}

const p95 = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
};

export function verbSummary(rows: readonly VerbRow[]) {
  const traps = rows.filter((row) => row.trap);
  return {
    ...actionSummary(rows),
    traps: traps.length,
    spuriousRate: traps.length === 0 ? null : Math.round((traps.filter((row) => row.spurious.length > 0).length / traps.length) * 100) / 100,
    draftMsP95: p95(rows.map((row) => row.draftMs)),
  };
}
