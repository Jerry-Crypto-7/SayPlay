/**
 * Adaptéry timer, hazard_zone, health, counter nad `survival_timer` (P23-A, T4).
 *
 * Pulz s prohozenými fázemi vypadá stejně – proto test drží `on` = prohra,
 * `off` = běží, a navíc hráče, který v zapnutém nebezpečí už stojí.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { type Runtime, createRuntime, step } from '@/sim/interpreter';
import { readSlot } from '@/sim/state';
import { verifyWitness } from '@/verify/witness';

import { compileSim, type SimCompilation, type SurfaceSim } from '../compile';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): GameSpecV1 {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8'));
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

/** Odkrokuje `ticks` tiků; vstupy jdou v tiku, který nesou. */
function run(runtime: Runtime, inputs: readonly { tick: number; actionId: string; target: string }[], ticks: number): string {
  for (let tick = 0; tick < ticks && runtime.runState === 'running'; tick += 1) {
    const due = inputs.filter((input) => input.tick === tick).map((input) => ({ ...input, actor: 'player' }));
    step(runtime, due);
  }
  return runtime.runState;
}

const spec = fixture('survival_timer');

describe('compileSim – survival_timer', () => {
  it('builds, declares the clock and certifies surviving at spawn', () => {
    const { sim } = compiled(spec, 1);
    expect(sim.state.timers.clock).toEqual({ durationTicks: 1200, init: 1200 });
    const built = buildRuntimeWorld(sim);
    expect(built.ok, built.ok ? '' : built.issues.join('; ')).toBe(true);
    if (!built.ok) return;
    const verdict = verifyWitness(built.world, built.world.trace);
    expect(verdict.verdict, verdict.verdict === 'REJECTED' ? verdict.detail : '').toBe('CERTIFIED');
    if (verdict.verdict === 'CERTIFIED') expect(verdict.witnessLength).toBeGreaterThanOrEqual(1200);
  });

  it('loses when the player walks into a tile while it is on, keeps running while it is off', () => {
    const { sim } = compiled(spec, 2);
    // Pulz: 3 s zapnuto (60 tiků), 5 s vypnuto (100 tiků). Vstup v tiku 0 dojde nejpozději do 40 tiků.
    expect(run(runtimeOf(sim), [{ tick: 0, actionId: 'moveTo', target: 'tile_1' }], 58)).toBe('lost');
    const off = runtimeOf(sim);
    expect(run(off, [{ tick: 70, actionId: 'moveTo', target: 'tile_1' }], 155)).toBe('running');
    // …a v tiku 160 se dlaždice zapne pod stojícím hráčem.
    expect(run(off, [], 30)).toBe('lost');
  });

  it('loses at once when the run starts with the player inside an active tile', () => {
    const { sim } = compiled(spec, 3);
    const placed: SurfaceSim = { ...sim, sockets: { ...sim.sockets, spawn: sim.sockets.tile_2 } };
    expect(run(runtimeOf(placed), [], 5)).toBe('lost');
  });

  it('health declares an upward damage counter that loses at max', () => {
    const withHealth: GameSpecV1 = {
      ...spec,
      mechanics: [
        spec.mechanics[0],
        { id: 'hazard_zone', params: { role: 'tile', effect: 'damage', pulse: { onSeconds: 3, offSeconds: 5 } } },
        { id: 'health', params: { max: 5 } },
        { id: 'counter', params: { id: 'style', min: 0, max: 9, initial: 3 } },
      ],
    };
    const { sim, mechanics } = compiled(withHealth, 1);
    expect(sim.state.counters.damage).toEqual({ min: 0, max: 5, init: 0 });
    expect(sim.state.counters.style).toEqual({ min: 0, max: 9, init: 3 });
    expect(mechanics.find((m) => m.mechanicId === 'health')?.slotIds).toContain('c:damage');

    // Vstup do zapnuté dlaždice zraní (cestou může zranit i jiná), stání v ní
    // zraní při každém dalším zapnutí (tiky 160, 320, …) – pátý zásah prohraje.
    const runtime = runtimeOf(sim);
    expect(run(runtime, [{ tick: 0, actionId: 'moveTo', target: 'tile_1' }], 100)).toBe('running');
    const damage = readSlot(runtime.layout, runtime.state, 'c:damage');
    expect(damage).toBeGreaterThanOrEqual(1);
    expect(damage).toBeLessThan(5);
    expect(run(runtime, [], 700)).toBe('lost');
  });
});
