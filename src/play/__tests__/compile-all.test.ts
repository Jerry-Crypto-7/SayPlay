/**
 * Adaptéry carry, property_transform, spawn_wave a kompilace všech osmi
 * archetypů (P23-A, T7). Osm světů se postaví i s adaptérem, který tiše nic
 * nevydá – proto test drží počet adaptérů, certifikaci každého světa a u
 * každého nového adaptéru jeho vlastní kauzální krok.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { type Runtime, createRuntime, entityPlacements, entitySlotId, step } from '@/sim/interpreter';
import { readSlot } from '@/sim/state';
import { verifyWitness } from '@/verify/witness';

import { compileGame, compileSim, type SimCompilation, type SurfaceSim } from '../compile';
// P32B T2: mřížka archetypů staví jen remix uložených legacy her – mechaniky se zkouší přes ni.
import { legacyDraft } from './legacy-draft';
import { ADAPTERS } from '../compile/adapters';
import { TICKS_PER_SECOND } from '../compile/adapters/timer';
import { ARCHETYPE_IDS, MECHANIC_IDS } from '../registry';
import { verifyGame } from '../verify';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): GameSpecV1 {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8'));
  return spec(raw, name);
}

function spec(raw: unknown, name: string): GameSpecV1 {
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function compiled(spec: GameSpecV1, seed: number): SimCompilation {
  const result = compileSim(spec, seed);
  if (!result.ok) throw new Error(`${spec.title}/${seed}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function runtimeOf(sim: SurfaceSim): Runtime {
  const built = buildRuntimeWorld(sim);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return createRuntime(built.world);
}

function certified(sim: SurfaceSim): string {
  const built = buildRuntimeWorld(sim);
  if (!built.ok) return built.issues.join('; ');
  const verdict = verifyWitness(built.world, built.world.trace);
  return verdict.verdict === 'CERTIFIED' ? 'CERTIFIED' : `${verdict.reason}: ${verdict.detail}`;
}

/** Odkrokuje `ticks` tiků; vstupy jdou v tiku, který nesou. */
function run(runtime: Runtime, inputs: readonly { tick: number; actionId: string; target: string }[], ticks: number): string {
  for (let tick = 0; tick < ticks && runtime.runState === 'running'; tick += 1) {
    const due = inputs.filter((input) => input.tick === tick).map((input) => ({ ...input, actor: 'player' }));
    step(runtime, due);
  }
  return runtime.runState;
}

const placement = (runtime: Runtime, id: string) => entityPlacements(runtime).find((entity) => entity.stableId === id);
const slot = (runtime: Runtime, id: string): number => readSlot(runtime.layout, runtime.state, id);

