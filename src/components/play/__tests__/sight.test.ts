/**
 * Výhled stráže (P25E T3): scéna kreslí úseky, které kompilátor zapsal, a
 * u hry bez plížení nic.
 */

import { describe, expect, it } from 'vitest';

import collectExit from '@/play/__fixtures__/collect_exit.json';
import collectExitStealth from '@/play/__fixtures__/collect_exit_stealth.json';
import { compileGame } from '@/play/compile';
import { readGameSpec } from '@/play/spec';

import { onBeat, readSight } from '../sight';

interface Sim {
  readonly layout: { readonly width: number; readonly height: number };
  readonly entities: Record<string, { readonly socket: string }>;
  readonly sockets: Record<string, readonly [number, number]>;
  readonly state: { readonly zones: Record<string, unknown> };
}

function simOf(fixture: unknown): Sim {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.reason);
  const compiled = compileGame(spec.value, 1);
  if (!compiled.ok || compiled.value.blueprint === null) throw new Error('fixture did not compile');
  return compiled.value.blueprint.world.sim as unknown as Sim;
}

describe('readSight', () => {
  it('reads every beat the stealth compiler wrote, with the grid it lies on', () => {
    const sim = simOf(collectExitStealth);
    const sight = readSight(sim);
    const written = Object.keys(sim.state.zones).filter((zone) => /_beat\d+$/.test(zone));
    expect(sight.beats.map((beat) => beat.zone).sort()).toEqual(written.sort());
    expect(sight.beats.length).toBeGreaterThan(0);
    expect(sight.grid).toEqual(sim.layout);
    for (const beat of sight.beats) {
      expect(sim.entities).toHaveProperty(beat.guard);
      expect(beat.rects.length).toBeGreaterThan(0);
    }
  });

  it('draws nothing for a game without stealth', () => {
    expect(readSight(simOf(collectExit)).beats).toEqual([]);
  });

  it('puts a guard standing on its start on the first beat', () => {
    const sim = simOf(collectExitStealth);
    const beat = readSight(sim).beats.find((entry) => entry.zone.endsWith('_beat0'));
    expect(beat).toBeDefined();
    const [x, y] = sim.sockets[sim.entities[beat!.guard]!.socket]!;
    expect(onBeat(beat!, x, y)).toBe(true);
    expect(onBeat(beat!, -1, -1)).toBe(false);
  });
});
