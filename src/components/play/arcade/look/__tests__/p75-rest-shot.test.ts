/**
 * P75 T4 – záběr zblízka v klidu a makro rozostření.
 *
 * Na snímku oko nepozná, jestli přejezd trvá 0,8 s, nebo jestli se po pauze vrátí, ani že čitelnost těl dál měří
 * herní záběr (`restCamera`) – ne záběr zblízka, ve kterém by se hrdina „zmenšil“ zpátky. Tohle pinuje tyhle
 * invarianty a geometrii záběru (hrdina ~1/4 výšky, sklon 12–20°, obzor v horní třetině).
 */

import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ARCADE_HZ } from '@/play/arcade/contract';

import { horizonNdc, tiltFocus } from '../framing';
import { applyIntro, restCamera } from '../intro';
import { REST_CONTROLS, REST_FOCUS, REST_FRAMING, REST_SHOT, restEase, restPose, restTarget, stepRest } from '../rest-shot';
import { TILT, macroFocus } from '../rig/Post';

const FRAME_S = 1 / 60;

describe('P75 T4: kdy je kamera zblízka', () => {
  it('holds the close shot on the start card, in pause, after the end and for the first 1.5 s of play', () => {
    expect(restTarget(true, false, 0)).toBe(1);
    expect(restTarget(true, false, REST_SHOT.holdS * ARCADE_HZ - 1)).toBe(1);
    expect(restTarget(true, false, REST_SHOT.holdS * ARCADE_HZ)).toBe(0);
    expect(restTarget(true, true, 10 * ARCADE_HZ)).toBe(1);
    expect(restTarget(false, false, 10 * ARCADE_HZ)).toBe(1);
  });

  it('moves between the shots within 0.8 s, monotonic, and a long idle gap does not skip the move', () => {
    let weight = 1;
    let frames = 0;
    while (weight > 0) {
      const next = stepRest(weight, 0, FRAME_S);
      expect(next).toBeLessThan(weight);
      weight = next;
      frames += 1;
    }
    expect(frames * FRAME_S).toBeLessThanOrEqual(REST_SHOT.moveS + FRAME_S);
    expect(frames * FRAME_S).toBeGreaterThan(REST_SHOT.moveS / 2);
    // Pauza: zpátky do blízka stejně plynule, i po snímku, který přišel po dlouhé nečinnosti plátna.
    expect(stepRest(0, 1, 5)).toBeLessThan(0.2);
    expect(restEase(0)).toBe(0);
    expect(restEase(1)).toBe(1);
    expect(restEase(0.1)).toBeLessThan(0.1);
  });

  it('is on for the hero-led diorama controls, off for the tower and the golf overview', () => {
    for (const control of ['runner', 'steer', 'move_free', 'lanes']) expect(REST_CONTROLS.has(control), control).toBe(true);
    for (const control of ['timing', 'minigolf', 'fight', 'shooter', 'platform']) expect(REST_CONTROLS.has(control), control).toBe(false);
  });
});

describe('P75 T4: geometrie záběru zblízka', () => {
  const shot = (aspect: number, height: number, heading: Vector3) => {
    const camera = new PerspectiveCamera(60, aspect, 0.1, 500);
    const eye = new Vector3();
    const look = new Vector3();
    const center = new Vector3(3, 0.7, 40);
    restPose(eye, look, center, heading, height, camera.fov);
    camera.position.copy(eye);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    const ndc = (point: Vector3): number => point.clone().project(camera).y;
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    return {
      pitch: MathUtils.radToDeg(Math.asin(-forward.y)),
      hero: ndc(center),
      share: (ndc(center.clone().setY(center.y + height / 2)) - ndc(center.clone().setY(center.y - height / 2))) / 2,
      behind: new Vector3().subVectors(center, eye).setY(0).normalize().dot(heading),
    };
  };

  for (const [name, aspect] of [['desktop', 16 / 10], ['phone', 390 / 844]] as const) {
    it(`puts the hero at ~1/4 of the frame height, low behind him, horizon in the top third (${name})`, () => {
      const at = shot(aspect, 1.4, new Vector3(0, 0, 1));
      expect(at.pitch).toBeGreaterThanOrEqual(12);
      expect(at.pitch).toBeLessThanOrEqual(20);
      expect(horizonNdc(at.pitch)).toBeGreaterThan(1 / 3);
      expect(at.hero).toBeCloseTo(REST_FRAMING.hero, 2);
      expect(at.share).toBeGreaterThan(0.22);
      expect(at.share).toBeLessThan(0.3);
      expect(at.behind).toBeCloseTo(1, 5);
    });
  }

  it('keeps behind the hero whichever way the game camera looks, and frames a model not loaded yet by the floor height', () => {
    const heading = new Vector3(-1, 0, 1).normalize();
    expect(shot(16 / 10, 1.4, heading).behind).toBeCloseTo(1, 5);
    const empty = shot(16 / 10, 0, new Vector3(0, 0, 1));
    expect(empty.hero).toBeCloseTo(REST_FRAMING.hero, 2);
  });
});

describe('P75 T4: herní záběr pro čitelnost a kulisy', () => {
  it('restCamera returns the game pose RestShot blended away, not the close shot on screen', () => {
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 500);
    const game = { position: new Vector3(0, 6, -10), quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4) };
    camera.position.set(0, 2, 30);
    camera.userData.game = game;
    const out = restCamera(camera, new PerspectiveCamera());
    expect(out.position.toArray()).toEqual(game.position.toArray());
    expect(out.quaternion.angleTo(game.quaternion)).toBeLessThan(1e-6);
  });

  it('without a blended shot it still undoes only the intro flyby', () => {
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 500);
    camera.position.set(0, 4, -8);
    const look = new Vector3(0, 0, 4);
    camera.lookAt(look);
    applyIntro(camera, look, 0.5);
    const out = restCamera(camera, new PerspectiveCamera());
    expect(out.position.distanceTo(new Vector3(0, 4, -8))).toBeLessThan(1e-6);
  });
});

describe('P75 T4: makro rozostření', () => {
  it('blurs harder with a narrower sharp band in the close shot, and moves the band onto the close hero', () => {
    const play = tiltFocus('runner')!;
    const still = macroFocus(play, 0);
    const rest = macroFocus(play, 1);
    expect(still).toEqual({ blur: TILT.play.blur, taper: TILT.play.taper, focus: play });
    expect(rest.blur).toBeGreaterThan(still.blur);
    expect(rest.taper).toBeLessThan(still.taper);
    expect(rest.focus).toBe(REST_FOCUS);
    // Ostrý pás přes hrdinu záběru zblízka (střed v NDC −0,4 = výška obrazu 0,3).
    expect(REST_FOCUS).toBeGreaterThan((REST_FRAMING.hero + 1) / 2);
    expect(REST_FOCUS).toBeLessThan((REST_FRAMING.hero + 1) / 2 + REST_SHOT.share);
    // P73D za hry rozostřovalo 0,12 – makro je silnější i za hry.
    expect(TILT.play.blur).toBeGreaterThan(0.12);
  });
});