/** Fixtura s mechanikou navíc; koření (`SPICE`) má každý archetyp povolené. */
function rawWithMechanic(base: string, mechanic: { id: string; params: Record<string, unknown> }): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(new URL(`${base}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8')) as Record<string, unknown>;
  return { ...raw, mechanics: [...(raw.mechanics as unknown[]), mechanic] };
}

function withMechanic(base: string, mechanic: { id: string; params: Record<string, unknown> }): GameSpecV1 {
  return spec(rawWithMechanic(base, mechanic), `${base}+${mechanic.id}`);
}

describe('compileSim – every archetype', () => {
  it('has a compile adapter for all 16 mechanics', () => {
    expect(MECHANIC_IDS).toHaveLength(16);
    expect(MECHANIC_IDS.filter((id) => ADAPTERS[id] === null)).toEqual([]);
  });

  it('compiles and certifies the eight fixtures over seeds 1..3', () => {
    const results: string[] = [];
    for (const archetype of ARCHETYPE_IDS) {
      const gameSpec = fixture(archetype);
      for (const seed of [1, 2, 3]) {
        const { sim } = compiled(gameSpec, seed);
        results.push(`${archetype}/${seed}: ${certified(sim)}`);
      }
    }
    expect(results).toHaveLength(24);
    const solved = results.filter((line) => line.endsWith('CERTIFIED'));
    // Pin naměřeného počtu (20. 9. 2026), ne dolní strop z AC (22).
    expect(solved.length, results.join('\n')).toBeGreaterThanOrEqual(24);
  });
});

describe('compileSim – delivery (carry)', () => {
  const gameSpec = fixture('delivery');

  it('certifies picking up the cake and walking it to the table', () => {
    for (const seed of [1, 2, 3]) {
      const { sim } = compiled(gameSpec, seed);
      expect(certified(sim), `seed ${seed}`).toBe('CERTIFIED');
      expect(sim.witness.ops.map((op) => `${op.actionId}:${op.target}`)).toEqual(['pickup:cake', 'moveTo:table']);
      expect(sim.state.slots).toBe(1);
    }
  });

  it('wins when the cake is picked up while already standing at the table', () => {
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf({ ...sim, sockets: { ...sim.sockets, spawn: sim.sockets.table as readonly [number, number] } });
    expect(run(runtime, [{ tick: 0, actionId: 'pickup', target: 'cake' }], 40)).toBe('won');
  });

  it('does not win at the table without the cake', () => {
    const { sim } = compiled(gameSpec, 1);
    // Bez číšníka: test je o doručení, dotyk hlídky na trase by ho prohrál jinak.
    const rules = Object.fromEntries(Object.entries(sim.rules).filter(([id]) => !id.startsWith('patrol.')));
    const runtime = runtimeOf({ ...sim, rules, state: { ...sim.state, agents: [] } });
    expect(run(runtime, [{ tick: 0, actionId: 'moveTo', target: 'table' }], 80)).toBe('running');
  });

  it('loses when the waiter touches a chef carrying the fragile cake', () => {
    const { sim } = compiled(gameSpec, 1);
    // Číšník stojí bez mysli krok před stolem (cesta jde po x, pak po y):
    // `onCollide` je hrana, takže dotyk vznikne až příchodem šéfkuchaře, a jen
    // nesený dort rozhodne, jestli to prohraje.
    const [sx, sy] = sim.sockets.spawn as readonly [number, number];
    const [tx, ty] = sim.sockets.table as readonly [number, number];
    const beforeTable: readonly [number, number] = ty !== sy ? [tx, ty - Math.sign(ty - sy)] : [tx - Math.sign(tx - sx), sy];
    const sockets = { ...sim.sockets, waiter: beforeTable };
    const state = { ...sim.state, agents: [] };
    const rules = Object.fromEntries(Object.entries(sim.rules).filter(([id]) => !id.startsWith('patrol.')));
    const walk = { tick: 1, actionId: 'moveTo', target: 'table' };
    const held = runtimeOf({ ...sim, sockets, state, rules });
    expect(run(held, [{ tick: 0, actionId: 'pickup', target: 'cake' }, walk], 80)).toBe('lost');
    const empty = runtimeOf({ ...sim, sockets, state, rules });
    expect(run(empty, [walk], 80)).toBe('running');
  });
});

describe('compileGame – waiting witness (R6)', () => {
  it('the fragile cake that lost to the waiter at tick 6 on seed 1964188670 now wins by waiting', () => {
    const result = compileGame(legacyDraft('Carry a fragile cake across a kitchen to a party table.'), 1964188670);
    expect(result.ok).toBe(true);
  });
});

describe('draft – enemies in collect_exit (P25B T2)', () => {
  const ghosts = 'A knight must collect three keys in a haunted castle while dodging ghosts.';

  it('keeps the dodged ghosts as a patrol whose touch loses, and the game still verifies', () => {
    const gameSpec = legacyDraft(ghosts);
    expect(gameSpec.archetype).toBe('collect_exit');
    expect(gameSpec.roles.find((role) => role.id === 'enemy')).toMatchObject({ kind: 'patrol', label: 'ghost', count: 2 });
    expect(gameSpec.tutorial.goalLine).toMatch(/Avoid the ghosts\.$/);
    for (const seed of [1, 2, 3]) {
      const result = compileGame(gameSpec, seed);
      if (!result.ok) throw new Error(`seed ${seed}: ${result.reason} ${result.issues.join('; ')}`);
      const report = verifyGame(result.value);
      expect(report.keypoints.filter((keypoint) => !keypoint.passed), `seed ${seed}`).toEqual([]);
      expect(report.publishEligible, `seed ${seed}`).toBe(true);
    }
  });

  it('turns a hunting enemy into a chaser, and a dodged hazard stays out of the roles', () => {
    const hunted = legacyDraft('Collect five coins while a goblin hunts you.');
    expect(hunted.roles.find((role) => role.id === 'enemy')).toMatchObject({ kind: 'chaser', label: 'goblin', count: 1 });
    expect(hunted.mechanics.map((mechanic) => mechanic.id)).toContain('chaser');
    expect(readGameSpec(hunted).ok).toBe(true);
    expect(legacyDraft('Collect five coins and avoid the lava.').roles.some((role) => role.id === 'enemy')).toBe(false);
  });
});

describe('patrol sight – stealth (P25B T3)', () => {
  const gameSpec = fixture('collect_exit_stealth');

  it('compiles the museum heist, certifies the witness and passes every keypoint on seeds 1..3', () => {
    for (const seed of [1, 2, 3]) {
      const result = compileGame(gameSpec, seed);
      if (!result.ok) throw new Error(`seed ${seed}: ${result.reason} ${result.issues.join('; ')}`);
      const report = verifyGame(result.value);
      expect(report.keypoints.filter((keypoint) => !keypoint.passed), `seed ${seed}`).toEqual([]);
      expect(report.publishEligible, `seed ${seed}`).toBe(true);
    }
  });

  it('loses by sight alone: stepping onto the stretch a guard walks, with the touch rules removed', () => {
    const { sim } = compiled(gameSpec, 1);
    const noTouch = Object.fromEntries(Object.entries(sim.rules).filter(([id]) => !id.endsWith('.touch')));
    const noSight = Object.fromEntries(Object.entries(noTouch).filter(([id]) => !/\.(spot|sees)\d+$|\.start$/.test(id) || !id.startsWith('patrol.')));
    // Hráč na startu stráže = na úseku 0, po kterém stráž hned vyrazí.
    const onGuard = { ...sim.sockets, spawn: sim.sockets.guard_1 as readonly [number, number] };
    expect(run(runtimeOf({ ...sim, sockets: onGuard, rules: noTouch }), [], 5)).toBe('lost');
    expect(run(runtimeOf({ ...sim, sockets: onGuard, rules: noSight }), [], 5)).toBe('running');
  });

  it('keeps every guard stretch off the witness route from spawn to the exit', () => {
    for (const seed of [1, 2, 3]) {
      const { sim } = compiled(gameSpec, seed);
      const [sx, sy] = sim.sockets.spawn as readonly [number, number];
      const beats = Object.entries(sim.state.zones).filter(([name]) => name.includes('_beat'));
      expect(beats.length, `seed ${seed}`).toBe(8);
      for (const [, rects] of beats) {
        for (const [x, y, w, h] of rects) expect(sx >= x && sx < x + w && sy >= y && sy < y + h, `seed ${seed}`).toBe(false);
      }
    }
  });

  it('drafts the P-labelled stealth sentences as collect games with seeing guards', () => {
    for (const sentence of [
      'sneak past guards in a museum and steal a diamond',
      'A kid sneaks down at night to steal cookies without waking mom',
      'stealth game as a ninja cat',
      'hide and seek in a big house',
      'prison escape, avoid the flashlights',
      'sneak into the teachers room to change my grades lol',
    ]) {
      const drafted = legacyDraft(sentence);
      expect(drafted.archetype, sentence).toBe('collect_exit');
      expect(drafted.mechanics.find((mechanic) => mechanic.id === 'patrol')?.params.sight, sentence).toBe(true);
    }
    const heist = legacyDraft('sneak past guards in a museum and steal a diamond');
    expect(heist.roles.find((role) => role.id === 'enemy')).toMatchObject({ label: 'guard', count: 2 });
    expect(heist.objective.count).toBe(1);
    expect(legacyDraft('A kid sneaks down at night to steal cookies without waking mom').roles.find((role) => role.id === 'enemy')?.label).toBe('mom');
    const result = compileGame(heist, 1);
    if (!result.ok) throw new Error(`${result.reason} ${result.issues.join('; ')}`);
    expect(verifyGame(result.value).publishEligible).toBe(true);
  });
});

describe('compileSim – property_transform', () => {
  it('flips the state on use once, from the declared state only', () => {
    const gameSpec = withMechanic('collect_exit', { id: 'property_transform', params: { role: 'portal', from: 'open', to: 'sealed', trigger: 'use' } });
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf(sim);
    expect(placement(runtime, 'portal')?.state).toBe('open');
    run(runtime, [{ tick: 0, actionId: 'use', target: 'portal' }], 2);
    expect(placement(runtime, 'portal')?.state).toBe('sealed');
    expect(Object.keys(sim.rules).filter((id) => id.startsWith('property_transform.'))).toEqual(['property_transform.portal']);
  });

  it('flips the state when the transform timer ends', () => {
    const gameSpec = withMechanic('collect_exit', { id: 'property_transform', params: { role: 'portal', from: 'open', to: 'sealed', trigger: 'timer' } });
    const { sim } = compiled(gameSpec, 1);
    const ticks = sim.state.timers.portal_transform?.durationTicks ?? 0;
    expect(ticks).toBeGreaterThan(0);
    const runtime = runtimeOf(sim);
    run(runtime, [], ticks);
    expect(placement(runtime, 'portal')?.state).toBe('open');
    run(runtime, [], 2);
    expect(placement(runtime, 'portal')?.state).toBe('sealed');
  });

  it('times the transform by afterSeconds, 10 s when omitted', () => {
    const params = { role: 'portal', from: 'open', to: 'sealed', trigger: 'timer' } as const;
    const ticksOf = (extra: object): number | undefined =>
      compiled(withMechanic('collect_exit', { id: 'property_transform', params: { ...params, ...extra } }), 1).sim.state.timers.portal_transform?.durationTicks;
    expect(ticksOf({})).toBe(10 * TICKS_PER_SECOND);
    expect(ticksOf({ afterSeconds: 3 })).toBe(3 * TICKS_PER_SECOND);
  });

  it('rejects a from state the role never reaches, accepts one another mechanic sets', () => {
    const dead = readGameSpec(rawWithMechanic('collect_exit', { id: 'property_transform', params: { role: 'portal', from: 'closed', to: 'sealed', trigger: 'use' } }));
    expect(dead.ok).toBe(false);
    if (!dead.ok) {
      expect(dead.reason).toBe('MECHANIC_REJECTED');
      expect(dead.issues.join('\n')).toContain('/params/from: role portal is never in state closed');
    }
    // Spínač začíná `off`, `on` mu nastaví mechanika `switch`.
    const setByAnother = rawWithMechanic('switch_puzzle', { id: 'property_transform', params: { role: 'red', from: 'on', to: 'jammed', trigger: 'use' } });
    expect(readGameSpec(setByAnother).ok).toBe(true);
  });

  it('flips the state on the named signal, or on <role>Triggered without a name', () => {
    const named = withMechanic('collect_exit', {
      id: 'property_transform',
      params: { role: 'portal', from: 'open', to: 'sealed', trigger: 'signal', signal: 'collectedFull' },
    });
    const { sim } = compiled(named, 1);
    expect(sim.rules['property_transform.portal']?.event).toEqual({ kind: 'onSignal', name: 'collectedFull' });
    const runtime = runtimeOf(sim);
    // Sběr všech pěti hub vyšle `collectedFull`; signál se doručí tik po vyslání.
    run(runtime, [1, 2, 3, 4, 5].map((k) => ({ tick: 0, actionId: 'pickup', target: `mushroom_${k}` })), 4);
    expect(placement(runtime, 'portal')?.state).toBe('sealed');

    const unnamed = withMechanic('collect_exit', { id: 'property_transform', params: { role: 'portal', from: 'open', to: 'sealed', trigger: 'signal' } });
    expect(compiled(unnamed, 1).sim.rules['property_transform.portal']?.event).toEqual({ kind: 'onSignal', name: 'portalTriggered' });
  });
});

describe('compileSim – spawn_wave', () => {
  const gameSpec = withMechanic('combat_lite', { id: 'spawn_wave', params: { role: 'slime', poolSize: 5, everySeconds: 3, maxAlive: 5 } });

  it('declares the pool, the arena and the wave timer', () => {
    const { sim } = compiled(gameSpec, 1);
    expect(sim.state.pool.slime).toEqual({ size: 5, tag: 'slime' });
    expect(sim.state.zones.slime_arena).toEqual([[0, 0, sim.layout.width, sim.layout.height]]);
    expect(sim.state.timers.slime_wave?.durationTicks).toBe(60);
    expect(certified(sim)).toBe('CERTIFIED');
  });

  it('revives a knocked-out slime at the nest on the next wave, but not above maxAlive', () => {
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf(sim);
    run(runtime, [], 61);
    expect(entityPlacements(runtime).filter((entity) => entity.stableId.startsWith('slime') && entity.active)).toHaveLength(5);
    run(runtime, [{ tick: 0, actionId: 'use', target: 'slime_1' }], 3);
    expect(placement(runtime, 'slime_1')?.active).toBe(false);
    run(runtime, [], 61);
    const revived = placement(runtime, 'slime_1');
    expect(revived?.active).toBe(true);
    expect([revived?.x, revived?.y]).toEqual(sim.sockets.slime_nest);
    expect(slot(runtime, entitySlotId('slime_1', 'active'))).toBe(1);
  });

  it('revives with a fresh combat state, so the second wave can be knocked out again', () => {
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf(sim);
    run(runtime, [{ tick: 0, actionId: 'use', target: 'slime_1' }], 3);
    expect(placement(runtime, 'slime_1')?.active).toBe(false);
    run(runtime, [], 62);
    expect(placement(runtime, 'slime_1')).toMatchObject({ active: true, state: 'alive' });
    run(runtime, [{ tick: 0, actionId: 'use', target: 'slime_1' }], 3);
    expect(placement(runtime, 'slime_1')?.active).toBe(false);
  });
});

describe('switch.ordered – order puzzle (P25B T4)', () => {
  const gameSpec = fixture('switch_puzzle_ordered');

  it('compiles the shelf puzzle, certifies the in-order witness and passes every keypoint on seeds 1..3', () => {
    for (const seed of [1, 2, 3]) {
      const result = compileGame(gameSpec, seed);
      if (!result.ok) throw new Error(`seed ${seed}: ${result.reason} ${result.issues.join('; ')}`);
      const report = verifyGame(result.value);
      expect(report.keypoints.map((keypoint) => [keypoint.assertionId, keypoint.passed]), `seed ${seed}`).toEqual([
        ['right_order_opens', true],
        ['wrong_order_resets', true],
        ['winnable', true],
      ]);
      expect(report.publishEligible, `seed ${seed}`).toBe(true);
    }
  });

  it('out of order resets the lit switches and keeps the door shut; in order opens it', () => {
    const { sim } = compiled(gameSpec, 1);
    const wrong = runtimeOf(sim);
    run(wrong, [
      { tick: 0, actionId: 'use', target: 'red' },
      { tick: 1, actionId: 'use', target: 'green' },
    ], 3);
    expect([placement(wrong, 'red')?.state, placement(wrong, 'green')?.state]).toEqual(['off', 'off']);
    const right = runtimeOf(sim);
    run(right, ['red', 'blue', 'green'].map((target, tick) => ({ tick, actionId: 'use', target })), 4);
    expect(placement(right, 'green')?.state).toBe('on');
  });

  it('drafts "in the right order" as an ordered switch puzzle, not a race (s080)', () => {
    const drafted = legacyDraft('a cat must knock things off shelves in the right order to reach the fish');
    expect(drafted.archetype).toBe('switch_puzzle');
    expect(drafted.mechanics.find((mechanic) => mechanic.id === 'switch')?.params.ordered).toBe(true);
    expect(drafted.verification.map((assertion) => assertion.id)).toContain('wrong_order_resets');
    expect(readGameSpec(drafted).ok).toBe(true);
    const result = compileGame(drafted, 1);
    if (!result.ok) throw new Error(`${result.reason} ${result.issues.join('; ')}`);
    expect(verifyGame(result.value).publishEligible).toBe(true);
    expect(legacyDraft('race through the gates in the right order').archetype).toBe('checkpoint_race');
  });
});

describe('switch.crateRole – pushed crates press the plates (P25B T4)', () => {
  const gameSpec = fixture('switch_puzzle_crates');

  it('compiles the warehouse, certifies the push witness and passes every keypoint on seeds 1..3', () => {
    for (const seed of [1, 2, 3]) {
      const result = compileGame(gameSpec, seed);
      if (!result.ok) throw new Error(`seed ${seed}: ${result.reason} ${result.issues.join('; ')}`);
      const report = verifyGame(result.value);
      expect(report.keypoints.filter((keypoint) => !keypoint.passed), `seed ${seed}`).toEqual([]);
      expect(report.publishEligible, `seed ${seed}`).toBe(true);
    }
  });

  it('a plate ignores being tapped; only a crate arriving on it turns it on', () => {
    const { sim } = compiled(gameSpec, 1);
    const tapped = runtimeOf(sim);
    run(tapped, [{ tick: 0, actionId: 'use', target: 'red' }], 3);
    expect(placement(tapped, 'red')?.state).toBe('off');
    const pushed = runtimeOf(sim);
    run(pushed, [0, 8, 16].map((tick) => ({ tick, actionId: 'use', target: 'box_1' })), 40);
    expect(placement(pushed, 'red')?.state).toBe('on');
    const box = placement(pushed, 'box_1');
    expect([box?.x, box?.y]).toEqual(sim.sockets.red);
  });

  it('drafts "push boxes onto switches" as crates on plates (s072)', () => {
    const drafted = legacyDraft('A lost robot must push boxes onto switches to open the door');
    expect(drafted.archetype).toBe('switch_puzzle');
    const params = drafted.mechanics.find((mechanic) => mechanic.id === 'switch')?.params;
    expect(params?.crateRole).toBe('box');
    expect(readGameSpec(drafted).ok).toBe(true);
    const result = compileGame(drafted, 1);
    if (!result.ok) throw new Error(`${result.reason} ${result.issues.join('; ')}`);
    expect(verifyGame(result.value).publishEligible).toBe(true);
  });
});

describe('carry.menu – customer orders (P25B T5)', () => {
  const gameSpec = fixture('delivery_orders');

  it('compiles the diner, certifies serving everyone and passes every keypoint on seeds 1..3', () => {
    for (const seed of [1, 2, 3]) {
      const result = compileGame(gameSpec, seed);
      if (!result.ok) throw new Error(`seed ${seed}: ${result.reason} ${result.issues.join('; ')}`);
      const report = verifyGame(result.value);
      expect(report.keypoints.map((keypoint) => [keypoint.assertionId, keypoint.passed, ...keypoint.failures]), `seed ${seed}`).toEqual([
        ['right_order_scores', true],
        ['wrong_order_ignored', true],
        ['winnable', true],
      ]);
      expect(report.publishEligible, `seed ${seed}`).toBe(true);
    }
  });

  it('serves each customer once, only with the dish they ordered, and wins when all are served', () => {
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf(sim);
    const inputs = [
      // Špatné jídlo nic, správné jednou, podruhé týž zákazník nic nechce.
      { tick: 0, actionId: 'pickup', target: 'fries' },
      { tick: 2, actionId: 'use', target: 'customer_1' },
      { tick: 4, actionId: 'pickup', target: 'burger' },
      { tick: 6, actionId: 'use', target: 'customer_1' },
      { tick: 8, actionId: 'pickup', target: 'burger' },
      { tick: 10, actionId: 'use', target: 'customer_1' },
    ];
    expect(run(runtime, inputs, 15)).toBe('running');
    expect([slot(runtime, 'c:orders_served'), slot(runtime, 'c:customer_1_served')]).toEqual([1, 1]);
    run(runtime, [
      { tick: 0, actionId: 'pickup', target: 'fries' },
      { tick: 2, actionId: 'use', target: 'customer_2' },
    ], 6);
    expect(runtime.runState).toBe('won');
  });

  it('drafts the P-labelled cooking sentences as order games (s160–s166)', () => {
    for (const sentence of [
      'cooking game where you make burgers fast for customers',
      'like overcooked but in a food truck',
      'run a sushi restaurant with a conveyor belt',
      'A barista rushes orders during the morning coffee rush',
      'make pizza and deliver it',
      'run a supermarket, stock shelves and scan items at the checkout',
      'farm game plant carrots harvest sell',
    ]) {
      const drafted = legacyDraft(sentence);
      expect(drafted.archetype, sentence).toBe('delivery');
      expect(drafted.mechanics.find((mechanic) => mechanic.id === 'carry')?.params.menu, sentence).toHaveLength(2);
      expect(readGameSpec(drafted).ok, sentence).toBe(true);
      const result = compileGame(drafted, 1);
      if (!result.ok) throw new Error(`${sentence}: ${result.reason} ${result.issues.join('; ')}`);
      expect(verifyGame(result.value).publishEligible, sentence).toBe(true);
    }
  });
});
