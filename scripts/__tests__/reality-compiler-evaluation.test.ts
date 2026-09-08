import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReview, judgeBrowser, loadHoldout, reviewTemplate, scoreStudy } from '../reality-compiler-evaluation';
import { digest, type Run } from '../measure-reality-compiler';

const directory = 'evals/reality-compiler/holdout-v1';
const studyTemplate = () => JSON.parse(readFileSync('evals/reality-compiler/user-study.json', 'utf8'));
function syntheticStudy() {
  const study = studyTemplate(); study.status = 'RECORDED';
  for (const p of study.participants) {
    p.newParticipant = true; p.observer = 'synthetic-test-observer'; p.observedAt = '2026-09-08T12:00:00Z';
    for (const t of p.tasks) Object.assign(t, { completed: true, correct: true, seconds: 20,
      assistanceCount: 0, explanation: 'Synthetic assertion fixture; never an observed participant.',
      distinctionCorrect: true, spatialInformation: 'Synthetic proximity observation.', spatialContributionCorrect: true });
  }
  return study;
}
function syntheticRun(): Run {
  const { suite, manifest } = loadHoldout(directory);
  return { config: { runId: 'synthetic-test', commit: 'synthetic', dirty: false, model: 'synthetic', modelConfig: {},
    origin: 'offline', authorized: false, spendLimitUsd: null, maxCalls: 1, maxWallMs: 10,
    suiteSha256: manifest.suiteSha256 }, protocolSha256: 'synthetic', suiteStatus: 'development', startedAt: '', stopReason: null,
    pairs: suite.cases.map((input, index) => ({ index, caseId: input.id, repeat: 0, input, calls: [], phases: {},
      checks: { invariants: null, branchDelta: null, rejectedUnchanged: null, problematicBlocked: null,
        criticalSupported: null, criticalCitations: null, otherCitations: null, rules: null, visualUsable: null } })) };
}
describe('holdout lock and evidence review, no model inference', () => {
  it('loads 10 unused sources, 5/3/2 split, exact byte spans and 32 atoms per oracle', () => {
    const { suite, oracle, manifest } = loadHoldout(directory);
    expect(suite.cases).toHaveLength(10);
    expect(['complete', 'missing', 'conflict'].map(kind => suite.cases.filter(c => c.kind === kind).length)).toEqual([5,3,2]);
    expect(Object.values(oracle.cases).every(c => c.atomicRequirements.length === 32)).toBe(true);
    expect(digest(suite)).toBe(manifest.suiteSha256);
    expect(suite.cases.every(c => !c.source.includes('museum'))).toBe(true);
  });
  it.each(['suite.json','oracle.json','tasks.json'])('detects changed %s before execution', name => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-holdout-'));
    try {
      cpSync(directory, dir, { recursive: true });
      const path = join(dir, name); const value = JSON.parse(readFileSync(path, 'utf8')); value.drift = true;
      writeFileSync(path, JSON.stringify(value)); expect(() => loadHoldout(dir)).toThrow();
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('missing browser observations do not certify semantic or integration checks', () => {
    const { oracle } = loadHoldout(directory);
    expect(Object.values(judgeBrowser(oracle.cases.H01, null, null)).every(v => v === null)).toBe(true);
  });
  it('a review template cannot pass a gate or invent rule counts', () => {
    const run = syntheticRun(); const { oracle } = loadHoldout(directory);
    const reviewed = applyReview(run, reviewTemplate(run, oracle), oracle);
    expect(reviewed).toEqual(run);
  });
  it('requires matching run, corpus and atom IDs', () => {
    const run = syntheticRun(); const { oracle } = loadHoldout(directory); const template = reviewTemplate(run, oracle);
    template.runId = 'other'; expect(() => applyReview(run, template, oracle)).toThrow('REVIEW_BINDING_MISMATCH');
    template.runId = run.config.runId; template.rows[0].atoms[0].id = 'invented';
    expect(() => applyReview(run, template, oracle)).toThrow('REVIEW_ATOMS_MISMATCH');
  });
  it('rejects duplicate rows rather than silently using the favorable review', () => {
    const run = syntheticRun(); const { oracle } = loadHoldout(directory); const template = reviewTemplate(run, oracle);
    template.rows[1].index = 0;
    expect(() => applyReview(run, template, oracle)).toThrow('REVIEW_BINDING_MISMATCH');
  });
  it('only signed observations fill semantic fields and never overwrite a measured failure', () => {
    const run = syntheticRun(); const { oracle } = loadHoldout(directory);
    run.pairs[5].checks!.problematicBlocked = false;
    const template = reviewTemplate(run, oracle) as any;
    for (const row of template.rows) {
      Object.assign(row, { reviewer: 'synthetic-reviewer', reviewedAt: '2026-09-08T12:00:00Z',
        criticalSupported: true, criticalCitations: true, clarificationCorrect: true, unsupportedAtomicCount: 1 });
      row.atoms.forEach((a: any, i: number) => { a.met = i > 1; });
    }
    const reviewed = applyReview(run, template, oracle);
    expect(reviewed.pairs[0].checks!.rules).toEqual({ tp: 30, fn: 2, fp: 1 });
    expect(reviewed.pairs[5].checks!.problematicBlocked).toBe(false);
    expect(run.pairs[0].checks!.rules).toBeNull();
  });
  it('records attributed citation counts without changing raw evidence or replacing recorded failures', () => {
    const run = syntheticRun(); const { oracle } = loadHoldout(directory);
    const template = reviewTemplate(run, oracle);
    const row = { ...template.rows[0], reviewer: 'human-reviewer', reviewedAt: '2026-09-08T12:00:00Z',
      otherCitations: { passed: 3, total: 4 } };
    const review = { ...template, rows: [row, ...template.rows.slice(1)] };
    const reviewed = applyReview(run, review, oracle);
    expect(reviewed.pairs[0].checks!.otherCitations).toEqual({ passed: 3, total: 4 });
    expect(run.pairs[0].checks!.otherCitations).toBeNull();
    row.otherCitations.passed = 4;
    expect(applyReview(reviewed, review, oracle).pairs[0].checks!.otherCitations).toEqual({ passed: 3, total: 4 });
    row.reviewer = '   ';
    expect(applyReview(run, review, oracle)).toEqual(run);
    row.otherCitations.passed = 5;
    expect(() => applyReview(run, review, oracle)).toThrow('CITATION_COUNTS_INVALID');
  });
  it('keeps archived review templates compatible and missing citation counts unreviewed', () => {
    const run = syntheticRun(); const { oracle } = loadHoldout(directory);
    const template = reviewTemplate(run, oracle);
    const legacy = { ...template, rows: template.rows.map(({ otherCitations: _counts, ...row }) => row) };
    expect(applyReview(run, legacy, oracle)).toEqual(run);
  });
});

describe('user study requires actual complete attributed observations', () => {
  it('starts at NOT_RUN for both gates with zero participants observed', () => {
    expect(scoreStudy(studyTemplate())).toMatchObject({ observed: 0, planned: 5,
      gates: { usersComplete: 'NOT_RUN', usersSpatialHelp: 'NOT_RUN' } });
  });
  it('calculates gates only with all five observations (synthetic validation data)', () => {
    const scored = scoreStudy(syntheticStudy());
    expect(scored.gates).toEqual({ usersComplete: 'PASS', usersSpatialHelp: 'PASS' });
    expect(scored.tasks).toHaveLength(10);
  });
  it('four people is incomplete even when every observed result succeeds', () => {
    const study = syntheticStudy(); study.participants[4].observer = null;
    expect(scoreStudy(study).gates.usersComplete).toBe('NOT_RUN');
  });
  it('does not count assisted completion as independent success', () => {
    const study = syntheticStudy();
    for (const p of study.participants.slice(0, 2)) p.tasks.find((t: any) => t.modality === '3d').assistanceCount = 1;
    expect(scoreStudy(study).gates.usersComplete).toBe('FAIL');
  });
  it('requires a concrete spatial statement AND correct task resolution', () => {
    const study = syntheticStudy();
    for (const p of study.participants.slice(0, 3)) p.tasks.find((t: any) => t.modality === '3d').spatialInformation = '';
    expect(scoreStudy(study).gates.usersSpatialHelp).toBe('FAIL');
  });
  it('unreviewed spatial usefulness is NOT_RUN, not an implicit failure or pass', () => {
    const study = syntheticStudy(); study.participants[0].tasks[0].spatialContributionCorrect = null;
    expect(scoreStudy(study).gates.usersSpatialHelp).toBe('NOT_RUN');
  });
  it('rejects duplicate participants and repeated task answers', () => {
    const study = syntheticStudy(); study.participants[1].id = study.participants[0].id;
    expect(() => scoreStudy(study)).toThrow('STUDY_DESIGN_INVALID');
    const repeat = syntheticStudy(); repeat.participants[0].tasks[1].taskId = repeat.participants[0].tasks[0].taskId;
    expect(() => scoreStudy(repeat)).toThrow('STUDY_DESIGN_INVALID');
  });
  it('rejects confounding task identity with presentation modality', () => {
    const study = syntheticStudy();
    for (const p of study.participants) for (const t of p.tasks) t.taskId = t.modality === '3d' ? 'A' : 'B';
    expect(() => scoreStudy(study)).toThrow('STUDY_TASK_CONFOUNDED_WITH_MODALITY');
  });
});
