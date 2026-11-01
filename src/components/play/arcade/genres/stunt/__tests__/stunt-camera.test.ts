/**
 * Kamera závodu s triky (P68V T4, `stunt-camera.ts`). Test level pin: kamera, která na výšku nechá trať nad horním
 * pásem HUD nebo auto pod tlačítkem brzdy, vypadá na desktopu dobře – tady se auto a 30 m trati před ním promítnou
 * kamerou z pózy a musí ležet v hracím obdélníku telefonu 412 × 839 na celé trati, na zemi i ve vzduchu.
 */

import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { type ArcadeState, BODY, HEADER, UNIT, type ArcadeWorld, bodyBase, setGrace } from '@/play/arcade/contract';
import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { LEGIBLE_CAP, LEGIBLE_SHARE } from '@/play/arcade/models';
import { STUNT, stuntTrack } from '@/play/arcade/pieces/stunt';

import { stripCurve } from '../../../look/road-strip';
import { type PlayRect, playRect } from '../../../portrait-frame';
import { roadShapeOf } from '../../../steer/road-shape';
import { STUNT_CAMERA, type StuntCameraPose, stuntCameraPose } from '../stunt-camera';

/** Pixel 7 na výšku: horní pás HUD (pilulky a řádek cíle) a dolní pás (řada HUD a tlačítko brzdy nad ní). */
const PHONE = { width: 412, height: 839 } as const;
const RECT: PlayRect = playRect(PHONE, 110, 680);
const TALL = PHONE.width / PHONE.height;
const WIDE = 16 / 9;
/**
 * Pixel 7 na šířku (snímky e2e T5, 1. 11. 2026): spodní hrana řádku cíle 120 px, horní hrana kola brzdy `.play-fire`
 * 256 px – brzda je v `PLAY_FLOOR`, takže `usePlayRect` dá dolní pás tam, ne až u dolní řady HUD (337 px).
 */
const LANDSCAPE_PHONE = { width: 839, height: 412 } as const;
const LANDSCAPE = LANDSCAPE_PHONE.width / LANDSCAPE_PHONE.height;
const WIDE_RECT: PlayRect = playRect(LANDSCAPE_PHONE, 120, 256);
/** Tolerance průmětu (NDC): fit drží 8 px okraj, tohle je jen zaokrouhlení. */
const EPS = 1e-3;

function trackWorld(seed: number, difficulty: 'easy' | 'normal' | 'hard' = 'normal'): { readonly world: ArcadeWorld; readonly state: ArcadeState; readonly road: (z: number) => { readonly center: number; readonly width: number } } {
  const parts = stuntTrack.parts(seed, stuntTrack.params.parse({ difficulty }), undefined);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return { world: built.world, state: instantiate(built.world), road: stripCurve(roadShapeOf(built.world).segments) };
}

/** Kopie stavu s autem ve scéně v `x` (m, zrcadlené jako scéna), výšce `y` a `z`. */
function carAt(state: ArcadeState, x: number, y: number, z: number): ArcadeState {
  const copy = state.slice();
  const p = bodyBase(copy[HEADER.player] as number);
  copy[p + BODY.x] = Math.round(-x * UNIT);
  copy[p + BODY.y] = Math.round(y * UNIT);
  copy[p + BODY.z] = Math.round(z * UNIT);
  return copy;
}

function cameraOf(pose: StuntCameraPose, aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(STUNT_CAMERA.fov, aspect, 0.1, 1000);
  camera.position.copy(pose.position);
  camera.lookAt(pose.look);
  camera.updateMatrixWorld();
  return camera;
}

/** Rohy kvádru auta ve scéně (m) – jak ho kreslí scéna, ze stavu. */
function carCorners(state: ArcadeState): Vector3[] {
  const p = bodyBase(state[HEADER.player] as number);
  const v = (slot: number): number => (state[p + slot] as number) / UNIT;
  const box = new Box3(new Vector3(-v(BODY.x) - v(BODY.w) / 2, v(BODY.y), v(BODY.z) - v(BODY.d) / 2), new Vector3(-v(BODY.x) + v(BODY.w) / 2, v(BODY.y) + v(BODY.h), v(BODY.z) + v(BODY.d) / 2));
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
}

