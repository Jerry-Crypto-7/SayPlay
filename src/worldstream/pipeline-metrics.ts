/** Local UI telemetry only: never part of WorldDoc, hashes, or replay inputs. */
export const PIPELINE_STAGES = ['source-request', 'session-request', 'blueprint-wait', 'coarse-build', 'response-parse', 'parameter-review', 'acceptance',
  'validation', 'lowering', 'mesh', 'first-frame', 'first-interaction', 'compare',
  'change-request', 'change-review', 'commit-request', 'snapshot-request'] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];
export type PipelineProvenance = 'unknown' | 'live' | 'fixture' | 'prepared' | 'cache';
export type PipelineOutcome = 'completed' | 'failed' | 'cancelled';
export type PipelineKind = 'source' | 'prompt' | 'prompt-edit' | 'prompt-detail-retry';
export interface PipelineRunHandle { readonly runId: number; readonly generation: number }
export interface PipelineStageHandle { readonly runId: number; readonly stageId: number }
interface Timing {
  readonly startedAtMs: number;
  /** Null means pending; zero is reserved for a genuinely finished zero-length span. */
  readonly endedAtMs: number | null;
  readonly elapsedMs: number | null;
  readonly outcome: PipelineOutcome | 'pending';
}
export interface PipelineStageSnapshot extends Timing {
  readonly stageId: number;
  readonly name: PipelineStage;
  readonly provenance: PipelineProvenance;
}
export interface PipelineRunSnapshot extends Timing {
  readonly runId: number;
  readonly generation: number;
  readonly kind: PipelineKind;
  readonly provenance: PipelineProvenance;
  readonly stages: readonly PipelineStageSnapshot[];
  readonly droppedStages: number;
}
export interface PipelineMetricsSnapshot {
  readonly version: 'worldstream-pipeline-v1';
  readonly currentRunId: number | null;
  readonly runs: readonly PipelineRunSnapshot[];
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Stage = Mutable<PipelineStageSnapshot>;
type Run = Mutable<Omit<PipelineRunSnapshot, 'stages'>> & {
  stages: Stage[]; handles: Map<PipelineStageHandle, Stage>;
};
const provenances = new Set<PipelineProvenance>(['unknown', 'live', 'fixture', 'prepared', 'cache']);
const outcomes = new Set<PipelineOutcome>(['completed', 'failed', 'cancelled']);

/** Handles are journal-owned object identities; cloned/foreign/evicted handles are ignored.
 * Starting a new run cancels its predecessor. Retained history defaults to 16 runs,
 * each with at most 128 spans. Human review is its own stage, never model latency. */
export function createPipelineMetrics(options: {
  readonly now?: () => number;
  readonly maxRuns?: number;
  readonly maxStagesPerRun?: number;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const maxRuns = options.maxRuns ?? 16;
  const maxStages = options.maxStagesPerRun ?? 128;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 16 ||
    !Number.isSafeInteger(maxStages) || maxStages < 1 || maxStages > 128) throw new Error('Invalid metrics bounds.');
  const runs = new Map<PipelineRunHandle, Run>();
  let current: PipelineRunHandle | null = null;
  let nextRun = 0;
  let nextStage = 0;
  let previousTime = 0;
  const time = () => {
    const value = now();
    // A broken injected clock cannot produce negative durations or NaN snapshots.
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid metrics clock.');
    previousTime = Math.max(previousTime, value);
    return previousTime;
  };
  const provenance = (value: PipelineProvenance = 'unknown') => {
    if (!provenances.has(value)) throw new Error('Invalid metrics provenance.');
    return value;
  };
  const finish = (entry: Mutable<Timing>, outcome: PipelineOutcome, at: number) => {
    entry.outcome = outcome;
    entry.endedAtMs = at;
    entry.elapsedMs = at - entry.startedAtMs;
  };
  const stop = (handle: PipelineRunHandle, outcome: PipelineOutcome, at: number) => {
    const run = runs.get(handle)!;
    for (const stage of run.stages) if (stage.outcome === 'pending') finish(stage, outcome, at);
    finish(run, outcome, at);
    if (current === handle) current = null;
  };
  return {
    setRunProvenance(handle: PipelineRunHandle, value: PipelineProvenance): boolean {
      const run = runs.get(handle);
      if (current !== handle || !run || run.outcome !== 'pending') return false;
      run.provenance = provenance(value);
      return true;
    },
    startRun(input: { readonly generation: number; readonly kind: PipelineKind; readonly provenance?: PipelineProvenance }): PipelineRunHandle {
      if (!Number.isSafeInteger(input.generation) || input.generation < 0 || !['source', 'prompt', 'prompt-edit', 'prompt-detail-retry'].includes(input.kind))
        throw new Error('Invalid metrics run.');
      const source = provenance(input.provenance);
      const at = time();
      if (current) stop(current, 'cancelled', at);
      const handle = Object.freeze({ runId: ++nextRun, generation: input.generation });
      runs.set(handle, { ...handle, kind: input.kind, provenance: source, startedAtMs: at,
        endedAtMs: null, elapsedMs: null, outcome: 'pending', stages: [], handles: new Map(), droppedStages: 0 });
      current = handle;
      while (runs.size > maxRuns) runs.delete(runs.keys().next().value!);
      return handle;
    },
    startStage(runHandle: PipelineRunHandle, name: PipelineStage, source?: PipelineProvenance): PipelineStageHandle | null {
      const run = runs.get(runHandle);
      if (current !== runHandle || !run || run.outcome !== 'pending') return null;
      if (!(PIPELINE_STAGES as readonly string[]).includes(name)) throw new Error('Invalid metrics stage.');
      const origin = provenance(source);
      if (run.stages.length >= maxStages) { run.droppedStages = Math.min(Number.MAX_SAFE_INTEGER, run.droppedStages + 1); return null; }
      const handle = Object.freeze({ runId: run.runId, stageId: ++nextStage });
      const stage: Stage = { stageId: handle.stageId, name, provenance: origin, startedAtMs: time(),
        endedAtMs: null, elapsedMs: null, outcome: 'pending' };
      run.stages.push(stage); run.handles.set(handle, stage);
      return handle;
    },
    finishStage(handle: PipelineStageHandle | null, outcome: PipelineOutcome = 'completed', source?: PipelineProvenance): boolean {
      if (!handle || !current) return false;
      const run = runs.get(current)!;
      const stage = run.handles.get(handle);
      if (!stage || stage.outcome !== 'pending') return false;
      if (!outcomes.has(outcome)) throw new Error('Invalid metrics outcome.');
      const origin = source === undefined ? stage.provenance : provenance(source);
      finish(stage, outcome, time());
      stage.provenance = origin;
      return true;
    },
    finishRun(handle: PipelineRunHandle, outcome: PipelineOutcome = 'completed'): boolean {
      const run = runs.get(handle);
      if (current !== handle || !run || run.outcome !== 'pending') return false;
      if (!outcomes.has(outcome)) throw new Error('Invalid metrics outcome.');
      // Successful completion must not manufacture completion times for pending work.
      if (outcome === 'completed' && run.stages.some(stage => stage.outcome === 'pending')) return false;
      stop(handle, outcome, time());
      return true;
    },
    snapshot(): PipelineMetricsSnapshot {
      return { version: 'worldstream-pipeline-v1', currentRunId: current?.runId ?? null, runs: [...runs.values()].map(({ handles: _handles, stages, ...run }) =>
        ({ ...run, stages: stages.map(stage => ({ ...stage })) })) };
    },
  };
}
