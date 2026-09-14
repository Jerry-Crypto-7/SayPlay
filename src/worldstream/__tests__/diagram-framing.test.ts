import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { applyDiagramProjection, frameDiagram } from '../diagram-framing';
import { FRAMING_FOV, type Bounds } from '../framing';

describe('diagram camera', () => {
  const cases: [string, Bounds, number, number][] = [
    ['wide museum', { min: { x: -3, y: 0, z: 0 }, max: { x: 17, y: 1.5, z: 12 } }, 1280, 720],
    ['portrait layout', { min: { x: 40, y: 0, z: -20 }, max: { x: 54, y: 3, z: -6 } }, 390, 844],
    ['tall layout', { min: { x: -1, y: -4, z: -2 }, max: { x: 1, y: 18, z: 2 } }, 1024, 768],
    ['point layout', { min: { x: 8, y: 3, z: 6 }, max: { x: 8, y: 3, z: 6 } }, 800, 600],
  ];
  it.each(cases)('keeps every corner of %s visible above bottom controls', (_name, bounds, width, height) => {
    const camera = new PerspectiveCamera(FRAMING_FOV, width / height, 0.1, 1000);
    const view = frameDiagram(bounds, width / height);
    camera.position.copy(view.eye);
    camera.lookAt(view.target);
    camera.updateMatrixWorld();
    applyDiagramProjection(camera, width, height, true);
    const center = view.target.clone().project(camera);
    expect((1 - center.y) / 2).toBeCloseTo(width < height ? 0.17 : 0.24, 8);
    expect(center.x).toBeCloseTo(0, 8);
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          const projected = new Vector3(x, y, z).project(camera);
          expect(Math.abs(projected.x)).toBeLessThanOrEqual(0.840001);
          const screenY = (1 - projected.y) / 2;
          expect(screenY).toBeGreaterThanOrEqual(0.039999);
          expect(screenY).toBeLessThanOrEqual(width < height ? 0.300001 : 0.440001);
          expect(projected.z).toBeGreaterThan(-1);
          expect(projected.z).toBeLessThan(1);
        }
  });

  it('resizing or restoring normal framing preserves a manually chosen camera pose', () => {
    const camera = new PerspectiveCamera(FRAMING_FOV, 16 / 9);
    camera.position.set(7, 11, -12);
    camera.lookAt(new Vector3(3, 2, -4));
    camera.zoom = 1.7;
    const position = camera.position.clone(), orientation = camera.quaternion.clone();
    applyDiagramProjection(camera, 1280, 720, true);
    applyDiagramProjection(camera, 390, 844, true);
    expect(camera.view?.offsetY).toBeCloseTo(844 * 0.33);
    expect(camera.aspect).toBeCloseTo(390 / 844);
    applyDiagramProjection(camera, 1024, 768, false);
    expect(camera.view?.enabled).toBe(false);
    expect(camera.position.equals(position)).toBe(true);
    expect(camera.quaternion.equals(orientation)).toBe(true);
    expect(camera.zoom).toBe(1.7);
    expect(camera.aspect).toBeCloseTo(1024 / 768);
  });
});
