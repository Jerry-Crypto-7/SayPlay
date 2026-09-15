import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { canonical } from '../src/ir/worlddoc';
import { digest, validateSuite, type Checks, type Gate, type Run, type Suite } from './measure-reality-compiler';
import type { BrowserArtifact, BrowserTask } from './reality-compiler-browser';

export interface CaseOracle {
  actor: string; startTarget: string; finishTarget: string; lockedTarget: string; failureFlag: string; timerId: string;
  originalDurationTicks: number; changedDurationTicks: number; requiredClarification: string | null;
  atomicRequirements: { id: string; critical: boolean; requirement: string;
    span: { startByte: number; endByte: number; excerpt: string } }[];
  expectedPairedOutcome: { original: { locked: boolean; failed: boolean }; changed: { locked: boolean; failed: boolean } };
}
export interface Oracle { version: number; cases: Record<string, CaseOracle> }
export function loadHoldout(directory: string) {
  const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
  const suite = read('suite.json') as Suite;
  const oracle = read('oracle.json') as Oracle;
  const tasks = read('tasks.json') as Record<string, BrowserTask>;
  const manifest = read('manifest.json') as { suiteSha256: string; oracleSha256: string; tasksSha256: string; status: string };
  validateSuite(suite, manifest.suiteSha256);
  if (digest(oracle) !== manifest.oracleSha256 || suite.oracleSha256 !== manifest.oracleSha256 ||
    digest(tasks) !== manifest.tasksSha256) throw new Error('HOLDOUT_DRIFT');
  if (Object.keys(oracle.cases).sort().join() !== suite.cases.map(c => c.id).sort().join() ||
    Object.keys(tasks).sort().join() !== suite.cases.map(c => c.id).sort().join()) throw new Error('HOLDOUT_IDS_MISMATCH');
  for (const entry of suite.cases) {
    const bytes = Buffer.from(entry.source + (entry.clarification ? `\n\nClarification: ${entry.clarification}` : ''));
    const atoms = oracle.cases[entry.id].atomicRequirements;
    if (!atoms.length || new Set(atoms.map(a => a.id)).size !== atoms.length) throw new Error('ORACLE_ATOMS_INVALID');
    for (const { span } of atoms) if (!Number.isSafeInteger(span.startByte) || !Number.isSafeInteger(span.endByte) ||
      span.startByte < 0 || span.endByte <= span.startByte || span.endByte > bytes.length ||
      bytes.subarray(span.startByte, span.endByte).toString('utf8') !== span.excerpt) throw new Error('ORACLE_SPAN_MISMATCH');
  }
  return { suite, oracle, tasks, manifest };
}
export function judgeBrowser(oracle: CaseOracle, created: BrowserArtifact | null, edited: BrowserArtifact | null): Checks {
  const c = edited?.observation?.project.comparison;
  let invariants: boolean | null = null;
  let branchDelta: boolean | null = null;
  if (c && created?.observation && edited?.observation) {
    const parent = edited.observation.project.parent;
    invariants = c.originalAtFork.tick === c.changedAtFork.tick &&
      canonical(c.originalAtFork.values) === canonical(c.changedAtFork.values) &&
      canonical(c.originalAtFork.entities) === canonical(c.changedAtFork.entities) &&
      canonical(parent?.sources) === canonical(edited.observation.project.sources) &&
      canonical(parent?.world) === canonical(created.observation.project.world) &&
      canonical(c.originalDocument) === canonical(created.observation.project.world) &&
      canonical(c.inputLog) === canonical(edited.originalBeforeEdit?.inputs);
    const original = { locked: c.original.values[`e:${oracle.lockedTarget}:locked`] === 1,
      failed: c.original.values[`f:${oracle.failureFlag}`] === 1 };
    const changed = { locked: c.changed.values[`e:${oracle.lockedTarget}:locked`] === 1,
      failed: c.changed.values[`f:${oracle.failureFlag}`] === 1 };
    // Oracle očekává zdrojové veličiny, ne identifikátory pravidel navržené modelem.
    const start = c.inputLog.find(i => i.actor === oracle.actor && i.actionId === 'activate' && i.target === oracle.startTarget);
    const finish = c.inputLog.find(i => i.actor === oracle.actor && i.actionId === 'activate' && i.target === oracle.finishTarget);
    const slotsPresent = [c.original, c.changed].every(s => Object.hasOwn(s.values, `e:${oracle.lockedTarget}:locked`) &&
      Object.hasOwn(s.values, `f:${oracle.failureFlag}`));
    branchDelta = slotsPresent && !!start && !!finish && finish.tick > start.tick + oracle.changedDurationTicks &&
      finish.tick < start.tick + oracle.originalDurationTicks && c.previousDurationTicks === oracle.originalDurationTicks &&
      c.durationTicks === oracle.changedDurationTicks && c.original.observationTick === c.changed.observationTick &&
      canonical(original) === canonical(oracle.expectedPairedOutcome.original) &&
      canonical(changed) === canonical(oracle.expectedPairedOutcome.changed);
  }
  return { invariants, branchDelta, rejectedUnchanged: edited?.rejectedUnchanged ?? null,
    // Přijetí před upřesněním je doložená chyba. Správnost otázky musí posoudit člověk.
    problematicBlocked: created?.problematicStopped === false ? false : null,
    criticalSupported: null, criticalCitations: null, otherCitations: null, rules: null, visualUsable: null };
}

