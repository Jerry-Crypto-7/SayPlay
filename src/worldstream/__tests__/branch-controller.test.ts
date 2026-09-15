import { describe, expect, it, vi } from 'vitest';
import surface from '../../../evals/reality-compiler/museum.sim.json';
import oracle from '../../../evals/reality-compiler/oracle.json';
import { buildRuntimeWorld } from '@/ir/build';
import { canonical, sealSimHash, simHashOf } from '@/ir/worlddoc';
import { verifyWitness } from '@/verify/witness';
import { createRuntimeController } from '../runtime-controller';
import { createBranchController, MAX_COMPARISON_TICK } from '../branch-controller';

function setup(terminal = false, inputs = oracle.cases[0].inputs, sim: unknown = surface) {
  const payload = terminal ? { ...surface, rules: { ...surface.rules,
    unlock_case: { ...surface.rules.unlock_case, actions: [...surface.rules.unlock_case.actions, { kind: 'win' }] },
  } } : sim;
  const document = sealSimHash({ irVersion: 'v1', simRevision: 7, lookRevision: 3,
    sim: payload as typeof surface,
    look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } });
  const built = buildRuntimeWorld(document.sim);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const live = createRuntimeController({ ...built.world, trace: inputs });
  live.observeAt(oracle.compareTick);
  const controller = createBranchController(document, live);
  const request = () => ({ base: controller.getBase(), ruleId: 'start_countdown',
    durationTicks: 200, forkTick: 0, observationTick: oracle.compareTick });
  return { controller, live, document, built, request };
}

function outcome(snapshot: { values: Readonly<Record<string, number>> }) {
  return { caseUnlocked: snapshot.values['e:case:locked'] === 0, alarm: snapshot.values['f:alarm'] === 1 };
}

