import { z } from 'zod';
import { buildRuntimeWorld } from '@/ir/build';
import { canonical, sealSimHash, simHashOf, worldDocSchema, type WorldDoc } from '@/ir/worlddoc';
import type { TraceInput } from '@/sim/interpreter';
import { createRuntimeController, type RuntimeController, type RuntimeSnapshot } from './runtime-controller';
import { readAcceptedIntervention, type RuleIntervention } from './intervention';

// The pilot compares at most ten minutes at 20 Hz, with a bounded input log.
export const MAX_COMPARISON_TICK = 12_000;
const tick = z.int().min(0).max(MAX_COMPARISON_TICK);
const baseSchema = z.object({ simRevision: z.int().nonnegative(), simHash: z.string(),
  comparisonRevision: z.int().nonnegative(), inputCount: z.int().nonnegative() }).strict();
const requestSchema = z.union([z.object({
  base: baseSchema,
  ruleId: z.string().min(1).max(128),
  durationTicks: z.int().min(1).max(65_535),
  forkTick: tick,
  observationTick: tick,
}).strict(), z.object({ base: baseSchema, accepted: worldDocSchema, forkTick: tick, observationTick: tick }).strict()]);
export type BranchRequest = z.infer<typeof requestSchema>;
export type BranchRejectionReason = 'INVALID_REQUEST' | 'STALE_REVISION' | 'STALE_INPUTS'
  | 'UNSUPPORTED_CHANGE' | 'ACTIVE_TIMER' | 'TICK_UNREACHABLE' | 'SHAPE_CHANGED' | 'RUNTIME_FAULT';

export interface BranchComparison {
  readonly ruleId: string;
  readonly timerId?: string;
  readonly previousDurationTicks?: number;
  readonly durationTicks?: number;
  readonly intervention: RuleIntervention;
  readonly forkTick: number;
  readonly observationTick: number;
  readonly inputLog: readonly TraceInput[];
  readonly originalDocument: WorldDoc;
  readonly changedDocument: WorldDoc;
  readonly originalAtFork: RuntimeSnapshot;
  readonly changedAtFork: RuntimeSnapshot;
  readonly original: RuntimeSnapshot;
  readonly changed: RuntimeSnapshot;
  readonly inputEffects: {
    readonly original: ReturnType<RuntimeController['getInputEffects']>;
    readonly changed: ReturnType<RuntimeController['getInputEffects']>;
  };
}