const nullableVerdict = z.boolean().nullable();
const reviewRow = z.strictObject({ index: z.int().min(0).max(29), caseId: z.string(),
  reviewer: z.string().min(1).nullable(), reviewedAt: z.string().datetime().nullable(),
  criticalSupported: nullableVerdict, criticalCitations: nullableVerdict, clarificationCorrect: nullableVerdict,
  otherCitations: z.strictObject({ passed: z.int().nonnegative(), total: z.int().nonnegative() })
    .refine(value => value.passed <= value.total, 'CITATION_COUNTS_INVALID').nullable().default(null),
  visualUsable: nullableVerdict,
  atoms: z.array(z.strictObject({ id: z.string(), met: nullableVerdict })),
  unsupportedAtomicCount: z.int().nonnegative().nullable(), notes: z.string(),
});
export const reviewSchema = z.strictObject({ runId: z.string(), suiteSha256: z.string(), oracleSha256: z.string(),
  rows: z.array(reviewRow) });
export function reviewTemplate(run: Run, oracle: Oracle) {
  return { runId: run.config.runId, suiteSha256: run.config.suiteSha256,
    oracleSha256: digest(oracle), rows: run.pairs.map(pair => ({ index: pair.index, caseId: pair.caseId,
      reviewer: null, reviewedAt: null, criticalSupported: null, criticalCitations: null, clarificationCorrect: null,
      otherCitations: null,
      visualUsable: null, atoms: (oracle.cases[pair.caseId]?.atomicRequirements ?? []).map(a => ({ id: a.id, met: null })),
      unsupportedAtomicCount: null, notes: '' })) };
}
/** Vnější review nikdy nepřepíše doložený FAIL automatického integračního měření. */
export function applyReview(run: Run, raw: unknown, oracle: Oracle): Run {
  const review = reviewSchema.parse(raw);
  if (review.runId !== run.config.runId || review.suiteSha256 !== run.config.suiteSha256 ||
    review.oracleSha256 !== digest(oracle) || review.rows.length !== run.pairs.length ||
    new Set(review.rows.map(r => r.index)).size !== review.rows.length) throw new Error('REVIEW_BINDING_MISMATCH');
  const next = structuredClone(run);
  for (const pair of next.pairs) {
    const row = review.rows.find(r => r.index === pair.index);
    const spec = oracle.cases[pair.caseId];
    if (!row || row.caseId !== pair.caseId || !spec || row.atoms.map(a => a.id).sort().join() !==
      spec.atomicRequirements.map(a => a.id).sort().join()) throw new Error('REVIEW_ATOMS_MISMATCH');
    if (!row.reviewer?.trim() || !row.reviewedAt || !pair.checks) continue;
    // Counts are collected once; subsequent review cannot erase recorded citation failures.
    if (pair.checks.otherCitations === null && row.otherCitations !== null)
      pair.checks.otherCitations = { ...row.otherCitations };
    for (const key of ['criticalSupported', 'criticalCitations', 'visualUsable'] as const)
      if (pair.checks[key] !== false && row[key] !== null) pair.checks[key] = row[key];
    if (pair.input.kind !== 'complete' && pair.checks.problematicBlocked !== false && row.clarificationCorrect !== null)
      pair.checks.problematicBlocked = row.clarificationCorrect;
    if (row.atoms.every(a => a.met !== null) && row.unsupportedAtomicCount !== null) pair.checks.rules = {
      tp: row.atoms.filter(a => a.met).length, fn: row.atoms.filter(a => a.met === false).length, fp: row.unsupportedAtomicCount,
    };
  }
  return next;
}

