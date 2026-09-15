import { describe, expect, it } from 'vitest';
import { createPipelineMetrics, type PipelineMetricsSnapshot } from '../pipeline-metrics';

describe('local pipeline metrics', () => {
  it('retains a failed display attempt separately from commit and human edit review', () => {
    let now = 0;
    const journal = createPipelineMetrics({ now: () => now });
    const run = journal.startRun({ generation: 1, kind: 'prompt-edit', provenance: 'prepared' });
    const request = journal.startStage(run, 'change-request');
    now = 20; journal.finishStage(request);
    const review = journal.startStage(run, 'change-review');
    now = 1020; journal.finishStage(review);
    const commit = journal.startStage(run, 'commit-request');
    now = 1040; journal.finishStage(commit);
    const failed = journal.startStage(run, 'snapshot-request');
    now = 1050; journal.finishStage(failed, 'failed');
    const restored = journal.startStage(run, 'snapshot-request');
    now = 1080; journal.finishStage(restored);
    expect(journal.finishRun(run)).toBe(true);
    expect(journal.snapshot().runs[0]).toMatchObject({ kind: 'prompt-edit', outcome: 'completed', stages: [
      { name: 'change-request', elapsedMs: 20 }, { name: 'change-review', elapsedMs: 1000 },
      { name: 'commit-request', elapsedMs: 20 }, { name: 'snapshot-request', outcome: 'failed', elapsedMs: 10 },
      { name: 'snapshot-request', outcome: 'completed', elapsedMs: 30 },
    ] });
  });
  it('updates only a current run provenance and explicitly labels cache results after completion', () => {
    const journal = createPipelineMetrics({ now: () => 1 });
    const run = journal.startRun({ generation: 0, kind: 'prompt' });
    const mesh = journal.startStage(run, 'mesh');
    expect(journal.setRunProvenance(run, 'live')).toBe(true);
    expect(journal.snapshot().runs[0].stages[0].provenance).toBe('unknown');
    expect(journal.finishStage(mesh, 'completed', 'cache')).toBe(true);
    expect(journal.snapshot().runs[0]).toMatchObject({ provenance: 'live', stages: [{ provenance: 'cache' }] });
    journal.finishRun(run);
    expect(journal.setRunProvenance(run, 'fixture')).toBe(false);
    expect(journal.finishStage(mesh, 'completed', 'prepared')).toBe(false);
    expect(journal.snapshot().runs[0].stages[0].provenance).toBe('cache');
  });
  it('keeps pending measurements unknown and separates human review from model request time', () => {
    let now = 10;
    const journal = createPipelineMetrics({ now: () => now });
    const run = journal.startRun({ generation: 4, kind: 'source', provenance: 'live' });
    const request = journal.startStage(run, 'source-request', 'live');
    expect(journal.snapshot().runs[0].stages[0]).toMatchObject({ outcome: 'pending', elapsedMs: null, endedAtMs: null });
    expect(journal.finishRun(run)).toBe(false);
    now = 110; journal.finishStage(request);
    const parse = journal.startStage(run, 'response-parse');
    now = 115; journal.finishStage(parse);
    const review = journal.startStage(run, 'parameter-review');
    now = 60_115; journal.finishStage(review);
    const acceptance = journal.startStage(run, 'acceptance');
    now = 60_122; journal.finishStage(acceptance); journal.finishRun(run);
    const result = journal.snapshot();
    expect(result.currentRunId).toBeNull();
    expect(result.runs[0].stages.map(stage => [stage.name, stage.elapsedMs, stage.provenance])).toEqual([
      ['source-request', 100, 'live'], ['response-parse', 5, 'unknown'],
      ['parameter-review', 60_000, 'unknown'], ['acceptance', 7, 'unknown'],
    ]);
    expect(result.runs[0]).toMatchObject({ generation: 4, elapsedMs: 60_112, outcome: 'completed' });
  });

  it('clamps a backwards clock and rejects invalid clocks without mutating the active measurement', () => {
    let now = 20;
    const journal = createPipelineMetrics({ now: () => now });
    const run = journal.startRun({ generation: 0, kind: 'prompt' });
    const mesh = journal.startStage(run, 'mesh', 'cache');
    now = 10; journal.finishStage(mesh);
    expect(journal.snapshot().runs[0].stages[0].elapsedMs).toBe(0);
    const before = journal.snapshot();
    for (const invalid of [NaN, Infinity, -1]) {
      now = invalid;
      expect(() => journal.finishRun(run)).toThrow('Invalid metrics clock');
      expect(journal.snapshot()).toEqual(before);
    }
    now = 50; journal.finishRun(run);
    expect(journal.snapshot().runs[0].elapsedMs).toBe(30);
  });

  it('cancels pending stages and ignores late callbacks after stop or replacement', () => {
    let now = 0;
    const journal = createPipelineMetrics({ now: () => now });
    const old = journal.startRun({ generation: 1, kind: 'prompt', provenance: 'prepared' });
    const stage = journal.startStage(old, 'mesh');
    now = 8; expect(journal.finishRun(old, 'cancelled')).toBe(true);
    const next = journal.startRun({ generation: 2, kind: 'source', provenance: 'fixture' });
    const before = journal.snapshot();
    now = 900;
    expect(journal.finishStage(stage)).toBe(false);
    expect(journal.finishRun(old)).toBe(false);
    expect(journal.startStage(old, 'first-frame')).toBeNull();
    expect(journal.snapshot()).toEqual(before);
    const pending = journal.startStage(next, 'source-request');
    now = 910;
    const latest = journal.startRun({ generation: 3, kind: 'prompt' });
    expect(journal.finishStage(pending)).toBe(false);
    expect(journal.snapshot()).toMatchObject({ currentRunId: latest.runId, runs: [
      { outcome: 'cancelled', stages: [{ outcome: 'cancelled', elapsedMs: 8 }] },
      { outcome: 'cancelled', stages: [{ outcome: 'cancelled', elapsedMs: 10 }] },
      { outcome: 'pending' },
    ] });
  });

  it('retains explicit failed stages and closes other pending spans as failed', () => {
    let now = 0;
    const journal = createPipelineMetrics({ now: () => now });
    const run = journal.startRun({ generation: 0, kind: 'prompt' });
    const mesh = journal.startStage(run, 'mesh');
    journal.startStage(run, 'first-frame');
    now = 12; expect(journal.finishStage(mesh, 'failed')).toBe(true);
    now = 14; expect(journal.finishRun(run, 'failed')).toBe(true);
    expect(journal.snapshot().runs[0].stages.map(stage => [stage.outcome, stage.elapsedMs]))
      .toEqual([['failed', 12], ['failed', 14]]);
  });

  it('bounds history and span counts, records overflow, and evicts old handles', () => {
    const journal = createPipelineMetrics({ now: () => 1, maxRuns: 2, maxStagesPerRun: 2 });
    const old = journal.startRun({ generation: 1, kind: 'source' });
    const oldStage = journal.startStage(old, 'source-request');
    journal.startStage(old, 'first-frame');
    expect(journal.startStage(old, 'first-interaction')).toBeNull();
    expect(journal.snapshot().runs[0].droppedStages).toBe(1);
    journal.startRun({ generation: 2, kind: 'prompt' });
    const latest = journal.startRun({ generation: 3, kind: 'prompt' });
    expect(journal.snapshot().runs.map(run => run.generation)).toEqual([2, 3]);
    expect(journal.finishStage(oldStage)).toBe(false);
    expect(journal.startStage(old, 'mesh')).toBeNull();
    expect(journal.snapshot().currentRunId).toBe(latest.runId);
  });

  it('returns independent snapshots and ignores copied or foreign handles', () => {
    const journal = createPipelineMetrics({ now: () => 1 });
    const run = journal.startRun({ generation: 0, kind: 'source' });
    const stage = journal.startStage(run, 'compare')!;
    const snapshot = journal.snapshot();
    const mutable = snapshot as unknown as { runs: { generation: number; stages: { name: string }[] }[] };
    mutable.runs[0].generation = 999;
    mutable.runs[0].stages[0].name = 'private prompt text';
    mutable.runs.push({ generation: 999, stages: [] });
    expect(journal.snapshot().runs).toHaveLength(1);
    expect(journal.snapshot().runs[0]).toMatchObject({ generation: 0, stages: [{ name: 'compare' }] });
    expect(journal.finishStage({ ...stage })).toBe(false);
    expect(journal.finishRun({ ...run })).toBe(false);
    const foreign = createPipelineMetrics({ now: () => 1 });
    const foreignRun = foreign.startRun({ generation: 0, kind: 'source' });
    expect(journal.startStage(foreignRun, 'compare')).toBeNull();
    expect(journal.finishStage(foreign.startStage(foreignRun, 'compare'))).toBe(false);
    expect(journal.finishStage(stage)).toBe(true);
    expect(journal.finishStage(stage)).toBe(false);
  });

  it('copies only approved fields and rejects unbounded configuration', () => {
    for (const maxRuns of [0, 17, 1.5, Infinity]) expect(() => createPipelineMetrics({ maxRuns })).toThrow();
    for (const maxStagesPerRun of [0, 129, 1.5]) expect(() => createPipelineMetrics({ maxStagesPerRun })).toThrow();
    const journal = createPipelineMetrics({ now: () => 0 });
    const input = { generation: 0, kind: 'source' as const, prompt: 'secret input', source: 'secret source' };
    const run = journal.startRun(input);
    journal.startStage(run, 'validation');
    const result: PipelineMetricsSnapshot = journal.snapshot();
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(() => journal.startRun({ generation: -1, kind: 'source' })).toThrow();
    expect(journal.snapshot().currentRunId).toBe(run.runId);
  });
});
