/**
 * Plná aréna a kulisy v měřítku (P36C T5). Vnitřek arény byl jednolitá plocha
 * a kulisa v popředí (dům 7 m, větrný mlýn, jeřáb) stála nad hrdinou 1,3 m
 * jako věž. Měří se to, co scéna kreslí: síť výzdoby, místa kulis po stropu
 * a průmět hrdiny v záběru přistání – ne funkce, ze kterých vznikly.
 */

import { Color, PerspectiveCamera, SRGBColorSpace, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { LOOK_IDS, LOOKS } from '@/play/arcade/look';
import { ARENA } from '@/play/arcade/pieces/arena';

import { FOREGROUND_TALLEST, sceneryHeight, sceneryPlaces } from '../look/Scenery';
import { DECOR_TALLEST, arenaDecorPlaces, buildArenaDecor } from '../look/rig/terrain/arenaDecor';
import { placeLander } from '../steer/SteerScene';

const half = ARENA.half / UNIT;
/** Hrdina na startu (`ArenaScene` kreslí aspoň 1,3 m), věc 0,7 m. */
const keep = [
  { x: 0, z: 0, r: 1.2 },
  { x: 4, z: 3, r: 0.8 },
  { x: -5, z: -2, r: 0.8 },
];

describe('arena decor', () => {
  it('dresses the inside of every arena look, and never the same way twice for two games', () => {
    for (const id of LOOK_IDS) {
      const places = arenaDecorPlaces({ look: LOOKS[id], half, seed: 7, keep });
      expect(places.length, id).toBeGreaterThan(40);
      expect(new Set(places.map((place) => place.kind)).size, `${id}: more than one kind of decor`).toBeGreaterThan(1);
    }
    const a = arenaDecorPlaces({ look: LOOKS.forest, half, seed: 7, keep });
    expect(arenaDecorPlaces({ look: LOOKS.forest, half, seed: 7, keep })).toEqual(a);
    expect(arenaDecorPlaces({ look: LOOKS.forest, half, seed: 8, keep })).not.toEqual(a);
  });

  it('stays inside the arena, off the hero and the things, and low enough to never hide anything', () => {
    for (const id of LOOK_IDS) {
      for (const place of arenaDecorPlaces({ look: LOOKS[id], half, seed: 3, keep })) {
        expect(Math.max(Math.abs(place.x), Math.abs(place.z)), id).toBeLessThan(half);
        for (const spot of keep) expect(Math.hypot(place.x - spot.x, place.z - spot.z), `${id} ${place.kind} on a thing`).toBeGreaterThanOrEqual(spot.r);
      }
      const position = buildArenaDecor({ look: LOOKS[id], half, seed: 3, keep }).getAttribute('position');
      let top = 0;
      let reach = 0;
      for (let i = 0; i < position.count; i += 1) {
        top = Math.max(top, position.getY(i));
        reach = Math.max(reach, Math.abs(position.getX(i)), Math.abs(position.getZ(i)));
        expect(position.getY(i), id).toBeGreaterThanOrEqual(0);
      }
      expect(top, `${id}: decor height`).toBeLessThanOrEqual(DECOR_TALLEST);
      expect(top, `${id}: decor stands up off the floor`).toBeGreaterThan(0.03);
      expect(reach, id).toBeLessThan(half + 0.3);
      // Jedna síť pro celou výzdobu: kreslicích volání přibude jedno, trojúhelníků pár tisíc
      // (aréna je omezená voláními na CPU, ne trojúhelníky – `evals/play/perf/README.md`).
      expect(position.count / 3, `${id}: triangles`).toBeLessThan(8000);
    }
  });

  it('never paints anything purple, whatever the look mixes', () => {
    // Louže hradu z modré vody a šedé dlažby vyšly fialově – barvy výzdoby jsou míchané, ne vybrané.
    // Vrchol měl odstín 225° (modrá); do indiga (~237°) ho posunulo až tónování ACES rigu, proto
    // hranice 222° pro sytou barvu, ne 250°.
    const hsl = { h: 0, s: 0, l: 0 };
    const paint = new Color();
    for (const id of LOOK_IDS) {
      const colors = buildArenaDecor({ look: LOOKS[id], half, seed: 5, keep }).getAttribute('color');
      for (let i = 0; i < colors.count; i += 3) {
        paint.setRGB(colors.getX(i), colors.getY(i), colors.getZ(i)).getHSL(hsl, SRGBColorSpace);
        if (hsl.s > 0.25 && hsl.l > 0.08) expect(hsl.h * 360, `${id}: vertex ${i}`).not.toSatisfy((hue: number) => hue >= 222 && hue <= 320);
      }
    }
  });
});

describe('scenery scale', () => {
  const hero = 1.3;
  const inner = half + 4.5;

  it('caps the foreground row at three hero heights and leaves the far rows alone', () => {
    for (const id of LOOK_IDS) {
      const props = LOOKS[id].props;
      const free = sceneryPlaces(props, 'sides', inner, -inner, inner);
      const capped = sceneryPlaces(props, 'sides', inner, -inner, inner, { side: 1, height: FOREGROUND_TALLEST * hero });
      expect(capped.length).toBe(free.length);
      capped.forEach((place, i) => {
        if (place.x > 0) expect(sceneryHeight(place.kind) * place.scale, `${id} ${place.kind}`).toBeLessThanOrEqual(FOREGROUND_TALLEST * hero + 1e-9);
        else expect(place, `${id} far row`).toEqual(free[i]);
      });
    }
    // Strop opravdu něco ořízl: domy a mlýny dřív stály přes 3 výšky hrdiny.
    const city = sceneryPlaces(LOOKS.city.props, 'sides', inner, -inner, inner).filter((place) => place.x > 0);
    expect(Math.max(...city.map((place) => sceneryHeight(place.kind) * place.scale))).toBeGreaterThan(FOREGROUND_TALLEST * hero);
  });
});

describe('lander shot', () => {
  /** Podíl výšky obrazu, který hrdina zabere, a jeho střed v NDC. */
  function heroOnScreen(aspect: number, rocket: { x: number; y: number }, pad: { x: number; w: number }, h: number) {
    const camera = new PerspectiveCamera(60, aspect, 0.1, 500);
    placeLander(camera, new Vector3(), rocket.x, rocket.y, 0, { index: 1, x: pad.x, y: 0, z: 0, w: pad.w, h: 0.4, d: 4 }, h);
    camera.updateMatrixWorld();
    const top = new Vector3(rocket.x, rocket.y + h / 2, 0).project(camera);
    const bottom = new Vector3(rocket.x, rocket.y - h / 2, 0).project(camera);
    const padAt = new Vector3(pad.x, 0, 0).project(camera);
    return { share: (top.y - bottom.y) / 2, x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2, pad: padAt };
  }

  it('keeps the rocket at least 8 % of the frame tall, in view, on a phone and on a desktop', () => {
    for (const aspect of [1082 / 2202, 16 / 9]) {
      for (const rocket of [{ x: -18, y: 30 }, { x: 0, y: 12 }, { x: 14, y: 4 }]) {
        const seen = heroOnScreen(aspect, rocket, { x: 6, w: 10 }, 2.2);
        expect(seen.share, `aspect ${aspect.toFixed(2)} rocket ${rocket.x},${rocket.y}`).toBeGreaterThanOrEqual(0.08);
        expect(Math.abs(seen.x)).toBeLessThan(0.85);
        // Vršek pod lištou HUD (horních 15 % obrazu = NDC nad 0,7), spodek nad dolní řadou tlačítek.
        expect(seen.y + seen.share, 'rocket top under the HUD').toBeLessThan(0.7);
        expect(seen.y - seen.share).toBeGreaterThan(-0.7);
      }
    }
  });

  it('shows the pad once the rocket comes down near it', () => {
    const seen = heroOnScreen(1082 / 2202, { x: 4, y: 5 }, { x: 6, w: 10 }, 2.2);
    expect(Math.abs(seen.pad.x)).toBeLessThan(1);
    expect(Math.abs(seen.pad.y)).toBeLessThan(1);
  });
});
