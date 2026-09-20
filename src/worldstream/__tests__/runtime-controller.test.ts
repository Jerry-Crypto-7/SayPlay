import { describe, expect, it } from 'vitest';
import surface from '../../../evals/reality-compiler/museum.sim.json';
import oracle from '../../../evals/reality-compiler/oracle.json';
import { buildRuntimeWorld } from '@/ir/build';
import { sealSimHash, type WorldDoc } from '@/ir/worlddoc';
import { verifyWitness } from '@/verify/witness';
import type { WorldDocRuntime } from '@/sim/interpreter';
import vaultWorld from '@/sim/__fixtures__/vault.world.json';
import { bindRuntime, createRuntimeController } from '../runtime-controller';

const vault = vaultWorld as unknown as WorldDocRuntime;

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

describe('explain ring beside the timeline', () => {
  it('keeps what each fired rule wrote and names the rules that read it downstream', () => {
    const controller = createRuntimeController(vault);
    controller.advanceTicks(5);
    expect(controller.explainTick(2)).toEqual([{
      ruleId: 'r.pull', predicate: 'p.onAction.hero.pull.lever', guardHeld: true,
      writes: [{ slot: 'f:unlocked', before: 0, after: 1 }, { slot: 'c:keys', before: 0, after: 1 }],
    }]);
    expect(controller.explainTick(1)).toEqual([]);
    // `r.threshold` reads `keys` in its predicate; `r.open` reads only the signal pulse.
    expect(controller.downstreamOf(2)).toEqual([{ tick: 3, ruleId: 'r.threshold', reads: ['c:keys'] }]);
    expect(controller.downstreamOf(3)).toEqual([]);
    expect(controller.downstreamOf(2, 0)).toEqual([]);
  });

  it('records the lowered museum rules with the phase-3 values', () => {
    const controller = createRuntimeController(document());
    controller.advanceTicks(30);
    expect(controller.explainTick(20)).toEqual([{
      ruleId: 'start_countdown', predicate: 'p.onAction.visitor.activate.sensorA', guardHeld: true,
      writes: [{ slot: 'f:started', before: 0, after: 1 }, { slot: 't:countdown', before: 0, after: 400 }],
    }]);
    expect(controller.explainTick(21)[0]).toMatchObject({ ruleId: 'sys.moveTo.approachB', guardHeld: true });
    expect(controller.explainTick(21)[0].writes.map(write => write.slot)).toEqual(['e:visitor:moveTo', 'e:visitor:moveTicks']);
    // The move is settled in phase 4, so no rule "wrote" the visitor's position.
    expect(controller.downstreamOf(21)).toEqual([]);
  });

  it('holds the last 4000 ticks, drops the future on rewind and refills it on replay', () => {
    const controller = createRuntimeController(document());
    controller.advanceTicks(300);
    const unlock = controller.explainTick(260);
    expect(unlock).toMatchObject([{ ruleId: 'unlock_case', writes: [
      { slot: 'e:case:locked', before: 1, after: 0 }, { slot: 't:countdown', before: 160, after: 0 },
    ] }]);
    controller.observeAt(100);
    expect(controller.explainTick(260)).toEqual([]);
    expect(controller.explainTick(20)).toHaveLength(1);
    controller.observeAt(300);
    expect(controller.explainTick(260)).toEqual(unlock);
    controller.advanceTicks(4200);
    expect(controller.explainTick(260)).toEqual([]);
    expect(controller.explainTick(4499)).toEqual([]);
    expect(controller.explainTick(500)).toEqual([]);
  });
});

describe('downstream reads behind observed facts', () => {
  /** `r.jump` respawns the hero inside the zone at start; `r.enter` reacts to the zone fact one tick later. */
  const jumpWorld: WorldDocRuntime = {
    trace: [],
    space: { sockets: { s_start: [0, 0], s_far: [2, 3] }, zones: { far: [2, 3, 1, 1] }, blocked: [], tags: {} },
    ir: {
      irVersion: 'world-ir-v1',
      limits: { maxEntities: 2, maxZones: 1, maxSlots: 4, maxRules: 4, maxRuleFiringsPerTick: 4, maxQueueDepth: 2,
        maxAgents: 0, memorySlotsPerAgent: 0, gridWidth: 4, gridHeight: 4 },
      slots: [{ space: 'counter', id: 'visits', min: 0, max: 9, initial: 0 }],
      entities: [{ stableId: 'hero', role: 'actor', socket: 's_start', states: ['idle'], initialState: 'idle', initialLocked: false }],
      nodes: [
        { kind: 'ref', ref: { space: 'observed', fact: 'started', args: [] } },
        { kind: 'ref', ref: { space: 'observed', fact: 'inZone', args: ['hero', 'far'] } },
      ],
      predicates: [
        { predicateId: 'p.onStart', source: 'onStart', expr: 0 },
        { predicateId: 'p.onEnterZone.hero.far', source: 'onEnterZone', expr: 1 },
      ],
      effects: [
        { op: 'despawn', entity: 'hero' },
        { op: 'spawn', poolTag: 'hero', socket: 's_far', selection: 'lowest-inactive' },
        { op: 'addCounter', slot: 'visits', delta: 1 },
      ],
      rules: [
        { ruleId: 'r.jump', phase: 0, priority: 0, trigger: { kind: 'onEdge', predicate: 'p.onStart', became: true }, guard: null, effects: [0, 1] },
        { ruleId: 'r.enter', phase: 0, priority: 1, trigger: { kind: 'onEdge', predicate: 'p.onEnterZone.hero.far', became: true }, guard: null, effects: [2] },
      ],
    },
  };

  it('a zone fact reads the position and activity slots the spawn wrote', () => {
    const controller = createRuntimeController(jumpWorld);
    controller.advanceTicks(3);
    expect(controller.explainTick(1)).toEqual([{ ruleId: 'r.enter', predicate: 'p.onEnterZone.hero.far', guardHeld: true,
      writes: [{ slot: 'c:visits', before: 0, after: 1 }] }]);
    expect(controller.downstreamOf(0)).toEqual([{ tick: 1, ruleId: 'r.enter', reads: ['e:hero:active', 'e:hero:x', 'e:hero:y'] }]);
    // Only the written slots count: `visits` is read by nobody, so nothing follows tick 1.
    expect(controller.downstreamOf(1)).toEqual([]);
  });
});
