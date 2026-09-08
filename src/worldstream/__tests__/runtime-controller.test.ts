import { describe, expect, it } from 'vitest';
import surface from '../../../evals/reality-compiler/museum.sim.json';
import oracle from '../../../evals/reality-compiler/oracle.json';
import { buildRuntimeWorld } from '@/ir/build';
import { sealSimHash, type WorldDoc } from '@/ir/worlddoc';
import { verifyWitness } from '@/verify/witness';
import { bindRuntime, createRuntimeController } from '../runtime-controller';

function document(terminal = false) {
  const sim = structuredClone(surface);
  const payload = terminal ? { ...sim, rules: { ...sim.rules, unlock_case: {
    ...sim.rules.unlock_case, actions: [...sim.rules.unlock_case.actions, { kind: 'win' }],
  } } } : sim;
  const built = buildRuntimeWorld(payload);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return { ...built.world, trace: oracle.cases[0].inputs };
}
function worldDoc(): WorldDoc {
  return sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim: surface,
    look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } });
}

describe('single runtime controller', () => {
  it('pauses without clearing timers, movement, input history or state', () => {
    const controller = createRuntimeController(document());
    controller.advanceTicks(21);
    const before = controller.getSnapshot();
    expect(before.values['t:countdown']).toBe(399);
    controller.setPaused(true);
    const paused = controller.getSnapshot();
    controller.advanceTicks(200);
    expect(controller.getSnapshot()).toBe(paused);
    controller.setPaused(false);
    controller.advanceTicks(240);
    expect(controller.getSnapshot().tick).toBe(261);
    expect(controller.getSnapshot().values['e:case:locked']).toBe(0);
    expect(controller.getSnapshot().entities.find(e => e.stableId === 'visitor')).toMatchObject({ x: 7, dx: 6 });
    expect(before.values['t:countdown']).toBe(399);
  });

  it('preserves win certification and reports a terminal snapshot at a later horizon', () => {
    const doc = document(true);
    expect(verifyWitness(doc, doc.trace).verdict).toBe('CERTIFIED');
    const controller = createRuntimeController(doc);
    controller.advanceTicks(300);
    expect(controller.getSnapshot()).toMatchObject({ observationTick: 300, tick: 261, endedAtTick: 261, runState: 'won' });
    const final = controller.getSnapshot().values;
    controller.advanceTicks(100);
    expect(controller.getSnapshot()).toMatchObject({ observationTick: 400, tick: 261, endedAtTick: 261 });
    expect(controller.getSnapshot().values).toEqual(final);
    controller.observeAt(20);
    expect(controller.getSnapshot()).toMatchObject({ observationTick: 20, tick: 20, endedAtTick: null, runState: 'running' });
    controller.observeAt(300);
    expect(controller.getSnapshot().values).toEqual(final);
  });

  it('replays from the anchor after the ring has wrapped', () => {
    const controller = createRuntimeController(document());
    controller.advanceTicks(900);
    const result = controller.getSnapshot().values;
    controller.observeAt(0);
    expect(controller.getSnapshot().values['e:case:locked']).toBe(1);
    controller.observeAt(900);
    expect(controller.getSnapshot().values).toEqual(result);
  });

  it('retains the controller and state across visual-only updates and new object references', () => {
    const doc = worldDoc();
    const first = bindRuntime(null, 'session-a', doc);
    first.controller.advanceTicks(42);
    first.controller.setPaused(true);
    const before = first.controller.getSnapshot();
    const next = bindRuntime(first, 'session-a', { ...structuredClone(doc), lookRevision: 1,
      look: { ...doc.look, palette: { color: 'red' } } });
    expect(next).toBe(first);
    expect(next.controller.getSnapshot()).toBe(before);
    expect(bindRuntime(next, 'session-b', doc).controller.getSnapshot().tick).toBe(0);
  });

  it('never automatically plays the certification witness on the interactive page', () => {
    const binding = bindRuntime(null, 'session', worldDoc());
    binding.controller.advanceTicks(300);
    expect(binding.controller.getSnapshot().values['e:case:locked']).toBe(1);
    expect(binding.controller.getSnapshot().values['t:countdown']).toBe(0);
  });

  it('rejects malformed replacements without touching the accepted state', () => {
    const first = bindRuntime(null, 'session', worldDoc());
    first.controller.advanceTicks(10);
    const before = first.controller.getSnapshot();
    expect(() => bindRuntime(first, 'session', { ...worldDoc(), sim: { ...surface, layout: {} } })).toThrow();
    expect(first.controller.getSnapshot()).toBe(before);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid tick %s atomically', tick => {
    const controller = createRuntimeController(document());
    const before = controller.getSnapshot();
    expect(() => controller.advanceTicks(tick)).toThrow();
    expect(() => controller.observeAt(tick)).toThrow();
    expect(controller.getSnapshot()).toBe(before);
  });

  it('publishes stable snapshots and removes subscriptions', () => {
    const controller = createRuntimeController(document());
    let calls = 0;
    const off = controller.subscribe(() => { calls += 1; });
    const before = controller.getSnapshot();
    controller.advanceTicks(0);
    expect(controller.getSnapshot()).toBe(before);
    controller.advanceTicks(1);
    expect(calls).toBe(1);
    off();
    controller.advanceTicks(1);
    expect(calls).toBe(1);
  });
});