describe('atomic timer branch comparison', () => {
  it('changes 20 seconds to 10 on identical inputs and preserves every non-target declaration and fork slot', () => {
    const { controller, live, document, request } = setup();
    live.setPaused(true);
    const liveBefore = live.getSnapshot();
    const onLive = vi.fn();
    const onComparison = vi.fn();
    live.subscribe(onLive);
    controller.subscribe(onComparison);
    const beforeDocument = canonical(document);
    const result = controller.compare(request());
    expect(result, JSON.stringify(result)).toMatchObject({ verdict: 'COMPARED' });
    const c = controller.getSnapshot().comparison!;
    expect(outcome(c.original)).toEqual(oracle.cases[0].expected);
    expect(outcome(c.changed)).toEqual(oracle.changedExpected);
    expect(c.original.observationTick).toBe(oracle.compareTick);
    expect(c.changed.observationTick).toBe(oracle.compareTick);
    expect(c.inputLog).toEqual(oracle.cases[0].inputs);
    expect(c.changedAtFork.values).toEqual(c.originalAtFork.values);
    expect(c.changedAtFork.entities).toEqual(c.originalAtFork.entities);
    expect(c.changedAtFork.tick).toBe(0);
    expect(c.changedAtFork.runState).toBe(c.originalAtFork.runState);
    const changed = structuredClone(c.changedDocument);
    (changed.sim.rules as typeof surface.rules).start_countdown.actions[1].durationTicks = 400;
    expect(changed.sim).toEqual(document.sim);
    expect(c.changedDocument.look).toEqual(document.look);
    expect(c.changedDocument.lookRevision).toBe(3);
    expect(c.changedDocument.simRevision).toBe(8);
    expect(c.changedDocument.simHash).toBe(simHashOf(c.changedDocument));
    expect(c.changedDocument.simHash).not.toBe(document.simHash);
    expect(c.originalDocument).toEqual(document);
    expect(canonical(document)).toBe(beforeDocument);
    expect(live.getSnapshot()).toBe(liveBefore);
    expect(onLive).not.toHaveBeenCalled();
    expect(onComparison).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().revision).toBe(1);
  });

  it('keeps actual terminal time instead of advancing a won engine to the observation horizon', () => {
    const { controller, request, built } = setup(true);
    expect(verifyWitness(built.world, oracle.cases[0].inputs).verdict).toBe('CERTIFIED');
    expect(controller.compare(request()).verdict).toBe('COMPARED');
    const c = controller.getSnapshot().comparison!;
    expect(c.original).toMatchObject({ observationTick: 300, tick: 261, endedAtTick: 261, runState: 'won' });
    expect(c.changed).toMatchObject({ observationTick: 300, tick: 300, endedAtTick: null, runState: 'running' });
    expect(outcome(c.original)).toEqual(oracle.cases[0].expected);
    expect(outcome(c.changed)).toEqual(oracle.changedExpected);
    expect(c.changed.transitions).toContainEqual({ tick: 220, inputs: [], ruleIds: ['expire_countdown'] });
  });

  it('supports a nonzero fork before activation and remains deterministic beyond the ring', () => {
    const { controller, request } = setup();
    expect(controller.compare({ ...request(), forkTick: 10, observationTick: 900 }).verdict).toBe('COMPARED');
    const first = controller.getSnapshot().comparison!;
    expect(first.changedAtFork.values).toEqual(first.originalAtFork.values);
    expect(first.changedAtFork.tick).toBe(10);
    expect(outcome(first.original)).toEqual(oracle.cases[0].expected);
    expect(outcome(first.changed)).toEqual(oracle.changedExpected);
    expect(controller.compare({ ...request(), forkTick: 10, observationTick: 900 }).verdict).toBe('COMPARED');
    expect(controller.getSnapshot().comparison).toEqual(first);
    expect(controller.getSnapshot().revision).toBe(2);
  });

  it('compares actual visitor dispatches instead of substituting the certification witness', () => {
    const { controller, live, request } = setup(false, []);
    live.dispatch({ actor: 'visitor', actionId: 'activate', target: 'sensorA' });
    live.dispatch({ actor: 'visitor', actionId: 'moveTo', target: 'approachB' });
    live.observeAt(540);
    live.dispatch({ actor: 'visitor', actionId: 'activate', target: 'sensorB' });
    const log = live.getInputLog();
    expect(log.map(input => input.tick)).toEqual([300, 301, 540]);
    expect(controller.compare({ ...request(), observationTick: 600 }).verdict).toBe('COMPARED');
    const c = controller.getSnapshot().comparison!;
    expect(c.inputLog).toEqual(log);
    expect(outcome(c.original)).toEqual(oracle.cases[0].expected);
    expect(outcome(c.changed)).toEqual(oracle.changedExpected);
  });

  it('reports a terminal changed branch at its actual tick as well', () => {
    const sim = { ...structuredClone(surface), rules: {
      ...structuredClone(surface.rules), unlock_case: { ...surface.rules.unlock_case,
        actions: [...surface.rules.unlock_case.actions, { kind: 'win' }] },
    } };
    sim.rules.start_countdown.actions[1].durationTicks = 200;
    const { controller, request } = setup(false, oracle.cases[0].inputs, sim);
    expect(controller.compare({ ...request(), durationTicks: 400, observationTick: 900 }).verdict).toBe('COMPARED');
    const c = controller.getSnapshot().comparison!;
    expect(c.original).toMatchObject({ observationTick: 900, tick: 900, endedAtTick: null });
    expect(c.changed).toMatchObject({ observationTick: 900, tick: 261, endedAtTick: 261, runState: 'won' });
    expect(outcome(c.changed)).toEqual(oracle.cases[0].expected);
  });

  it('the runtime fork rejects incompatible state shape without moving its source', () => {
    const { live, built } = setup();
    const before = live.getSnapshot();
    const next = structuredClone(built.world);
    const changed = { ...next, space: { ...next.space, blocked: [[4, 1] as const] } };
    expect(live.forkAt(changed, 0, 300)).toMatchObject({ verdict: 'REJECTED', reason: 'SHAPE_CHANGED' });
    expect(live.getSnapshot()).toBe(before);
  });

  it('keeps the input log even when the fork caller supplies a different witness', () => {
    const { live, built } = setup();
    const result = live.forkAt({ ...built.world, trace: [] }, 0, 300);
    expect(result.verdict).toBe('REBRANCHED');
    if (result.verdict !== 'REBRANCHED') throw new Error(result.detail);
    expect(outcome(result.atObservation)).toEqual(oracle.cases[0].expected);
    expect(result.atObservation.transitions.flatMap(entry => entry.inputs)).toEqual(oracle.cases[0].inputs);
  });

  it.each(oracle.cases)('preserves independent original oracle $id', entry => {
    const { controller, request } = setup(false, entry.inputs);
    expect(controller.compare({ ...request(), observationTick: entry.snapshotTick }).verdict).toBe('COMPARED');
    expect(outcome(controller.getSnapshot().comparison!.original)).toEqual(entry.expected);
    expect(controller.getSnapshot().comparison!.inputLog).toEqual(entry.inputs);
  });

  it.each([
    ['stale simulation revision', { base: { simRevision: 6 } }, 'STALE_REVISION'],
    ['wrong simulation hash', { base: { simHash: 'forged' } }, 'STALE_REVISION'],
    ['stale comparison revision', { base: { comparisonRevision: 0 } }, 'STALE_REVISION'],
    ['stale input count', { base: { inputCount: 0 } }, 'STALE_INPUTS'],
    ['active countdown', { forkTick: 21 }, 'ACTIVE_TIMER'],
    ['unknown rule', { ruleId: 'absent' }, 'UNSUPPORTED_CHANGE'],
    ['inherited key', { ruleId: '__proto__' }, 'UNSUPPORTED_CHANGE'],
    ['non-timer rule', { ruleId: 'unlock_case' }, 'UNSUPPORTED_CHANGE'],
    ['changed capacity', { durationTicks: 401 }, 'UNSUPPORTED_CHANGE'],
    ['no-op', { durationTicks: 400 }, 'UNSUPPORTED_CHANGE'],
    ['zero duration', { durationTicks: 0 }, 'INVALID_REQUEST'],
    ['fractional duration', { durationTicks: 0.5 }, 'INVALID_REQUEST'],
    ['negative fork', { forkTick: -1 }, 'INVALID_REQUEST'],
    ['horizon before fork', { forkTick: 12, observationTick: 10 }, 'INVALID_REQUEST'],
    ['unbounded horizon', { observationTick: MAX_COMPARISON_TICK + 1 }, 'INVALID_REQUEST'],
    ['caller-supplied patch path', { path: '/state/timers/countdown' }, 'INVALID_REQUEST'],
    ['caller-supplied world', { nextDocument: {} }, 'INVALID_REQUEST'],
  ] as const)('atomically rejects %s after a prior accepted comparison', (_, changes, reason) => {
    const { controller, live, request } = setup();
    expect(controller.compare(request()).verdict).toBe('COMPARED');
    const accepted = controller.getSnapshot();
    const before = live.getSnapshot();
    const callback = vi.fn();
    controller.subscribe(callback);
    const input = request();
    const result = controller.compare({ ...input, ...changes,
      base: { ...input.base, ...('base' in changes ? changes.base : {}) } });
    expect(result).toMatchObject({ verdict: 'REJECTED', reason });
    expect(controller.getSnapshot()).toBe(accepted);
    expect(live.getSnapshot()).toBe(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects a repeated proposal and a new input after preview', () => {
    const { controller, live, request } = setup();
    const proposal = request();
    expect(controller.compare(proposal).verdict).toBe('COMPARED');
    expect(controller.compare(proposal)).toMatchObject({ reason: 'STALE_REVISION' });
    const next = request();
    live.dispatch({ actor: 'visitor', actionId: 'activate', target: 'sensorA' });
    expect(controller.compare(next)).toMatchObject({ reason: 'STALE_INPUTS' });
  });

  it('rejects a terminal fork atomically', () => {
    const { controller, live, request } = setup(true);
    const before = live.getSnapshot();
    expect(controller.compare({ ...request(), forkTick: 261 })).toMatchObject({ reason: 'TICK_UNREACHABLE' });
    expect(controller.getSnapshot()).toEqual({ revision: 0, comparison: null });
    expect(live.getSnapshot()).toBe(before);
  });

  it('refuses ambiguous timer actions', () => {
    const sim = structuredClone(surface);
    sim.rules.start_countdown.actions.push({ ...sim.rules.start_countdown.actions[1] });
    const { controller, request } = setup(false, oracle.cases[0].inputs, sim);
    expect(controller.compare(request())).toMatchObject({ reason: 'UNSUPPORTED_CHANGE' });
  });

  it('rejects mismatched base hash or runtime before constructing a transaction', () => {
    const { live, document } = setup();
    expect(() => createBranchController({ ...document, simHash: 'wrong' }, live)).toThrow(/hash/);
    const changed = structuredClone(document);
    (changed.sim.rules as typeof surface.rules).start_countdown.actions[1].durationTicks = 200;
    expect(() => createBranchController(sealSimHash(changed), live)).toThrow(/does not belong/);
  });

  it('exports detached replay data and immutable accepted results', () => {
    const { live, controller, request } = setup();
    const replay = live.getReplayDocument();
    (replay.trace as unknown[]).length = 0;
    expect(live.getInputLog()).toEqual(oracle.cases[0].inputs);
    controller.compare(request());
    const comparison = controller.getSnapshot().comparison!;
    expect(Object.isFrozen(comparison.changedDocument.sim.rules)).toBe(true);
    expect(Object.isFrozen(comparison.changedAtFork.transitions)).toBe(true);
    expect(() => { (comparison.changedDocument.sim.rules as typeof surface.rules).start_countdown.actions[1].durationTicks = 12; }).toThrow();
    expect(() => { (comparison.inputLog as unknown[]).length = 0; }).toThrow();
  });
});
