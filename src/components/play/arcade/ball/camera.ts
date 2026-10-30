import { Box3, type PerspectiveCamera, type Vector3 } from 'three';

import type { PlayRect } from '../portrait-frame';
import { fitChase } from '../track-camera';

const DEG = Math.PI / 180;

/**
 * Míč na výšku (P64 T5): kamera nad hráčem a za ním ve strmém sklonu `pitch` (dřív 19°) míří na bod `look` m před
 * něj, takže brány 4–6 m před hráčem stoupnou po obrazovce nad něj. Do `playRect` se vejde hřiště od hráče po
 * brány: do stran `half` m (pět terčů po 1,4 m), od `behind` m za hráčem po `depth` m před ním, do výšky `top` m.
 * Vzdálenost a posun dává `fitChase`; `reach` (m od bodu pohledu) je zhruba vzdálenost po fitu, bez změřeného
 * obdélníku kamera zůstane tam.
 */
export const BALL_TALL = { pitch: 46 * DEG, reach: 21, side: -1, lookY: 2, look: 7, half: 3.6, behind: 0.6, depth: 5.5, top: 2.6 } as const;

const field = new Box3();

/** Framing is in rendered metres, behind the player's actual shooting origin. */
export function placeBall(camera: PerspectiveCamera, look: Vector3, rect: PlayRect | null = null): void {
  if (camera.aspect < 1) {
    const view = BALL_TALL;
    look.set(0, view.lookY, view.look);
    camera.position.set(view.side, view.lookY + view.reach * Math.sin(view.pitch), view.look - view.reach * Math.cos(view.pitch));
    camera.lookAt(look);
    field.min.set(-view.half, 0, -view.behind);
    field.max.set(view.half, view.top, view.depth);
    fitChase(camera, look, field, rect);
    return;
  }
  camera.position.set(-4, 8, -12);
  look.set(0, 2, 7);
  camera.lookAt(look);
}
