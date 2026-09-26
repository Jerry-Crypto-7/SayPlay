/**
 * Zkušební scéna determinismu Rapieru (P29A, T11): 20 těles – věž, padající
 * bedny a klouzající koule, které do věže narazí. Tutéž scénu počítá Node
 * (`__tests__/determinism.test.ts`) i Chromium (`/play/lab/physics`); jejich
 * hash se musí rovnat hodnotě zapsané v `__fixtures__/determinism.json`.
 */

import { hashHex, hashWords } from '@/sim/hash';

import { GRAVITY } from '../kernel';
import { PHYSICS_STRIDE, type PhysicsBodyInit, PhysicsWorld, type Rapier } from './world';

export const SCENE_TICKS = 600;

export function determinismBodies(): PhysicsBodyInit[] {
  const bodies: PhysicsBodyInit[] = [];
  // Věž z 8 kostek po 0,5 m, každá o kousek posunutá, ať není dokonale svislá.
  for (let k = 0; k < 8; k += 1) bodies.push({ x: (k % 2) * 40, y: k * 500, z: 4000, w: 500, h: 500, d: 500 });
  // 6 beden padá z výšky vedle sebe a přes sebe.
  for (let k = 0; k < 6; k += 1) bodies.push({ x: -1500 + k * 450, y: 3000 + k * 700, z: 1000 + (k % 3) * 300, w: 400, h: 400, d: 400, restitution: 200 });
  // 6 koulí se kutálí proti věži.
  for (let k = 0; k < 6; k += 1) bodies.push({ x: -1500 + k * 600, y: 0, z: -2000 - k * 300, w: 350, h: 350, d: 350, shape: 'ball', vz: 90 + k * 10, restitution: 400 });
  return bodies;
}

/** Hash kvantovaného stavu po každém tiku, složený do jednoho (průběh, ne jen konec). */
export function runScene(rapier: Rapier, ticks: number = SCENE_TICKS): { readonly hash: string; readonly final: readonly number[] } {
  const world = new PhysicsWorld(rapier, determinismBodies(), GRAVITY);
  const frame = new Int32Array(world.size * PHYSICS_STRIDE);
  const running = new Uint32Array(ticks);
  for (let tick = 0; tick < ticks; tick += 1) {
    world.step();
    world.quantize(frame);
    running[tick] = hashWords(new Uint32Array(frame.buffer));
  }
  world.free();
  return { hash: hashHex(running), final: Array.from(frame) };
}
