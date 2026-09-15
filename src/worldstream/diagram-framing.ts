import { PerspectiveCamera, Vector3 } from 'three';
import { FRAMING_FOV, type Bounds } from './framing';

/** Center the diagram above the bottom controls; retain margins on all sides. */
const HALF_WIDTH = 0.84;
/** Portrait controls occupy more height; diagrams get an explicit safe area. */
export function diagramArea(aspect: number) {
  return aspect < 1 ? { centerY: 0.17, halfHeight: 0.26 } : { centerY: 0.24, halfHeight: 0.4 };
}

/** Fit every corner of the whole layout, including its depth in perspective. */
export function frameDiagram(bounds: Bounds, aspect: number, fov = FRAMING_FOV) {
  const target = new Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2,
  );
  const direction = new Vector3(1, 1.15, 1.25).normalize();
  const right = new Vector3().crossVectors(new Vector3(0, 1, 0), direction).normalize();
  const up = new Vector3().crossVectors(direction, right);
  const tangent = Math.tan(fov * Math.PI / 360);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const { halfHeight } = diagramArea(safeAspect);
  let distance = 1;
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const relative = new Vector3(x, y, z).sub(target);
        const depth = relative.dot(direction);
        distance = Math.max(distance,
          depth + Math.abs(relative.dot(right)) / (tangent * safeAspect * HALF_WIDTH),
          depth + Math.abs(relative.dot(up)) / (tangent * halfHeight));
      }
  return { target, eye: direction.multiplyScalar(distance).add(target) };
}

/** Resize changes only projection, preserving the user's orbit, zoom and pan. */
export function applyDiagramProjection(camera: PerspectiveCamera, width: number, height: number, diagram: boolean) {
  if (width <= 0 || height <= 0) return;
  if (diagram) camera.setViewOffset(width, height, 0, height * (0.5 - diagramArea(width / height).centerY), width, height);
  else {
    camera.clearViewOffset();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}
