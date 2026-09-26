/**
 * Rapier je deterministický (P29A T11): dva běhy téže scény (600 tiků, 20
 * těles) dají týž hash kvantovaných pozic a tentýž hash, jaký zapsal Node do
 * fixtury – s ní se porovná i Chromium (`e2e/play-physics-determinism.spec.ts`).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PHYSICS_STRIDE, loadRapier } from '../world';
import { SCENE_TICKS, determinismBodies, runScene } from '../scene';

const fixture = JSON.parse(readFileSync(new URL('../__fixtures__/determinism.json', import.meta.url), 'utf8')) as { hash: string; ticks: number; bodies: number };

describe('Rapier determinism', () => {
  it('two runs of the scene give the same quantized hash, equal to the Node fixture', async () => {
    const started = performance.now();
    const rapier = await loadRapier();
    const initMs = performance.now() - started;
    const first = runScene(rapier);
    const second = runScene(rapier);
    expect(second.hash).toBe(first.hash);
    expect(second.final).toEqual(first.final);
    expect(fixture).toEqual({ hash: first.hash, ticks: SCENE_TICKS, bodies: determinismBodies().length });
    expect(determinismBodies()).toHaveLength(20);
    // Čas init() jde do `evals/play/rules/rapier.md`; tady jen strop, ať se nenačítá minutu.
    expect(initMs).toBeLessThan(5000);
  });

  it('the scene actually moves: the balls roll, the crates land and something topples', async () => {
    const rapier = await loadRapier();
    const { final } = runScene(rapier);
    const bodies = determinismBodies();
    const at = (i: number, slot: number): number => final[i * PHYSICS_STRIDE + slot] as number;
    // Bedny (8..13) dopadly na zem nebo na sebe – nevisí ve výšce, kde začaly.
    for (let i = 8; i < 14; i += 1) expect(at(i, 1)).toBeLessThan(bodies[i]!.y);
    // Koule (14..19) ujely aspoň metr po +z.
    for (let i = 14; i < 20; i += 1) expect(at(i, 2) - bodies[i]!.z).toBeGreaterThan(1000);
    // Aspoň jedno těleso se otočilo (qw ≠ 10000) – rotace je v hashi taky.
    expect(Array.from({ length: 20 }, (_, i) => at(i, 9)).some((qw) => Math.abs(qw) < 9990)).toBe(true);
  });

  it('a different scene gives a different hash (the hash measures the state)', async () => {
    const rapier = await loadRapier();
    expect(runScene(rapier, SCENE_TICKS - 1).hash).not.toBe(runScene(rapier).hash);
  });
});
