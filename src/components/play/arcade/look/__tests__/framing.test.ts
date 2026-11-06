/**
 * P73D T2: každé ovládání rámuje 3/4 s obzorem – sklon 22–38°, zorné pole 45–60°, obzor v horní třetině obrazu
 * a hrdina v dolní. Měří skutečné kamery žánrů (čisté funkce rámování), ne jen tabulku. Stav ani hash se nemění:
 * to drží `p64-hash.test.ts` (22 her, robot i nečinný hráč, přesná shoda s `evals/play/p64/hash-baseline.json`).
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { LEGIBLE_CAP } from '@/play/arcade/models';
import { TIMING } from '@/play/arcade/pieces/timing';

import { STYLED_TILT, raiseArena } from '../../arena/arena-camera';
import { CATCH_PITCH, placeCatchWide, tiltCatch } from '../../genres/catch/CatchScene';
import { LANE_CAMERA } from '../../genres/lanes/LaneScene';
import { MINIGOLF_CAMERA } from '../../genres/minigolf/minigolf-camera';
import { placeGlide } from '../../glide/camera';
import { type PlayRect, playRect } from '../../portrait-frame';
import { placeChase } from '../../steer/SteerScene';
import { placeTiming, timingDistance } from '../../timing/TimingScene';
import { placeRunner } from '../../track-camera';
import { CANVAS_FOV, CENTRED_SUBJECT, DIORAMA_FRAMING, FRAMING_LIMITS, horizonNdc } from '../framing';

const DESKTOP = 1440 / 900;
const PHONE = { width: 390, height: 844 } as const;
const RECT: PlayRect = playRect(PHONE, 120, 760);
const DEG = 180 / Math.PI;

function cameraAt(aspect: number): PerspectiveCamera {
  return new PerspectiveCamera(CANVAS_FOV, aspect, 0.1, 500);
}

/** Sklon osy pohledu pod vodorovnou (°). */
function pitchOf(camera: PerspectiveCamera): number {
  camera.updateMatrixWorld();
  return Math.asin(-camera.getWorldDirection(new Vector3()).y) * DEG;
}

function expectDiorama(camera: PerspectiveCamera, label: string, hero?: Vector3): void {
  const pitch = pitchOf(camera);
  expect(pitch, `${label} pitch`).toBeGreaterThanOrEqual(FRAMING_LIMITS.pitch.min - 0.5);
  expect(pitch, `${label} pitch`).toBeLessThanOrEqual(FRAMING_LIMITS.pitch.max);
  expect(camera.fov, `${label} fov`).toBeGreaterThanOrEqual(FRAMING_LIMITS.fov.min);
  expect(camera.fov, `${label} fov`).toBeLessThanOrEqual(FRAMING_LIMITS.fov.max);
  const horizon = horizonNdc(pitch, camera.fov);
  expect(horizon, `${label} horizon`).toBeGreaterThanOrEqual(FRAMING_LIMITS.horizon);
  expect(horizon, `${label} horizon in frame`).toBeLessThan(1);
  if (hero === undefined) return;
  camera.updateProjectionMatrix();
  const at = hero.clone().project(camera);
  expect(at.y, `${label} hero low`).toBeLessThanOrEqual(FRAMING_LIMITS.hero);
  expect(at.y, `${label} hero in frame`).toBeGreaterThan(-1);
  expect(Math.abs(at.x), `${label} hero in frame`).toBeLessThan(1);
}

describe('diorama framing table (P73D T2)', () => {
  it('every framed control: pitch 22–38°, horizon in the upper third, hero in the lower third', () => {
    for (const [control, framing] of Object.entries(DIORAMA_FRAMING)) {
      expect(framing.pitch, control).toBeGreaterThanOrEqual(FRAMING_LIMITS.pitch.min);
      expect(framing.pitch, control).toBeLessThanOrEqual(FRAMING_LIMITS.pitch.max);
      const horizon = horizonNdc(framing.pitch);
      expect(horizon, control).toBeGreaterThanOrEqual(FRAMING_LIMITS.horizon);
      expect(horizon, control).toBeLessThan(1);
      if (!CENTRED_SUBJECT.has(control)) expect(framing.hero, control).toBeLessThanOrEqual(FRAMING_LIMITS.hero);
    }
  });

  it('a pitch past the half field of view puts the horizon off the top edge (why the phone poses dropped from 32°)', () => {
    expect(horizonNdc(33.4)).toBeGreaterThan(1);
    expect(horizonNdc(40)).toBeGreaterThan(1);
  });
});

