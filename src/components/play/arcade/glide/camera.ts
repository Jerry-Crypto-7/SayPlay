import type { PerspectiveCamera, Vector3 } from 'three';

/** World-render coordinates in metres, including the hero's actual altitude. */
export function placeGlide(camera: PerspectiveCamera, look: Vector3, x: number, y: number, z: number): void {
  const phone = camera.aspect < 1;
  camera.position.set(x * 0.8, y + (phone ? 4 : 3), z - (phone ? 12 : 10));
  look.set(x * 0.9, y + 0.5, z + (phone ? 9 : 12));
  camera.lookAt(look);
}
