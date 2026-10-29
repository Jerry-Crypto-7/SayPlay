import { Box3, type PerspectiveCamera, type Vector3 } from 'three';

import type { PlayRect } from '../portrait-frame';
import { fitChase } from '../track-camera';

/**
 * Klouzání na výšku (P64 T5): kamera výš (`up`) a dál za kluzákem (`back`), míří `ahead` m před něj. Do `playRect`
 * se vejde let od kluzáku po `depth` m před ním, `half` m do stran a `rise` m nad i pod ním – další kruh i mince.
 * Vzdálenost a posun dává `fitChase`.
 */
export const GLIDE_TALL = { up: 4, back: 12, ahead: 9, half: 3, rise: 2, behind: 1, depth: 10 } as const;

const flight = new Box3();

/** World-render coordinates in metres, including the hero's actual altitude. */
export function placeGlide(camera: PerspectiveCamera, look: Vector3, x: number, y: number, z: number, rect: PlayRect | null = null): void {
  if (camera.aspect < 1) {
    const view = GLIDE_TALL;
    camera.position.set(x * 0.8, y + view.up, z - view.back);
    look.set(x * 0.9, y + 0.5, z + view.ahead);
    camera.lookAt(look);
    flight.min.set(x - view.half, y - view.rise, z - view.behind);
    flight.max.set(x + view.half, y + view.rise, z + view.depth);
    fitChase(camera, look, flight, rect);
    return;
  }
  camera.position.set(x * 0.8, y + 3, z - 10);
  look.set(x * 0.9, y + 0.5, z + 12);
  camera.lookAt(look);
}
