import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import oracle from '../../../evals/reality-compiler/oracle.json';
import surface from '../../../evals/reality-compiler/museum.sim.json';
import { buildRuntimeWorld } from '../../ir/build';
import { verifyWitness } from '../../verify/witness';
import { hashHex } from '../hash';
import { createRuntime, step, type Runtime, type TraceInput, type WorldDocRuntime } from '../interpreter';
import { rebranchAt } from '../rebranch';
import { readSlot } from '../state';
import { advance, createTimeline, seekTo } from '../timeline';

// Expectations are authored from the source, separately from the executable
// surface document. Neither the compiler nor a model produces the oracle.
function document(inputs: readonly TraceInput[], duration = oracle.baselineLimitTicks, terminal = false): WorldDocRuntime {
  const sim = structuredClone(surface);
  sim.rules.start_countdown.actions[1].durationTicks = duration;
  const payload = terminal ? {
    ...sim,
    rules: {
      ...sim.rules,
      unlock_case: { ...sim.rules.unlock_case, actions: [...sim.rules.unlock_case.actions, { kind: 'win' }] },
    },
  } : sim;
  const built = buildRuntimeWorld(payload);
  if (!built.ok) throw new Error(`${built.reason}: ${built.issues.join('; ')}`);
  return { ...built.world, trace: inputs };
}

function outcome(runtime: Runtime) {
  return {
    caseUnlocked: readSlot(runtime.layout, runtime.state, 'e:case:locked') === 0,
    alarm: readSlot(runtime.layout, runtime.state, 'f:alarm') === 1,
  };
}

function runTo(runtime: Runtime, snapshotTick: number) {
  const fired: { tick: number; ruleId: string }[] = [];
  while (runtime.tick < snapshotTick && runtime.runState === 'running') {
    const inputTick = runtime.tick;
    const result = step(runtime, runtime.doc.trace.filter((input) => input.tick === inputTick));
    fired.push(...result.fired.map((ruleId) => ({ tick: inputTick, ruleId })));
  }
  expect(runtime.runState).toBe('running');
  expect(runtime.tick).toBe(snapshotTick);
  return fired;
}

describe('museum: independent source-derived expectations through the existing lowering', () => {
  it.each(oracle.cases)('$id', ({ inputs, snapshotTick, expected }) => {
    const runtime = createRuntime(document(inputs));
    runTo(runtime, snapshotTick);
    expect(outcome(runtime)).toEqual(expected);
  });

  it('pins input-tick versus snapshot-tick and the exact expiration event', () => {
    const runtime = createRuntime(document([{ tick: 20, actor: 'visitor', actionId: 'activate', target: 'sensorA' }]));
    runTo(runtime, 20);
    expect(readSlot(runtime.layout, runtime.state, 't:countdown')).toBe(0);
    runTo(runtime, 21);
    expect(readSlot(runtime.layout, runtime.state, 't:countdown')).toBe(399);
    runTo(runtime, 420);
    expect(outcome(runtime).alarm).toBe(false);
    expect(readSlot(runtime.layout, runtime.state, 't:countdown')).toBe(0);
    expect(runTo(runtime, 421)).toContainEqual({ tick: 420, ruleId: 'expire_countdown' });
    expect(outcome(runtime).alarm).toBe(true);
  });

  it('requires real movement before sensor B can activate', () => {
    const runtime = createRuntime(document(oracle.cases[0].inputs));
    runTo(runtime, 21);
    expect(readSlot(runtime.layout, runtime.state, 'e:visitor:x')).toBe(1);
    runTo(runtime, 260);
    expect(readSlot(runtime.layout, runtime.state, 'e:visitor:x')).toBe(7);
    expect(outcome(runtime).caseUnlocked).toBe(false);
    expect(runTo(runtime, 261)).toContainEqual({ tick: 260, ruleId: 'unlock_case' });
    expect(outcome(runtime).caseUnlocked).toBe(true);
  });

  it('a blocked runtime path cannot be bypassed by a remote activate input', () => {
    // The current surface builder does not lower walls. This probes the
    // existing runtime contract, not a claim about generated collision meshes.
    const doc = document(oracle.cases[0].inputs);
    const runtime = createRuntime({ ...doc, space: { ...doc.space, blocked: [[4, 1]] } });
    const fired = runTo(runtime, 421);
    expect(readSlot(runtime.layout, runtime.state, 'e:visitor:x')).toBe(3);
    expect(fired.some((entry) => entry.ruleId === 'unlock_case')).toBe(false);
    expect(outcome(runtime)).toEqual({ caseUnlocked: false, alarm: true });
  });

  it('the oracle detects a weakened deadline guard', () => {
    const boundary = oracle.cases.find((entry) => entry.id === 'exact_deadline')!;
    const doc = document(boundary.inputs);
    let mutations = 0;
    const mutant: WorldDocRuntime = {
      ...doc,
      ir: {
        ...doc.ir,
        nodes: doc.ir.nodes.map((node) => {
          if (node.kind !== 'compare' || node.op !== '>') return node;
          const lhs = doc.ir.nodes[node.lhs];
          if (lhs.kind !== 'ref' || lhs.ref.space !== 'timer' || lhs.ref.slot !== 'countdown') return node;
          mutations += 1;
          return { ...node, op: '>=' };
        }),
      },
    };
    expect(mutations).toBe(1);
    const runtime = createRuntime(mutant);
    runTo(runtime, boundary.snapshotTick);
    expect(outcome(runtime)).not.toEqual(boundary.expected);
  });

  it('the oracle detects a removed proximity guard', () => {
    const remote = oracle.cases.find((entry) => entry.id === 'remote_B_ignored')!;
    const doc = document(remote.inputs);
    const mutant: WorldDocRuntime = {
      ...doc,
      ir: { ...doc.ir, rules: doc.ir.rules.map((rule) => rule.ruleId === 'unlock_case' ? { ...rule, guard: null } : rule) },
    };
    const runtime = createRuntime(mutant);
    runTo(runtime, remote.snapshotTick);
    expect(outcome(runtime)).not.toEqual(remote.expected);
  });
});