describe('genre cameras stay inside the table (P73D T2)', () => {
  it('runner: desktop and phone', () => {
    const wide = cameraAt(DESKTOP);
    placeRunner(wide, new Vector3(), 0, 0);
    expectDiorama(wide, 'runner desktop', new Vector3(0, 0.7, 0));
    const tall = cameraAt(PHONE.width / PHONE.height);
    placeRunner(tall, new Vector3(), 0, 0, undefined, RECT);
    expectDiorama(tall, 'runner phone', new Vector3(0, 0.7, 0));
  });

  it('race: desktop and phone', () => {
    const wide = cameraAt(DESKTOP);
    placeChase(wide, new Vector3(), 0, 0, 0);
    expectDiorama(wide, 'steer desktop', new Vector3(0, 0.6, 0));
    const tall = cameraAt(PHONE.width / PHONE.height);
    placeChase(tall, new Vector3(), 0, 0, 0, RECT);
    expectDiorama(tall, 'steer phone', new Vector3(0, 0.6, 0));
  });

  it('chase and quest arena: looks at the hero from ~39°, then the view rises to the table pitch', () => {
    for (const aspect of [DESKTOP, PHONE.width / PHONE.height]) {
      const camera = cameraAt(aspect);
      const distance = 18;
      camera.position.set(0, distance * STYLED_TILT.sin, -distance * STYLED_TILT.cos);
      camera.lookAt(0, 0, 0);
      raiseArena(camera, false);
      expect(pitchOf(camera)).toBeCloseTo(DIORAMA_FRAMING.move_free.pitch, 6);
      expectDiorama(camera, `arena ${aspect.toFixed(2)}`, new Vector3(0, 0, 0));
    }
  });

  it('fight keeps its steep tilt: raiseArena leaves it alone', () => {
    const camera = cameraAt(DESKTOP);
    camera.position.set(0, 10, -10);
    camera.lookAt(0, 0, 0);
    raiseArena(camera, true);
    expect(pitchOf(camera)).toBeCloseTo(45, 6);
  });

  it('stacking: higher and farther, the slider in the middle of the shot', () => {
    for (const aspect of [DESKTOP, PHONE.width / PHONE.height]) {
      const camera = cameraAt(aspect);
      const look = new Vector3();
      const before = timingDistance(CANVAS_FOV, aspect, 1);
      placeTiming(camera, look, 2, before);
      expectDiorama(camera, `timing ${aspect.toFixed(2)}`);
      expect(camera.position.distanceTo(look)).toBeGreaterThan(before);
      camera.updateProjectionMatrix();
      expect(Math.abs(new Vector3(0, 2, 0).project(camera).y)).toBeLessThan(1e-6);
    }
  });

  it('stacking on desktop: the slab at the legibility cap stays under 30 % of the frame width (s4: ~33 % at TIMING_BACK 1.25)', () => {
    const camera = cameraAt(DESKTOP);
    const y = TIMING.baseH / UNIT;
    placeTiming(camera, new Vector3(), y, timingDistance(CANVAS_FOV, DESKTOP, TIMING.blockW / UNIT));
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    // Jezdec zvětšený čitelností kolem paty (`LegibleBodies`): přední stěna je ke kameře nejblíž, tedy nejširší.
    const half = (TIMING.blockW / UNIT) * LEGIBLE_CAP / 2;
    const front = -(TIMING.depth / UNIT) * LEGIBLE_CAP / 2;
    const left = new Vector3(half, y, front).project(camera).x;
    const right = new Vector3(-half, y, front).project(camera).x;
    expect(Math.abs(left - right) / 2).toBeLessThan(0.3);
  });

  it('mini golf: the rest overview pitch is inside the table', () => {
    const camera = cameraAt(DESKTOP);
    camera.position.set(0, Math.sin(MINIGOLF_CAMERA.rest.pitch / DEG), -Math.cos(MINIGOLF_CAMERA.rest.pitch / DEG));
    camera.lookAt(0, 0, 0);
    expectDiorama(camera, 'minigolf rest');
  });

  it('catch and lanes: three quarters from above instead of straight on', () => {
    const camera = cameraAt(DESKTOP);
    placeCatchWide(camera);
    expect(pitchOf(camera)).toBeCloseTo(CATCH_PITCH * DEG, 6);
    expectDiorama(camera, 'catch', new Vector3(0, 0.5, 0));
    const fitted = cameraAt(DESKTOP);
    tiltCatch(fitted, 3, 14);
    expect(pitchOf(fitted)).toBeCloseTo(CATCH_PITCH * DEG, 6);
    const lanes = cameraAt(DESKTOP);
    lanes.position.set(...LANE_CAMERA.position);
    lanes.lookAt(...LANE_CAMERA.look);
    expectDiorama(lanes, 'lanes', new Vector3(0, 0.5, 0));
  });

  it('glide: desktop and phone', () => {
    const wide = cameraAt(DESKTOP);
    placeGlide(wide, new Vector3(), 0, 6, 0);
    expectDiorama(wide, 'glide desktop', new Vector3(0, 6, 0));
    const tall = cameraAt(PHONE.width / PHONE.height);
    placeGlide(tall, new Vector3(), 0, 6, 0, RECT);
    expectDiorama(tall, 'glide phone', new Vector3(0, 6, 0));
  });
});
