/**
 * P45B T1: měřidlo „kolik her okamžitého návrhu má stavový průběh“ a jak dlouho návrh trvá.
 *
 * Hra „používá logiku“, jen když platí všechno naráz: spec deklaruje blok `logic`, aspoň
 * jedno pravidlo má logický spouštěč, podmínku nebo efekt **a** `verifyArcade` hru pustí.
 * Hra s logikou, kterou robot nedohraje, se nepočítá – jinak by podíl vypadal správně a
 * měřil jen to, co návrh napsal, ne co se dá hrát.
 *
 * Čte jen otevřené vývojové sady; zapečetěné a testovací sady odmítne (`openSet`).
 */
import { readFileSync } from 'node:fs';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';

/** Vývojové sady, nad kterými se ladí; T13 smí přes `P45B_SET` dát vývojový panel P45A. */
export const DEV_SETS = ['evals/play/p30/dev.json', 'evals/play/p37a/dev-150.json'] as const;

/** Konstrukce jazyka pravidel v2 (P45B T3). */
export const CONSTRUCTS = ['var', 'timer', 'phase', 'event', 'wave'] as const;
export type Construct = (typeof CONSTRUCTS)[number];

/** Klíče pravidla, které čtou nebo mění stav logiky (`rules/schema.ts` po T3). */
const LOGIC_WHEN = ['timer', 'phase', 'phaseExit', 'var', 'event'];
const LOGIC_IF = ['var', 'inPhase', 'timerRunning', 'timerStopped'];
const LOGIC_DO = ['set', 'add', 'goPhase', 'startTimer', 'stopTimer', 'emit', 'wave'];

/** Testovací a zapečetěné sady se tu neotevírají – číslo nad nimi by bylo vyladěné na test. */
export function openSet(path: string): { id: string; text: string }[] {
  if (/test-|seal|opened/i.test(path)) throw new Error(`${path}: sealed or test set – the logic gauge reads dev sets only`);
  const set = JSON.parse(readFileSync(path, 'utf8')) as { sentences: { id: string; text: string }[] };
  return set.sentences.map(({ id, text }) => ({ id, text }));
}

type LooseRule = { when?: object; if?: object[]; do?: object[] };
type LooseSpec = { logic?: { vars?: unknown[]; timers?: unknown[]; phases?: unknown[]; events?: unknown[] }; rules?: LooseRule[] };

const hasKey = (value: object | undefined, keys: readonly string[]): boolean => value !== undefined && keys.some((key) => key in value);

/** Které konstrukce spec deklaruje a jestli ho lze počítat jako hru s logikou (`verified` = `verifyArcade` hru pustil). */
export function logicUse(spec: object, verified: boolean): { usesLogic: boolean; constructs: Construct[] } {
  const { logic, rules = [] } = spec as LooseSpec;
  const constructs = CONSTRUCTS.filter((construct) => {
    if (construct === 'wave') return rules.some((rule) => (rule.do ?? []).some((effect) => 'wave' in effect));
    return (logic?.[`${construct}s` as 'vars' | 'timers' | 'phases' | 'events']?.length ?? 0) > 0;
  });
  const logicRule = rules.some((rule) => hasKey(rule.when, LOGIC_WHEN) || (rule.if ?? []).some((cond) => hasKey(cond, LOGIC_IF)) || (rule.do ?? []).some((effect) => hasKey(effect, LOGIC_DO)));
  return { usesLogic: logic !== undefined && logicRule && verified, constructs };
}

export interface LogicRow {
  readonly id: string;
  readonly text: string;
  readonly ms: number;
  readonly playable: boolean;
  readonly usesLogic: boolean;
  readonly constructs: Construct[];
  readonly template: string | null;
  readonly failure: string | null;
}

/** Jedna věta: okamžitý návrh (semínko 1, bez modelu), změřený čas, ověření. */
export function measureSentence(id: string, text: string): LogicRow {
  const started = performance.now();
  const draft = draftGameSpecWithMeta(text, 1);
  const ms = Math.round(performance.now() - started);
  const made = arcadeWorldOf(draft.spec, 1);
  const verdict = made.ok ? verifyArcade(made.world, undefined, made.roleBindings) : null;
  const playable = verdict?.publishEligible === true;
  // Jméno šablony nese složení (T9); dřív žádné není.
  const template = (draft.composition as { template?: string | null } | undefined)?.template ?? null;
  return { id, text, ms, playable, ...logicUse(draft.spec, playable), template, failure: made.ok ? (verdict!.failures[0] ?? null) : made.issues.join('; ') };
}

/** Nearest-rank percentil. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

export function summarize(rows: readonly LogicRow[]) {
  const share = (count: number) => Math.round((count / Math.max(1, rows.length)) * 1000) / 10;
  return {
    sentences: rows.length,
    usesLogic: rows.filter((row) => row.usesLogic).length,
    logicSharePct: share(rows.filter((row) => row.usesLogic).length),
    playable: rows.filter((row) => row.playable).length,
    playablePct: share(rows.filter((row) => row.playable).length),
    p50ms: percentile(rows.map((row) => row.ms), 50),
    p95ms: percentile(rows.map((row) => row.ms), 95),
    constructs: Object.fromEntries(CONSTRUCTS.map((construct) => [construct, rows.filter((row) => row.usesLogic && row.constructs.includes(construct)).length])),
    templates: rows.filter((row) => row.template !== null).length,
  };
}
