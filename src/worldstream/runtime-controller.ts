import { canonical, type WorldDoc } from '@/ir/worlddoc';
import { buildRuntimeWorld } from '@/ir/build';
import { createRuntime, entityPlacements, entitySlotId, type EntityPlacement, type RuleFiring, type RunState, type Runtime, type WorldDocRuntime } from '@/sim/interpreter';
import type { IrNode, StateRef } from '@/ir/types';
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

/** A rule that fired after `tick` and whose predicate read a slot written in that tick. */
export interface DownstreamFiring {
  readonly tick: number;
  readonly ruleId: string;
  /** The written slots the predicate reads, in the predicate's own order. */
  readonly reads: readonly string[];
}

/** Kolik tiků kauzální stopy se drží. Starší tiky se zahazují, ne archivují. */
const EXPLAIN_RING = 4000;

const NO_FIRINGS: readonly RuleFiring[] = Object.freeze([]);

function placementSlots(entity: string, into: Set<string>): void {
  into.add(entitySlotId(entity, 'active'));
  into.add(entitySlotId(entity, 'x'));
  into.add(entitySlotId(entity, 'y'));
}

/**
 * Sloty, ze kterých `sense()` odvozuje hodnotu odkazu. Prefixy zrcadlí
 * `writeRef` v interpretu; odvozené fakty se rozkládají na sloty, ze kterých
 * je fáze 1 počítá — `inZone` je poloha a aktivita entity, ne vlastní slot.
 */
function refSlots(runtime: Runtime, ref: StateRef, into: Set<string>): void {
  switch (ref.space) {
    case 'counter':
      into.add(`c:${ref.slot}`);
      break;
    case 'flag':
      into.add(`f:${ref.slot}`);
      break;
    case 'timer':
      into.add(`t:${ref.slot}`);
      break;
    case 'inventory':
      into.add(`i:${ref.slot}`);
      break;
    case 'memory':
      into.add(`m:${ref.agent}#${ref.index}`);
      break;
    case 'entityState':
      into.add(entitySlotId(ref.entity, 'state'));
      break;
    case 'locked':
      into.add(entitySlotId(ref.entity, 'locked'));
      break;
    case 'observed':
      if (ref.fact === 'hasItem') into.add(`i:${ref.args[0]}`);
      else if (ref.fact === 'inZone') placementSlots(ref.args[0], into);
      else if (ref.fact === 'overlapping' || ref.fact === 'visible') {
        placementSlots(ref.args[0], into);
        placementSlots(ref.args[1], into);
      }
      // `started` a `socketHolds` ze stavu nečtou nic.
      break;
    case 'pulse':
      // Fronta událostí, ne slot.
      break;
    default: {
      const exhaustive: never = ref;
      throw new Error(`unreachable ref space: ${String(exhaustive)}`);
    }
  }
}

function slotsReadBy(runtime: Runtime, index: number, into: Set<string>): void {
  const node: IrNode = runtime.doc.ir.nodes[index];
  switch (node.kind) {
    case 'literal':
      break;
    case 'ref':
      refSlots(runtime, node.ref, into);
      break;
    case 'query':
      for (const entity of runtime.entityOrder) {
        if ((runtime.doc.space.tags[entity] ?? entity) === node.tag) placementSlots(entity, into);
      }
      break;
    case 'compare':
      slotsReadBy(runtime, node.lhs, into);
      slotsReadBy(runtime, node.rhs, into);
      break;
    case 'allOf':
    case 'anyOf':
      for (const operand of node.operands) slotsReadBy(runtime, operand, into);
      break;
    case 'not':
      slotsReadBy(runtime, node.operand, into);
      break;
    default: {
      const exhaustive: never = node;
      throw new Error(`unreachable node: ${String(exhaustive)}`);
    }
  }
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
  /** Tik → stopa. Klíče rostou, takže první klíč je vždy nejstarší tik. */
  const explainRing = new Map<number, readonly RuleFiring[]>();
  const predicateReads = new Map<string, ReadonlySet<string>>();
  const readsOf = (predicateId: string): ReadonlySet<string> => {
    const cached = predicateReads.get(predicateId);
    if (cached !== undefined) return cached;
    const reads = new Set<string>();
    slotsReadBy(runtime, runtime.predicateIndex.get(predicateId)!, reads);
    predicateReads.set(predicateId, reads);
    return reads;
  };
  const explainTick = (tick: number): readonly RuleFiring[] => explainRing.get(tick) ?? NO_FIRINGS;
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
    explainRing.set(tick, result.explain);
    if (explainRing.size > EXPLAIN_RING) explainRing.delete(explainRing.keys().next().value!);
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
    /** What each rule wrote in `tick`; empty outside the last 4000 ticks. */
    explainTick,
    /** Rules fired in the next `horizon` ticks whose predicate reads a slot written in `tick`. */
    downstreamOf: (tick: number, horizon = 20): readonly DownstreamFiring[] => {
      const written = new Set<string>();
      for (const firing of explainTick(tick)) for (const write of firing.writes) written.add(write.slot);
      const found: DownstreamFiring[] = [];
      for (let at = tick + 1; at <= tick + horizon; at += 1) {
        for (const firing of explainTick(at)) {
          if (!firing.guardHeld) continue;
          const reads = [...readsOf(firing.predicate)].filter(slot => written.has(slot));
          if (reads.length) found.push(Object.freeze({ tick: at, ruleId: firing.ruleId, reads: Object.freeze(reads) }));
        }
      }
      return Object.freeze(found);
    },
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
        for (const explained of explainRing.keys()) if (explained >= tick) explainRing.delete(explained);
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
