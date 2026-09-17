import { describe, expect, it } from 'vitest';
import { referenceBlueprint, REFERENCE_SCENES } from './scenes';
import { referenceCameraAt } from '../../../../src/worldstream/framing';
import { WORLDSTREAM_ASSETS } from '../../../../src/assets/catalog';
import { createField } from '../../../../src/shape/field';

describe('manual visual ceiling fixtures', () => {
  it('the custom aperture contains both its top and bottom within the sampled bounds', () => {
    const shape = REFERENCE_SCENES[2].shape!;
    const field = createField(shape, 4021);
    expect(field.at(0, 0.7, 0)).toBeLessThan(0);
    expect(field.at(0, 3.9, 0)).toBeLessThan(0);
    expect(field.at(0, 2.3, 0)).toBeGreaterThan(1);
    expect(shape.targetBounds.min[1]).toBeLessThan(0.38);
    expect(shape.targetBounds.max[1]).toBeGreaterThan(4.22);
  });
  it.each(REFERENCE_SCENES)('$id has resolvable assets with undeformed proportions', scene => {
    const blueprint = referenceBlueprint(scene);
    for (const object of blueprint.objects) {
      if (object.source.kind !== 'asset') continue;
      const resolved = WORLDSTREAM_ASSETS.resolve(object.source);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      const ratios = object.targetBounds.max.map((v, axis) => (v - object.targetBounds.min[axis]) /
        (resolved.asset.bounds.max[axis] - resolved.asset.bounds.min[axis]));
      expect(ratios[0]).toBeCloseTo(ratios[1], 6);
      expect(ratios[1]).toBeCloseTo(ratios[2], 6);
    }
    expect(referenceBlueprint(scene, true).objects.map(object => object.stableId)).toEqual(blueprint.objects.map(object => object.stableId));
  });
  it('camera is seekable, clamps endpoints, and does not mutate its path', () => {
    const points = REFERENCE_SCENES[0].cameras;
    const before = JSON.stringify(points);
    expect(referenceCameraAt(points, -1)).toEqual(points[0]);
    expect(referenceCameraAt(points, 22)).toEqual(points[3]);
    const midway = referenceCameraAt(points, 10);
    referenceCameraAt(points, 19);
    expect(referenceCameraAt(points, 10)).toEqual(midway);
    expect(JSON.stringify(points)).toBe(before);
    expect(() => referenceCameraAt(points, NaN)).toThrow();
  });
});
