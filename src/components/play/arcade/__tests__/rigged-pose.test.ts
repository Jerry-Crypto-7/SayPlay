/**
 * Pohyb stavu, na který riggovaná postava klip nemá (P32C T2). Chybějící klip
 * zásahu vypadá jako klid – postava prostě stojí –, proto test drží, že se
 * procedurální pohyb opravdu přičte a po návratu do stavu s klipem zmizí.
 */

import { Group } from 'three';
import { describe, expect, it } from 'vitest';

import { proceduralPose } from '../RiggedModel';

describe('procedural pose of a rigged character without the clip (P32C T2)', () => {
  it('hit recoils and settles, die lays the character down', () => {
    const group = new Group();
    proceduralPose(group, 'hit', 0, 1.8);
    expect(group.rotation.x).toBeLessThan(-0.3);
    proceduralPose(group, 'hit', 0.5, 1.8);
    expect(group.rotation.x).toBeCloseTo(0);
    proceduralPose(group, 'die', 1, 1.8);
    expect(group.rotation.x).toBeCloseTo(-Math.PI / 2);
  });

  it('run bobs, jump stretches, a state with its own clip resets everything', () => {
    const group = new Group();
    proceduralPose(group, 'run', 0.1, 1.8);
    expect(group.position.y).toBeGreaterThan(0);
    proceduralPose(group, 'jump', 0, 1.8);
    expect(group.scale.y).toBeGreaterThan(1);
    proceduralPose(group, null, 0, 1.8);
    expect([group.position.y, group.rotation.x, group.scale.y]).toEqual([0, 0, 1]);
  });
});
