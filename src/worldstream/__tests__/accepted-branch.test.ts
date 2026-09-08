import { describe, expect, it } from 'vitest';
import surface from '../../../evals/reality-compiler/museum.sim.json';
import oracle from '../../../evals/reality-compiler/oracle.json';
import { buildRuntimeWorld } from '@/ir/build';
import { sealSimHash } from '@/ir/worlddoc';
import { commitPart } from '@/ir/revision';
import { createRuntimeController } from '../runtime-controller';
import { compareAcceptedBranch, prepareBranch } from '../accepted-branch';

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

  it.each(['extra edit', 'stale revision', 'bad hash', 'look edit', 'no change', 'identity edit'])('refuses %s without publishing a comparison', kind => {
    const { accepted, prepared } = setup();
    if (kind === 'extra edit') (accepted.sim.rules as typeof surface.rules).unlock_case.actions.pop();
    if (kind === 'stale revision') accepted.simRevision = 3;
    if (kind === 'look edit') accepted.lookRevision++;
    if (kind === 'no change') (accepted.sim.rules as typeof surface.rules).start_countdown.actions[1].durationTicks = 400;
    if (kind === 'identity edit') Object.assign((accepted.sim.rules as typeof surface.rules).start_countdown, { id: 'other' });
    const next = sealSimHash(accepted);
    if (kind === 'bad hash') next.simHash = 'wrong';
    expect(compareAcceptedBranch(prepared, next, { forkTick: 0, observationTick: 300 }).verdict).toBe('REJECTED');
    expect(prepared.controller.getSnapshot()).toEqual({ revision: 0, comparison: null });
  });

  it('refuses inputs added after preview and an active timer fork', () => {
    const { prepared, accepted, source } = setup();
    expect(compareAcceptedBranch(prepared, accepted, { forkTick: 22, observationTick: 300 })).toMatchObject({ verdict: 'REJECTED', reason: 'ACTIVE_TIMER' });
    source.dispatch(source.actions[0]);
    expect(compareAcceptedBranch(prepared, accepted, { forkTick: 0, observationTick: 300 })).toMatchObject({ verdict: 'REJECTED', reason: 'STALE_INPUTS' });
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
