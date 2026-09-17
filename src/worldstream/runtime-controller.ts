import { canonical, type WorldDoc } from '@/ir/worlddoc';
import { buildRuntimeWorld } from '@/ir/build';
import { createRuntime, entityPlacements, type EntityPlacement, type RunState, type Runtime, type WorldDocRuntime } from '@/sim/interpreter';
import { advance, createTimeline, seekTo, type Timeline } from '@/sim/timeline';
import { rebranchAt, type RebranchRejection } from '@/sim/rebranch';
import { runtimeActions, sameAction, type RuntimeAction } from './runtime-input';
import { hashHex } from '@/sim/hash';

export interface RuntimeTransition {
  readonly tick: number;
  readonly inputs: readonly Readonly<import('@/sim/interpreter').TraceInput>[];
  readonly ruleIds: readonly string[];
}

export interface RuntimeSnapshot {
  readonly stateHash: string;
  readonly observationTick: number;
  readonly tick: number;
  readonly endedAtTick: number | null;
  readonly paused: boolean;
  readonly runState: RunState;
  readonly entities: readonly (EntityPlacement & { readonly dx: number; readonly dy: number })[];
  readonly values: Readonly<Record<string, number>>;
  readonly transitions: readonly RuntimeTransition[];
  readonly canInput: boolean;
}

export type RuntimeForkResult = RebranchRejection | {
  readonly verdict: 'REBRANCHED';
  readonly atFork: RuntimeSnapshot;
  readonly atObservation: RuntimeSnapshot;
  /** Continue this exact fork, including state accumulated before the intervention. */
  readonly controller: RuntimeController;
};

/** Jeden vlastník interpretu a osy. Hodiny prohlížeče ani renderer sem nepatří. */
export function createRuntimeController(document: WorldDocRuntime) {
  const runtime = createRuntime(structuredClone(document));
  return ownRuntime(runtime, createTimeline(runtime, 600));
}

