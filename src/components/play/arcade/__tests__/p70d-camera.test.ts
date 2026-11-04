/**
 * P70D T3: běžec a plošinovka na telefonu na výšku koukají shora šikmo (3/4), dráha tří řad překážek před hrdinou je
 * v hracím obdélníku a kolizní tělo hrdiny ve záběru kamery (1×, před zvětšením čitelností `LEGIBLE_SHARE`)
 * nezabere víc než 15 % výšky plátna.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { PLATFORM } from '@/play/arcade/pieces/platform';
import { RUNNER, SPEED } from '@/play/arcade/pieces/runner';

import { type PlayRect, playRect } from '../portrait-frame';
import { PLATFORM_TALL, RUNNER_TALL, placePlatform, placeRunner } from '../track-camera';

const PHONE = { width: 412, height: 839 } as const;
const RECT: PlayRect = playRect(PHONE, 132, 743);
/** Řada překážek běžce při hustotě `normal`: 80 tiků mezery × rychlost `normal` (m). */
const ROW = (80 * SPEED.normal) / UNIT;

function cameraOf(place: (camera: PerspectiveCamera, look: Vector3) => void): { camera: PerspectiveCamera; look: Vector3 } {
  const camera = new PerspectiveCamera(60, PHONE.width / PHONE.height, 0.1, 500);
  const look = new Vector3();
  place(camera, look);
  camera.updateMatrixWorld();
  return { camera, look };
}

const pitchOf = (camera: PerspectiveCamera, look: Vector3): number => Math.asin(-look.clone().sub(camera.position).normalize().y) * (180 / Math.PI);
const ndc = (camera: PerspectiveCamera, x: number, y: number, z: number): Vector3 => new Vector3(x, y, z).project(camera);
const inRect = (point: Vector3): boolean => point.z < 1 && Math.abs(point.x) <= 1 && point.y <= RECT.ndc.top && point.y >= RECT.ndc.bottom;

describe('3/4 chase cameras on a phone (P70D T3)', () => {
  it('runner: looks down from above, three obstacle rows ahead in the play rect, hero space at most 15 % of the height', () => {
    const { camera, look } = cameraOf((c, l) => placeRunner(c, l, 0, 0, undefined, RECT));
    expect(pitchOf(camera, look)).toBeGreaterThanOrEqual(30);
    for (const lane of [-2, 0, 2]) expect(inRect(ndc(camera, lane, 0, 3 * ROW)), `lane ${String(lane)}`).toBe(true);
    const share = (ndc(camera, 0, RUNNER.runH / UNIT, 0).y - ndc(camera, 0, 0, 0).y) / 2;
    expect(share).toBeLessThanOrEqual(0.15);
    expect(RUNNER_TALL.top).toBeGreaterThanOrEqual(RUNNER.runH / UNIT);
    expect(inRect(ndc(camera, 0, 0, 0))).toBe(true);
  });

  // Plošinovka je 3/4 už natočením `yaw` 55°; strmější sklon (16–20°) zvedl stromový dům a věž nad mez P54B
  // (`p54b-landmark`: 0,61–0,66 šířky > 0,55), proto sklon zůstal 10°.
  it('platformer: three quarters from the side, hero space at most 15 % of the height', () => {
    const base = PLATFORM.baseTop / UNIT;
    const { camera, look } = cameraOf((c, l) => placePlatform(c, l, 0, base, RECT));
    expect(pitchOf(camera, look)).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(PLATFORM_TALL.yaw * (180 / Math.PI)).toBeGreaterThanOrEqual(45);
    const share = (ndc(camera, 0, base + PLATFORM.playerH / UNIT, 0).y - ndc(camera, 0, base, 0).y) / 2;
    expect(share).toBeLessThanOrEqual(0.15);
    expect(inRect(ndc(camera, 0, base, 0))).toBe(true);
    expect(inRect(ndc(camera, 0, base, PLATFORM_TALL.depth))).toBe(true);
  });
});
