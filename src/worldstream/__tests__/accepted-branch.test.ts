import { describe, expect, it } from 'vitest';
import surface from '../../../evals/reality-compiler/museum.sim.json';
import oracle from '../../../evals/reality-compiler/oracle.json';
import { buildRuntimeWorld } from '@/ir/build';
import { sealSimHash } from '@/ir/worlddoc';
import { commitPart } from '@/ir/revision';
import { createRuntimeController } from '../runtime-controller';
import { compareAcceptedBranch, compareCommitCandidate, prepareBranch } from '../accepted-branch';

function setup(embedded = false) {
  const sim = structuredClone(surface);
  if (embedded) Object.entries(sim.rules).forEach(([id, rule]) => Object.assign(rule, { id }));
  const document = sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim,
    look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } });
  const built = buildRuntimeWorld(document.sim);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const source = createRuntimeController({ ...built.world, trace: oracle.cases[0].inputs });
  source.observeAt(300);
  const prepared = prepareBranch(document, source);
  const changed = structuredClone(document);
  (changed.sim.rules as typeof sim.rules).start_countdown.actions[1].durationTicks = 200;
  const accepted = sealSimHash({ ...changed, simRevision: 1 });
  const compare = () => compareAcceptedBranch(prepared, accepted, { forkTick: 0, observationTick: 300 });
  return { document, source, prepared, accepted, compare };
}