/** Owns both initial and rebranched runtimes; neither is exposed to callers. */
function ownRuntime(initial: Runtime, timeline: Timeline) {
  const inputs = [...initial.doc.trace];
  const runtime: Runtime = { ...initial, doc: { ...initial.doc, trace: inputs } };
  const actions = runtimeActions(runtime.doc);
  let transitions: readonly RuntimeTransition[] = Object.freeze([]);
  let highWaterTick = runtime.tick;
  const listeners = new Set<() => void>();
  let paused = false;
  let observationTick = runtime.tick;
  const inputEffects = new Map<number, readonly string[]>();
  const snapshot = (): RuntimeSnapshot => Object.freeze({
    stateHash: hashHex(runtime.state),
    observationTick,
    tick: runtime.tick,
    endedAtTick: runtime.runState === 'running' ? null : runtime.tick,
    paused,
    runState: runtime.runState,
    transitions,
    canInput: !paused && runtime.runState === 'running' && runtime.tick >= highWaterTick,
    entities: Object.freeze(entityPlacements(runtime).map((entity) => {
      const decl = runtime.entityDecls.get(entity.stableId)!;
      const origin = runtime.doc.space.sockets[decl.socket] ?? [0, 0];
      return Object.freeze({ ...entity, dx: entity.x - origin[0], dy: entity.y - origin[1] });
    })),
    values: Object.freeze(Object.fromEntries(runtime.layout.slots.map((slot, index) =>
      [slot.id, runtime.state[index] + slot.min]))),
  });
  let current = snapshot();
  const publish = () => {
    current = snapshot();
    for (const listener of listeners) listener();
  };
  const validateTick = (tick: number) => {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('tick must be a non-negative safe integer');
  };
  const advanceOne = () => {
    const tick = runtime.tick;
    const stepInputs = inputs.filter(input => input.tick === tick);
    const result = advance(timeline, runtime, stepInputs);
    if (stepInputs.length) inputEffects.set(tick, Object.freeze([...result.fired]));
    highWaterTick = Math.max(highWaterTick, runtime.tick);
    if (stepInputs.length || result.fired.length) {
      transitions = Object.freeze([...transitions, Object.freeze({ tick,
        inputs: Object.freeze(stepInputs.map(input => Object.freeze({ ...input }))),
        ruleIds: Object.freeze([...result.fired]),
      })].slice(-60));
    }
    return result;
  };
  return {
    actions,
    getReplayDocument: (): WorldDocRuntime => structuredClone(runtime.doc),
    /** Pure projection: rebranchAt is allowed to rewind only this private copy.
     * The changed document's witness never replaces the visitor input log.
     */
    forkAt: (next: WorldDocRuntime, forkTick: number, horizon: number): RuntimeForkResult => {
      validateTick(forkTick);
      validateTick(horizon);
      if (horizon < forkTick) throw new Error('observation must not precede the fork');
      const source = createRuntime(structuredClone(runtime.doc));
      const result = rebranchAt(createTimeline(source, 600), source, forkTick,
        structuredClone({ ...next, trace: inputs }));
      if (result.verdict === 'REJECTED') return result;
      const branch = ownRuntime(result.runtime, result.timeline);
      const atFork = branch.getSnapshot();
      branch.observeAt(horizon);
      return { verdict: 'REBRANCHED', atFork, atObservation: branch.getSnapshot(), controller: branch };
    },
    getInputLog: () => Object.freeze(inputs.map(input => Object.freeze({ ...input }))),
    /** Rules fired during each input tick, not a claim of per-action causality. */
    getInputEffects: (fromTick: number) => Object.freeze(inputs.filter(input => input.tick >= fromTick && input.tick < observationTick)
      .map(input => Object.freeze({ input: Object.freeze({ ...input }),
        status: input.tick >= runtime.tick ? 'terminal' as const
          : (inputEffects.get(input.tick)?.length ?? 0) > 0 ? 'rules-fired' as const : 'no-rule-fired' as const,
        ruleIds: inputEffects.get(input.tick) ?? Object.freeze([] as string[]),
      }))),
    dispatch: (action: RuntimeAction) => {
      if (!current.canInput) return { ok: false as const, reason: 'Resume at the latest tick to interact.' };
      if (!actions.some(candidate => sameAction(candidate, action))) {
        return { ok: false as const, reason: 'This action is not declared by the world.' };
      }
      const tick = runtime.tick;
      inputs.push({ tick, actor: action.actor, actionId: action.actionId,
        ...(action.target === undefined ? {} : { target: action.target }) });
      const result = advanceOne();
      observationTick = runtime.tick;
      publish();
      return { ok: true as const, tick, ruleIds: result.fired, runState: result.runState };
    },
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setPaused: (value: boolean) => {
      if (paused === value) return;
      paused = value;
      publish();
    },
    advanceTicks: (count: number) => {
      validateTick(count);
      validateTick(observationTick + count);
      if (paused || count === 0) return;
      const target = observationTick + count;
      while (runtime.tick < target && runtime.runState === 'running') {
        advanceOne();
      }
      observationTick = target;
      publish();
    },
    observeAt: (tick: number) => {
      validateTick(tick);
      if (tick < runtime.tick) {
        seekTo(timeline, runtime, tick);
        for (const inputTick of inputEffects.keys()) if (inputTick >= tick) inputEffects.delete(inputTick);
        transitions = Object.freeze(transitions.filter(entry => entry.tick < runtime.tick));
      } else {
        while (runtime.tick < tick && runtime.runState === 'running') advanceOne();
      }
      observationTick = tick;
      publish();
    },
  };
}

export type RuntimeController = ReturnType<typeof createRuntimeController>;

export interface RuntimeBinding {
  readonly sessionId: string;
  readonly simulation: string;
  readonly controller: RuntimeController;
}

/** Vzhled ani nová JS reference neresetují simulaci; nová relace ano.
 * Certifikační witness se návštěvníkovi automaticky nepřehrává.
 */
export function bindRuntime(previous: RuntimeBinding | null, sessionId: string, doc: WorldDoc): RuntimeBinding {
  const simulation = canonical(doc.sim);
  if (previous?.sessionId === sessionId && previous.simulation === simulation) return previous;
  const built = buildRuntimeWorld(doc.sim);
  if (!built.ok) throw new Error(`the simulation cannot run: ${built.issues.join('; ')}`);
  return { sessionId, simulation, controller: createRuntimeController({ ...built.world, trace: [] }) };
}