/** Stín auta: jeho půdorys na zemi (y 0) – ve skoku leží pod autem, kde ho dřív dolní pás schoval. */
function shadowCorners(state: ArcadeState): Vector3[] {
  return carCorners(state)
    .filter((_, i) => (i & 2) === 0)
    .map((corner) => new Vector3(corner.x, 0, corner.z));
}

/** Osa trati od auta po 30 m před ním, po metru. */
function trackAhead(road: (z: number) => { readonly center: number }, z: number): Vector3[] {
  return Array.from({ length: 31 }, (_, m) => new Vector3(road(z + m).center, 0, z + m));
}

function outside(camera: PerspectiveCamera, points: readonly Vector3[], rect: PlayRect): string[] {
  return points.flatMap((point) => {
    const ndc = point.clone().project(camera);
    const inside = ndc.z < 1 && Math.abs(ndc.x) <= 1 + EPS && ndc.y <= rect.ndc.top + EPS && ndc.y >= rect.ndc.bottom - EPS;
    return inside ? [] : [`(${point.x.toFixed(1)}, ${point.y.toFixed(1)}, ${point.z.toFixed(1)}) → ndc (${ndc.x.toFixed(2)}, ${ndc.y.toFixed(2)})`];
  });
}

describe('stunt chase camera (stuntCameraPose)', () => {
  it('on a 412 × 839 phone keeps the car and 30 m of track ahead inside the play rect, on the ground and in the air, along the whole track', () => {
    for (const [seed, difficulty] of [[3, 'easy'], [11, 'normal'], [28, 'hard'], [41, 'hard'], [57, 'hard']] as const) {
      const { world, state, road } = trackWorld(seed, difficulty);
      const end = world.length / UNIT - 35;
      const misses: string[] = [];
      for (let z = 0; z <= end; z += 7) {
        const center = road(z).center;
        const half = road(z).width / 2 - 1;
        for (const x of [center, center - half, center + half]) {
          for (const y of [0, 4]) {
            const placed = carAt(state, x, y, z);
            const pose = stuntCameraPose(placed, TALL, RECT, { road });
            const wrong = outside(cameraOf(pose, TALL), [...carCorners(placed), ...trackAhead(road, z)], RECT);
            if (wrong.length > 0) misses.push(`seed ${seed} car (${x.toFixed(1)}, ${y}, ${z}): ${wrong.slice(0, 3).join('; ')}`);
          }
        }
      }
      expect(misses.slice(0, 5)).toEqual([]);
    }
  });

  it('on the phone the car stays big enough for the legibility boost to reach the hero share', () => {
    const { state, road } = trackWorld(3);
    const placed = carAt(state, road(0).center, 0, 0);
    const camera = cameraOf(stuntCameraPose(placed, TALL, RECT, { road }), TALL);
    const ys = carCorners(placed).map((corner) => corner.project(camera).y);
    const share = (Math.max(...ys) - Math.min(...ys)) / 2;
    expect(share).toBeGreaterThanOrEqual(LEGIBLE_SHARE.hero / LEGIBLE_CAP);
  });

  it('839 × 412 landscape: car + shadow above `rect.ndc.bottom`, aim under `rect.ndc.top`', () => {
    for (const [seed, difficulty] of [[3, 'easy'], [28, 'hard'], [57, 'hard']] as const) {
      const { world, state, road } = trackWorld(seed, difficulty);
      const end = world.length / UNIT - 35;
      const misses: string[] = [];
      for (let z = 0; z <= end; z += 7) {
        const center = road(z).center;
        const half = road(z).width / 2 - 1;
        for (const x of [center, center - half, center + half]) {
          // Vrchol skoku jádra je 2,5 m (`stuntFlight` při plné rychlosti) – 3 m má rezervu.
          for (const y of [0, 1.5, 3]) {
            const placed = carAt(state, x, y, z);
            const pose = stuntCameraPose(placed, LANDSCAPE, WIDE_RECT, { road });
            const camera = cameraOf(pose, LANDSCAPE);
            // Stín se hlídá na zemi; ve skoku ho kamera nedrží (AC: skok čitelný i bez stínu – kamera stoupá s autem).
            const low = Math.min(...[...carCorners(placed), ...(y === 0 ? shadowCorners(placed) : [])].map((corner) => corner.project(camera).y));
            const aim = pose.look.clone().project(camera).y;
            if (low < WIDE_RECT.ndc.bottom - EPS) misses.push(`seed ${seed} car (${x.toFixed(1)}, ${y}, ${z}): low ${low.toFixed(3)} < ${WIDE_RECT.ndc.bottom.toFixed(3)}`);
            if (aim > WIDE_RECT.ndc.top + EPS) misses.push(`seed ${seed} car (${x.toFixed(1)}, ${y}, ${z}): aim ${aim.toFixed(3)} > ${WIDE_RECT.ndc.top.toFixed(3)}`);
          }
        }
      }
      expect(misses.slice(0, 5)).toEqual([]);
    }
  });

  it('landscape: pose unchanged with no rect or when the car already clears it', () => {
    const { state, road } = trackWorld(11);
    const placed = carAt(state, road(60).center + 1.5, 0, 60);
    const roomy = playRect(LANDSCAPE_PHONE, 0, LANDSCAPE_PHONE.height);
    const a = stuntCameraPose(placed, LANDSCAPE, null, { road });
    const b = stuntCameraPose(placed, LANDSCAPE, roomy, { road });
    expect(b.position.toArray()).toEqual(a.position.toArray());
    expect(b.look.toArray()).toEqual(a.look.toArray());
    // Bez měřeného pásu leží stín na telefonu na šířku pod ním; s pásem se pohled sklopí (bod pohledu níž).
    const camera = cameraOf(a, LANDSCAPE);
    expect(Math.min(...shadowCorners(placed).map((corner) => corner.project(camera).y))).toBeLessThan(WIDE_RECT.ndc.bottom);
    expect(stuntCameraPose(placed, LANDSCAPE, WIDE_RECT, { road }).look.y).toBeLessThan(a.look.y);
  });

  it('rises with the car in the air, higher than on the ground, in both orientations', () => {
    const { state, road } = trackWorld(11);
    const center = road(80).center;
    for (const [aspect, rect] of [[WIDE, null], [TALL, RECT]] as const) {
      const ground = stuntCameraPose(carAt(state, center, 0, 80), aspect, rect, { road });
      const low = stuntCameraPose(carAt(state, center, 1.5, 80), aspect, rect, { road });
      const high = stuntCameraPose(carAt(state, center, 3.5, 80), aspect, rect, { road });
      expect(low.position.y).toBeGreaterThan(ground.position.y);
      expect(high.position.y).toBeGreaterThan(low.position.y);
    }
    // Na šířku stoupá kamera víc než auto (`air.lift`): dopad za rampou zůstane v záběru.
    const ground = stuntCameraPose(carAt(state, center, 0, 80), WIDE, null, { road });
    const high = stuntCameraPose(carAt(state, center, 3.5, 80), WIDE, null, { road });
    expect(high.position.y - ground.position.y - 3.5).toBeCloseTo(3.5 * STUNT_CAMERA.air.lift, 6);
    expect(STUNT_CAMERA.air.lift).toBeGreaterThan(0);
  });

  it('shakes briefly after a crash and not under prefers-reduced-motion', () => {
    const { state, road } = trackWorld(3);
    const placed = carAt(state, road(40).center, 0, 40);
    const calm = stuntCameraPose(placed, WIDE, null, { road });
    const hit = placed.slice();
    setGrace(hit, hit[HEADER.player] as number, STUNT.crash.grace - 2);
    const shaken = stuntCameraPose(hit, WIDE, null, { road });
    expect(shaken.position.distanceTo(calm.position)).toBeGreaterThan(0.01);
    expect(stuntCameraPose(hit, WIDE, null, { road, reduced: true }).position.toArray()).toEqual(calm.position.toArray());
    // Otřes je krátký: po `shake.ticks` tikách milosti už kamera stojí jako bez nárazu.
    const later = placed.slice();
    setGrace(later, later[HEADER.player] as number, STUNT.crash.grace - STUNT_CAMERA.shake.ticks);
    expect(stuntCameraPose(later, WIDE, null, { road }).position.toArray()).toEqual(calm.position.toArray());
  });
});
