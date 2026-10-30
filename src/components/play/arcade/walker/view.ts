import { Box3, type PerspectiveCamera, type Vector3 } from 'three';
import { BODY, UNIT, bodyBase, type ArcadeState } from '@/play/arcade/contract';
import { walkerCell, type WalkerMap } from '@/play/arcade/pieces/walker';

import type { PlayRect } from '../portrait-frame';
import { fitChase } from '../track-camera';

/**
 * Bludiště na výšku (P64 T5): kamera vysoko nad hrdinou (`up`) a `back` m za ním, míří `ahead` m před něj. Do
 * `playRect` se vejde okolí hrdiny `half` m do stran, od `behind` m za ním po `depth` m před ním – chodba a strážný
 * v ní. Vzdálenost a posun dává `fitChase`. Šíře je na hraně: strážný o dvě buňky vedle (7,9 m) má zůstat v bezpečné
 * zóně `p58a-framing` a každý metr navíc kameru odsune a zmenší hrdinu (shora je to skoro jen jeho půdorys).
 */
export const WALKER_TALL = { up: 28, back: 8, ahead: 2, half: 7.2, behind: 4, depth: 12, top: 2 } as const;

const maze = new Box3();

/** Same rendered metre coordinates as World: x is mirrored, z is unchanged. */
export function placeWalker(camera: PerspectiveCamera, look: Vector3, x: number, z: number, rect: PlayRect | null = null): void {
  if (camera.aspect < 1) {
    const view = WALKER_TALL;
    camera.position.set(x, view.up, z - view.back);
    look.set(x, 0, z + view.ahead);
    camera.lookAt(look);
    maze.min.set(x - view.half, 0, z - view.behind);
    maze.max.set(x + view.half, view.top, z + view.depth);
    fitChase(camera, look, maze, rect);
    return;
  }
  camera.position.set(x, 20, z - 8);
  look.set(x, 0, z + 2);
  camera.lookAt(look);
}

/** Visualise only the real guard's forward 90° cone and stop rays at maze walls. */
export function walkerCone(state: ArcadeState, guard: number, map: WalkerMap, range: number): Float32Array {
  const base = bodyBase(guard), x = state[base + BODY.x]!, z = state[base + BODY.z]!;
  const vx = Math.sign(state[base + BODY.vx]!), vz = Math.sign(state[base + BODY.vz]!);
  if (vx === 0 && vz === 0) return new Float32Array();
  const facing = Math.atan2(vx, vz), open = new Set(map.open), edge: [number, number][] = [];
  const rays = 24;
  for (let ray = 0; ray <= rays; ray++) {
    const angle = facing - Math.PI / 4 + ray * Math.PI / 2 / rays;
    let reached = 0;
    for (let distance = 100; distance <= range; distance += 100) {
      const atX = x + Math.sin(angle) * distance, atZ = z + Math.cos(angle) * distance;
      if (atZ >= 0 && !open.has(walkerCell(map, atX, atZ))) break;
      reached = distance;
    }
    edge.push([-(x + Math.sin(angle) * reached) / UNIT, (z + Math.cos(angle) * reached) / UNIT]);
  }
  const positions: number[] = [];
  for (let ray = 0; ray < rays; ray++) positions.push(-x / UNIT, 0.045, z / UNIT, edge[ray]![0], 0.045, edge[ray]![1], edge[ray + 1]![0], 0.045, edge[ray + 1]![1]);
  return new Float32Array(positions);
}