describe('museum: a rule intervention preserves the original branch', () => {
  it('compares the same input log at the same snapshot after a 20-to-10-second intervention', () => {
    const inputs = oracle.cases[0].inputs;
    const originalDoc = document(inputs);
    const original = createRuntime(originalDoc);
    runTo(original, oracle.compareTick);
    const originalHash = hashHex(original.state);

    // rebranchAt mutates its input runtime on success, so never hand it the
    // runtime still displayed as the original branch.
    const candidate = createRuntime(originalDoc);
    const timeline = createTimeline(candidate, 32);
    while (candidate.tick < oracle.compareTick) {
      advance(timeline, candidate, inputs.filter((input) => input.tick === candidate.tick));
    }
    const branched = rebranchAt(timeline, candidate, 0, document(inputs, oracle.changedLimitTicks));
    expect(branched.verdict).toBe('REBRANCHED');
    if (branched.verdict !== 'REBRANCHED') throw new Error(branched.detail);
    expect(branched.runtime.state).toEqual(createRuntime(originalDoc).state);
    expect(branched.runtime.doc.trace).toEqual(original.doc.trace);
    expect(branched.runtime.layout).toEqual(original.layout);
    runTo(branched.runtime, oracle.compareTick);
    expect(outcome(original)).toEqual(oracle.cases[0].expected);
    expect(outcome(branched.runtime)).toEqual(oracle.changedExpected);
    expect(original.tick).toBe(branched.runtime.tick);
    expect(hashHex(original.state)).toBe(originalHash);

    // Replay must work beyond the ring: the source of external inputs is the
    // immutable log, not a retained snapshot or the already computed outcome.
    expect(seekTo(branched.timeline, branched.runtime, 0)).toBe(0);
    expect(seekTo(branched.timeline, branched.runtime, oracle.compareTick)).toBe(oracle.compareTick);
    expect(outcome(branched.runtime)).toEqual(oracle.changedExpected);
  });

  it('rejects changing timer capacity without rewinding the accepted runtime', () => {
    const original = createRuntime(document(oracle.cases[0].inputs));
    const timeline = createTimeline(original, 32);
    runTo(original, oracle.compareTick);
    const before = hashHex(original.state);
    const changed = structuredClone(surface);
    changed.state.timers.countdown.durationTicks = 200;
    changed.rules.start_countdown.actions[1].durationTicks = 200;
    const built = buildRuntimeWorld(changed);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const rejected = rebranchAt(timeline, original, 0, built.world);
    expect(rejected.verdict).toBe('REJECTED');
    if (rejected.verdict === 'REJECTED') expect(rejected.reason).toBe('SHAPE_CHANGED');
    expect(original.tick).toBe(oracle.compareTick);
    expect(hashHex(original.state)).toBe(before);
  });

  it('keeps the source snapshot pinned independently of executable rules', () => {
    const source = readFileSync('evals/reality-compiler/museum-source.txt');
    expect(createHash('sha256').update(source).digest('hex')).toBe(oracle.sourceSha256);
  });

  it('distinguishes a continuing observation scenario from a certified terminal game', () => {
    const inputs = oracle.cases[0].inputs;
    const observation = verifyWitness(document(inputs), inputs);
    expect(observation.verdict).toBe('REJECTED');
    if (observation.verdict === 'REJECTED') expect(observation.reason).toBe('NO_WIN');

    const game = document(inputs, oracle.baselineLimitTicks, true);
    const certificate = verifyWitness(game, inputs);
    expect(certificate.verdict).toBe('CERTIFIED');
    if (certificate.verdict === 'CERTIFIED') expect(certificate.witnessLength).toBe(261);

    const changed = verifyWitness(document(inputs, oracle.changedLimitTicks, true), inputs);
    expect(changed.verdict).toBe('REJECTED');
    if (changed.verdict === 'REJECTED') expect(changed.reason).toBe('NO_WIN');

    // A terminal branch does not advance its engine clock to the comparison
    // horizon. A future controller must report observation time separately.
    const runtime = createRuntime(game);
    const timeline = createTimeline(runtime, 32);
    expect(seekTo(timeline, runtime, oracle.compareTick)).toBe(261);
    expect(runtime.runState).toBe('won');
    expect(outcome(runtime)).toEqual(oracle.cases[0].expected);
  });
});