describe('accepted change to branch adapter', () => {
  it('prepares the same accepted replay on server and client with identical state hashes', () => {
    const { document, accepted, prepared, source, compare } = setup();
    const request = { base: prepared.base, inputs: source.getInputLog(), forkTick: 0, observationTick: 300 };
    const server = compareCommitCandidate(document, accepted, request);
    const client = compare();
    expect(server).toEqual(client);
    expect(compareCommitCandidate(document, accepted, request)).toEqual(server);
    if (server.verdict !== 'COMPARED') throw new Error(server.detail);
    const result = server.snapshot.comparison!;
    expect(result.original.stateHash).not.toBe(result.changed.stateHash);
    expect(result.originalAtFork.stateHash).toBe(result.changedAtFork.stateHash);
    expect(result.inputEffects.original).toHaveLength(request.inputs.length);
    expect(result.inputEffects.changed.at(-1)?.status).toBe('no-rule-fired');
  });

  it.each(['hash', 'revision', 'inputs', 'budget', 'order'])('rejects invalid pre-commit %s without source changes', kind => {
    const { document, accepted, prepared, source } = setup();
    const before = source.getSnapshot();
    const request = { base: { ...prepared.base }, inputs: [...source.getInputLog()], forkTick: 0, observationTick: 300 };
    if (kind === 'hash') request.base.simHash = 'wrong';
    if (kind === 'revision') request.base.simRevision++;
    if (kind === 'inputs') request.base.inputCount++;
    if (kind === 'budget') request.observationTick = 12001;
    if (kind === 'order') request.inputs.reverse();
    expect(compareCommitCandidate(document, accepted, request).verdict).toBe('REJECTED');
    expect(source.getSnapshot()).toBe(before);
  });
  it.each([false, true])('compares map rules with embedded IDs=%s without mutating the original', embedded => {
    const { source, compare } = setup(embedded);
    const before = source.getSnapshot();
    const result = compare();
    expect(result.verdict).toBe('COMPARED');
    if (result.verdict !== 'COMPARED') return;
    expect(result.snapshot.comparison).toMatchObject({ ruleId: 'start_countdown', durationTicks: 200,
      original: { observationTick: 300, values: { 'e:case:locked': 0, 'f:alarm': 0 } },
      changed: { observationTick: 300, values: { 'e:case:locked': 1, 'f:alarm': 1 } } });
    expect(source.getSnapshot()).toBe(before);
  });

  it('accepts an actual generic patch commit with matching embedded IDs', () => {
    const { document, prepared } = setup(true);
    const committed = commitPart(document, { part: 'sim', baseRevision: 0,
      operations: [{ op: 'replace', path: '/rules/start_countdown/actions/1/durationTicks', value: 200 }] });
    expect(committed.verdict).toBe('COMMITTED');
    if (committed.verdict !== 'COMMITTED') return;
    expect(compareAcceptedBranch(prepared, committed.doc, { forkTick: 0, observationTick: 300 }).verdict).toBe('COMPARED');
  });

  it.each(['extra edit', 'stale revision', 'bad hash', 'look edit', 'no change', 'identity edit', 'timer beyond capacity'])('refuses %s without publishing a comparison', kind => {
    const { accepted, prepared } = setup();
    if (kind === 'extra edit') (accepted.sim.rules as typeof surface.rules).unlock_case.actions.pop();
    if (kind === 'stale revision') accepted.simRevision = 3;
    if (kind === 'look edit') accepted.lookRevision++;
    if (kind === 'no change') (accepted.sim.rules as typeof surface.rules).start_countdown.actions[1].durationTicks = 400;
    if (kind === 'identity edit') Object.assign((accepted.sim.rules as typeof surface.rules).start_countdown, { id: 'other' });
    if (kind === 'timer beyond capacity') (accepted.sim.rules as typeof surface.rules).start_countdown.actions[1].durationTicks = 401;
    const next = sealSimHash(accepted);
    if (kind === 'bad hash') next.simHash = 'wrong';
    expect(compareAcceptedBranch(prepared, next, { forkTick: 0, observationTick: 300 }).verdict).toBe('REJECTED');
    expect(prepared.controller.getSnapshot()).toEqual({ revision: 0, comparison: null });
  });

  it('preserves an active countdown and refuses inputs added after preview', () => {
    const active = setup();
    const result = compareAcceptedBranch(active.prepared, active.accepted, { forkTick: 22, observationTick: 300 });
    expect(result.verdict).toBe('COMPARED');
    if (result.verdict === 'COMPARED') {
      const comparison = result.snapshot.comparison!;
      expect(comparison.changedAtFork.values).toEqual(comparison.originalAtFork.values);
      expect(comparison.changedAtFork.entities).toEqual(comparison.originalAtFork.entities);
      expect(comparison.changedAtFork.tick).toBe(comparison.originalAtFork.tick);
      expect(comparison.changed.values).toEqual(comparison.original.values);
      expect(comparison.changedAtFork.values['t:countdown']).toBeGreaterThan(0);
    }
    const { prepared, accepted, source } = setup();
    source.dispatch(source.actions[0]);
    expect(compareAcceptedBranch(prepared, accepted, { forkTick: 0, observationTick: 300 })).toMatchObject({ verdict: 'REJECTED', reason: 'STALE_INPUTS' });
  });

  it.each([
    ['start condition', 'start_countdown', 'condition', -1, { kind: 'flagIs', ref: 'started', value: true }, { 'e:case:locked': 1 }],
    ['unlock condition', 'unlock_case', 'condition', -1, { kind: 'flagIs', ref: 'started', value: false }, { 'e:case:locked': 1 }],
    ['disable starting flag', 'start_countdown', 'action', 0, { kind: 'setFlag', ref: 'started', value: false }, { 'e:case:locked': 1 }],
    ['activate alarm', 'start_countdown', 'action', 0, { kind: 'setFlag', ref: 'alarm', value: true }, { 'f:alarm': 1 }],
    ['keep case locked', 'unlock_case', 'action', 0, { kind: 'setLocked', target: 'case', value: true }, { 'e:case:locked': 1 }],
    ['alarm instead of stopping timer', 'unlock_case', 'action', 1, { kind: 'setFlag', ref: 'alarm', value: true }, { 'f:alarm': 1 }],
  ] as const)('compares the observable non-timer intervention: %s', (_, ruleId, kind, index, replacement, expected) => {
    const { document, prepared, source } = setup();
    const draft = structuredClone(document);
    const rules = draft.sim.rules as Record<string, { condition: unknown; actions: unknown[] }>;
    if (kind === 'condition') rules[ruleId].condition = replacement;
    else rules[ruleId].actions[index] = replacement;
    const accepted = sealSimHash({ ...draft, simRevision: 1 });
    const before = source.getSnapshot();
    const result = compareAcceptedBranch(prepared, accepted, { forkTick: 10, observationTick: 300 });
    expect(result.verdict).toBe('COMPARED');
    if (result.verdict !== 'COMPARED') return;
    const c = result.snapshot.comparison!;
    expect(c.intervention).toMatchObject({ kind, ruleId });
    expect(c.timerId).toBeUndefined();
    expect(c.changedAtFork).toEqual(c.originalAtFork);
    expect(c.changed.values).toMatchObject(expected);
    expect(c.changed.values).not.toEqual(c.original.values);
    expect(c.inputLog).toEqual(source.getInputLog());
    expect(source.getSnapshot()).toBe(before);
  });

  it.each(['new symbol', 'hidden null metadata', 'trigger', 'two actions', 'declaration'])('rejects %s without publishing or changing runtime', kind => {
    const { document, prepared, source } = setup();
    const draft = structuredClone(document);
    const rules = draft.sim.rules as Record<string, { condition: unknown; actions: unknown[]; event: unknown; note?: null }>;
    rules.start_countdown.actions[0] = { kind: 'setFlag', ref: kind === 'new symbol' ? 'undeclared' : 'alarm', value: true };
    if (kind === 'hidden null metadata') rules.start_countdown.note = null;
    if (kind === 'trigger') rules.start_countdown.event = { kind: 'onStart' };
    if (kind === 'two actions') rules.start_countdown.actions[1] = { kind: 'setFlag', ref: 'started', value: true };
    if (kind === 'declaration') (draft.sim.state as typeof surface.state).timers.countdown.durationTicks = 600;
    const before = source.getSnapshot();
    expect(compareAcceptedBranch(prepared, sealSimHash({ ...draft, simRevision: 1 }), { forkTick: 0, observationTick: 300 }).verdict).toBe('REJECTED');
    expect(source.getSnapshot()).toBe(before);
    expect(prepared.controller.getSnapshot().comparison).toBeNull();
  });

  it('continues a nonzero fork without retroactively applying the edit before the fork', () => {
    const { source, accepted, prepared } = setup();
    const compared = compareAcceptedBranch(prepared, accepted, { forkTick: 300, observationTick: 350 });
    expect(compared.verdict).toBe('COMPARED');
    const built = buildRuntimeWorld(accepted.sim);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const fork = source.forkAt(built.world, 300, 350);
    expect(fork.verdict).toBe('REBRANCHED');
    if (fork.verdict !== 'REBRANCHED' || compared.verdict !== 'COMPARED') return;
    expect(fork.controller.getSnapshot()).toEqual(compared.snapshot.comparison!.changed);
    expect(fork.controller.getSnapshot().values).toMatchObject({ 'e:case:locked': 0, 'f:alarm': 0 });
    fork.controller.advanceTicks(5);
    expect(fork.controller.getSnapshot()).toMatchObject({ tick: 355, values: { 'e:case:locked': 0, 'f:alarm': 0 } });
    expect(source.getSnapshot().tick).toBe(300);
  });
});
