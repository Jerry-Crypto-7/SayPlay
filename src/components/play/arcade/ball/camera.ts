import type { PerspectiveCamera, Vector3 } from 'three';
/** Framing is in rendered metres, behind the player's actual shooting origin. */
export function placeBall(camera: PerspectiveCamera, look: Vector3): void {
  const phone = camera.aspect < 1;
  camera.position.set(phone ? -1 : -4, phone ? 10 : 8, phone ? -16 : -12);
  look.set(0, 2, 7);
  camera.lookAt(look);
}
