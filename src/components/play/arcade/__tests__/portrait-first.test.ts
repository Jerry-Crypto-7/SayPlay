/**
 * Šev na výšku nových žánrů (P66 T2, `genres/portrait-first.ts`): na šířku vrací vstupní pózu beze změny, na výšku
 * telefonu (412 × 839) dá vzdálenost a svislý posun, po kterých leží celá krabice hry v pásu mezi horním pásem HUD
 * a dolní zónou palce. Fit, který krabici jen „skoro“ vejde, projde okem a schová cíl pod tlačítka.
 */

import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { type PlayRect, type TallFit, HUD_BAND_PX, THUMB_ZONE_PX, fitTall, tokenRect } from '../genres/portrait-first';

const PHONE = { width: 412, height: 839 } as const;

function cameraAt(width: number, height: number, position: Vector3, target: Vector3, fov = 50): PerspectiveCamera {
  const camera = new PerspectiveCamera(fov, width / height, 0.1, 500);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

/** Póza z fitu, jak ji scéna použije: kamera na `distance` od středu krabice po původním směru, záběr posunutý o `shift` px. */
function apply(camera: PerspectiveCamera, box: Box3, fit: TallFit, rect: PlayRect): void {
  const center = box.getCenter(new Vector3());
  const back = camera.position.clone().sub(center).normalize();
  camera.position.copy(center).addScaledVector(back, fit.distance);
  camera.lookAt(center);
  camera.setViewOffset(rect.width, rect.height, 0, fit.shift, rect.width, rect.height);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
}

/** Rohy krabice v px plátna (y dolů). */
function cornersPx(camera: PerspectiveCamera, box: Box3, rect: PlayRect): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = new Vector3(x, y, z).project(camera);
    out.push({ x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height });
  }
  return out;
}

const BOXES: readonly (readonly [string, Box3, Vector3])[] = [
  // Aréna vyšší než širší (survivor, krádež) pod kamerou zezadu shora.
  ['tall arena from behind', new Box3(new Vector3(-6, 0, -9), new Vector3(6, 1.5, 9)), new Vector3(0, 14, 16)],
  // Mřížka šipek a nádoby třídění skoro shora.
  ['puzzle grid from above', new Box3(new Vector3(-4, 0, -5), new Vector3(4, 0.5, 5)), new Vector3(0, 18, 3)],
  // Široké město díry – na výšku musí kamera couvnout.
  ['wide city', new Box3(new Vector3(-20, 0, -12), new Vector3(20, 4, 12)), new Vector3(0, 20, 22)],
];

describe('portrait-first fit (P66 T2)', () => {
  it('takes the HUD band and the thumb zone from brand tokens, not from the DOM', () => {
    const rect = tokenRect(PHONE.width, PHONE.height);
    expect(rect).toEqual({ width: 412, height: 839, top: HUD_BAND_PX, bottom: 839 - THUMB_ZONE_PX });
    expect(HUD_BAND_PX).toBeGreaterThan(0);
    expect(THUMB_ZONE_PX).toBeGreaterThan(HUD_BAND_PX);
  });

  it.each(BOXES)('landscape (%s): returns the input pose unchanged', (_, box, from) => {
    const camera = cameraAt(1280, 720, from, box.getCenter(new Vector3()));
    const fit = fitTall(camera, box, tokenRect(1280, 720));
    expect(fit).toEqual({ distance: from.distanceTo(box.getCenter(new Vector3())), shift: 0 });
  });

  it.each(BOXES)('phone 412 × 839 (%s): the whole box lies inside the play rect', (_, box, from) => {
    const rect = tokenRect(PHONE.width, PHONE.height);
    const camera = cameraAt(PHONE.width, PHONE.height, from, box.getCenter(new Vector3()));
    const fit = fitTall(camera, box, rect);
    expect(fit.shift).toBeGreaterThan(0);
    apply(camera, box, fit, rect);
    for (const corner of cornersPx(camera, box, rect)) {
      expect(corner.x).toBeGreaterThanOrEqual(-1e-6);
      expect(corner.x).toBeLessThanOrEqual(rect.width + 1e-6);
      expect(corner.y).toBeGreaterThanOrEqual(rect.top - 1e-6);
      expect(corner.y).toBeLessThanOrEqual(rect.bottom + 1e-6);
    }
  });

  it('phone: the fit is tight – the box touches the rect on at least one side', () => {
    const [, box, from] = BOXES[0]!;
    const rect = tokenRect(PHONE.width, PHONE.height);
    const camera = cameraAt(PHONE.width, PHONE.height, from, box.getCenter(new Vector3()));
    apply(camera, box, fitTall(camera, box, rect), rect);
    const corners = cornersPx(camera, box, rect);
    const slack = Math.min(
      Math.min(...corners.map((c) => c.x)),
      rect.width - Math.max(...corners.map((c) => c.x)),
      Math.min(...corners.map((c) => c.y)) - rect.top,
      rect.bottom - Math.max(...corners.map((c) => c.y)),
    );
    // Okraj fitu (`FIT_MARGIN_PX`) je jediná vůle; víc by znamenalo, že kamera zbytečně couvá.
    expect(slack).toBeLessThan(16);
  });
});