export interface BranchSnapshot {
  readonly revision: number;
  readonly comparison: BranchComparison | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const own = (value: Record<string, unknown> | null, key: string): unknown =>
  value && Object.hasOwn(value, key) ? value[key] : undefined;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A local comparison transaction, anchored to one accepted simulation.
 * Each accepted alternative is a sibling of that original, not a cumulative edit.
 * Source/evidence transactions and the natural-language UI are T8 and T6.
 */
export function createBranchController(document: WorldDoc, source: RuntimeController) {
  const base = structuredClone(worldDocSchema.parse(document));
  if (base.simHash !== simHashOf(base)) throw new Error('base simulation hash does not match');
  const built = buildRuntimeWorld(base.sim);
  if (!built.ok) throw new Error(`base simulation cannot run: ${built.issues.join('; ')}`);
  const replay = source.getReplayDocument();
  if (canonical([built.world.ir, built.world.space]) !== canonical([replay.ir, replay.space])) {
    throw new Error('source controller does not belong to the base simulation');
  }
  freeze(base);
  let current: BranchSnapshot = Object.freeze({ revision: 0, comparison: null });
  const listeners = new Set<() => void>();
  const reject = (reason: BranchRejectionReason, detail: string) =>
    ({ verdict: 'REJECTED' as const, reason, detail });

  return {
    getSnapshot: () => current,
    getBase: () => Object.freeze({ simRevision: base.simRevision, simHash: base.simHash,
      comparisonRevision: current.revision, inputCount: source.getInputLog().length }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    compare: (input: unknown) => {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) return reject('INVALID_REQUEST', 'Expected an accepted rule intervention and bounded ticks.');
      const request = parsed.data;
      if (request.base.simRevision !== base.simRevision || request.base.simHash !== base.simHash
        || request.base.comparisonRevision !== current.revision) {
        return reject('STALE_REVISION', 'The intervention was prepared against a different revision.');
      }
      // One capture supplies both branches, including rejected visitor actions.
      const inputs = source.getInputLog();
      if (request.base.inputCount !== inputs.length) return reject('STALE_INPUTS', 'Visitor input changed after the preview.');
      if (inputs.length > MAX_COMPARISON_TICK || request.forkTick > request.observationTick) {
        return reject('INVALID_REQUEST', 'The observation must follow the fork, within the pilot replay budget.');
      }
      let edited: WorldDoc;
      let intervention: RuleIntervention;
      if ('accepted' in request) {
        const accepted = readAcceptedIntervention(base, request.accepted);
        if (!accepted.ok) return reject('UNSUPPORTED_CHANGE', accepted.detail);
        edited = accepted.document;
        intervention = accepted.change;
      } else {
        const rule = record(own(record(base.sim.rules), request.ruleId));
        const actions = rule?.actions;
        if (!Array.isArray(actions)) return reject('UNSUPPORTED_CHANGE', 'The target rule has no supported actions.');
        if (rule && Object.hasOwn(rule, 'id') && rule.id !== request.ruleId) {
          return reject('UNSUPPORTED_CHANGE', 'The embedded rule identity disagrees with its stable map key.');
        }
        const timers = actions.flatMap((action, index) => record(action)?.kind === 'startTimer' ? [index] : []);
        if (timers.length !== 1) return reject('UNSUPPORTED_CHANGE', 'The target rule must start exactly one timer.');
        const index = timers[0];
        const action = record(actions[index])!;
        const timerId = action.ref;
        const previousDurationTicks = action.durationTicks;
        const declaration = typeof timerId === 'string'
          ? record(own(record(record(base.sim.state)?.timers), timerId)) : null;
        const capacity = declaration?.durationTicks;
        if (typeof timerId !== 'string' || typeof previousDurationTicks !== 'number'
          || !Number.isSafeInteger(previousDurationTicks) || typeof capacity !== 'number'
          || request.durationTicks > capacity || request.durationTicks === previousDurationTicks) {
          return reject('UNSUPPORTED_CHANGE', 'Change a declared future timer within its existing capacity.');
      }
      if (base.simRevision >= Number.MAX_SAFE_INTEGER || current.revision >= Number.MAX_SAFE_INTEGER) {
        return reject('UNSUPPORTED_CHANGE', 'The revision counter is exhausted.');
      }
      // A domain edit, not a generic JSON Patch: exactly one existing numeric
      // scalar can change. The lowering uses stable map keys even in documents
      // without embedded rule.id (including the museum oracle). Generic HTTP
      // commitPart requires embedded IDs and remains a separate, unchanged gate.
      const draft = structuredClone(base);
      const draftRule = record(own(record(draft.sim.rules), request.ruleId))!;
      record((draftRule.actions as unknown[])[index])!.durationTicks = request.durationTicks;
      edited = sealSimHash({ ...draft, simRevision: base.simRevision + 1 });
      intervention = { kind: 'timer', ruleId: request.ruleId, actionIndex: index,
        before: action, after: record((draftRule.actions as unknown[])[index]),
        timerId, previousDurationTicks, durationTicks: request.durationTicks };
      }
      if (base.simRevision >= Number.MAX_SAFE_INTEGER || current.revision >= Number.MAX_SAFE_INTEGER)
        return reject('UNSUPPORTED_CHANGE', 'The revision counter is exhausted.');
      const next = buildRuntimeWorld(edited.sim);
      if (!next.ok) return reject('UNSUPPORTED_CHANGE', 'The changed rules failed runtime validation.');

      const original = createRuntimeController({ ...built.world, trace: inputs });
      original.observeAt(request.forkTick);
      const originalAtFork = original.getSnapshot();
      if (originalAtFork.tick !== request.forkTick || originalAtFork.runState !== 'running') {
        return reject('TICK_UNREACHABLE', 'The original branch cannot continue from this fork tick.');
      }
      // Rebranch preserves active countdowns and the pending event queue. The
      // changed startTimer duration applies only when that action executes again.
      const changed = original.forkAt(next.world, request.forkTick, request.observationTick);
      if (changed.verdict === 'REJECTED') return reject(changed.reason, changed.detail);
      original.observeAt(request.observationTick);
      if (original.getSnapshot().runState === 'runtimeFault' || changed.atObservation.runState === 'runtimeFault') {
        return reject('RUNTIME_FAULT', 'A comparison branch exhausted the runtime budget.');
      }
      const comparison: BranchComparison = freeze({ ruleId: intervention.ruleId, intervention,
        ...(intervention.kind === 'timer' ? { timerId: intervention.timerId,
          previousDurationTicks: intervention.previousDurationTicks, durationTicks: intervention.durationTicks } : {}),
        forkTick: request.forkTick, observationTick: request.observationTick,
        inputLog: inputs, originalDocument: base, changedDocument: edited,
        originalAtFork, changedAtFork: changed.atFork,
        original: original.getSnapshot(), changed: changed.atObservation,
        inputEffects: { original: original.getInputEffects(request.forkTick),
          changed: changed.controller.getInputEffects(request.forkTick) },
      });
      // No accepted object, revision or source runtime was modified above.
      current = Object.freeze({ revision: current.revision + 1, comparison });
      for (const listener of listeners) listener();
      return { verdict: 'COMPARED' as const, snapshot: current };
    },
  };
}

export type BranchController = ReturnType<typeof createBranchController>;