const modality = z.enum(['3d', 'table']);
const studyTask = z.strictObject({ taskId: z.string().min(1), modality,
  completed: nullableVerdict, correct: nullableVerdict, seconds: z.number().nonnegative().nullable(),
  assistanceCount: z.int().nonnegative().nullable(), explanation: z.string(), distinctionCorrect: nullableVerdict,
  spatialInformation: z.string(), spatialContributionCorrect: nullableVerdict,
});
export const studySchema = z.strictObject({ version: z.literal(1), status: z.enum(['NOT_RUN', 'RECORDED']),
  participants: z.array(z.strictObject({ id: z.string().min(1), newParticipant: nullableVerdict,
    observer: z.string().nullable(), observedAt: z.string().datetime().nullable(),
    order: z.tuple([modality, modality]), tasks: z.tuple([studyTask, studyTask]) })).length(5) });
export function scoreStudy(raw: unknown) {
  const study = studySchema.parse(raw);
  if (new Set(study.participants.map(p => p.id)).size !== 5 || study.participants.some(p =>
    p.order[0] === p.order[1] || p.tasks[0].taskId === p.tasks[1].taskId ||
    p.tasks.some((t, i) => t.modality !== p.order[i]))) throw new Error('STUDY_DESIGN_INVALID');
  if (!study.participants.some(p => p.order[0] === '3d') || !study.participants.some(p => p.order[0] === 'table'))
    throw new Error('STUDY_ORDER_NOT_COUNTERBALANCED');
  if (['3d', 'table'].some(mod => new Set(study.participants.flatMap(p => p.tasks.filter(t => t.modality === mod).map(t => t.taskId))).size < 2))
    throw new Error('STUDY_TASK_CONFOUNDED_WITH_MODALITY');
  const observed = study.participants.filter(p => p.newParticipant === true && !!p.observer?.trim() && !!p.observedAt &&
    p.tasks.every(t => t.completed !== null && t.correct !== null && t.seconds !== null && t.assistanceCount !== null &&
      t.distinctionCorrect !== null && !!t.explanation.trim()));
  const eligible = study.status === 'RECORDED' && observed.length === 5;
  const completed = observed.filter(p => {
    const t = p.tasks.find(t => t.modality === '3d')!;
    return t.completed && t.correct && t.assistanceCount === 0 && t.distinctionCorrect;
  }).length;
  const spatial = observed.filter(p => {
    const t = p.tasks.find(t => t.modality === '3d')!;
    return t.correct && t.spatialContributionCorrect && !!t.spatialInformation.trim();
  }).length;
  const gate = (pass: boolean): Gate => eligible ? pass ? 'PASS' : 'FAIL' : 'NOT_RUN';
  return { observed: observed.length, planned: 5, completed, spatial,
    gates: { usersComplete: gate(completed >= 4), usersSpatialHelp:
      observed.every(p => p.tasks.find(t => t.modality === '3d')!.spatialContributionCorrect !== null) ? gate(spatial >= 3) : 'NOT_RUN' as Gate },
    tasks: observed.flatMap(p => p.tasks.map((t, i) => ({ participant: p.id, order: i + 1, ...t }))),
    limitation: 'Five-person qualitative study; no statistical superiority claim. Null observations are not successes.' };
}
