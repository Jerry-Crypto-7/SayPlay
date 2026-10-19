/**
 * Orientační bod a rámující kusy (P54B T8). Pinuje se, co z obrazu nikdo nepozná: bod,
 * který stojí mimo záběr, za mlhou nebo na hrací ploše, se nikde neprojeví chybou – scéna
 * vypadá jako dřív. Umístění se tu staví skutečnými kamerami žánrů (`placeRunner`,
 * `placeBall`…) na šířku (1280 × 800) i na výšku (Pixel 7) a promítá se nezávisle na
 * hledání v `landmark-places.ts`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import catalog from '@/assets/catalog-index.json';
import { UNIT } from '@/play/arcade/contract';
import { LOOK_IDS, LOOKS, type Look, modelHeight, SCENERY_MODELS } from '@/play/arcade/look';
import { FLAP } from '@/play/arcade/pieces/flap';
import { GLIDE } from '@/play/arcade/pieces/glide';
import { PLATFORM } from '@/play/arcade/pieces/platform';
import { TIMING } from '@/play/arcade/pieces/timing';

import { isPurple, toSrgb } from '../../../../../../scripts/assets/cc0/palette.mjs';
import { placeBall } from '../../ball/camera';
import { placeGlide } from '../../glide/camera';
import { placeChase, placeLander } from '../../steer/SteerScene';
import { placeAngled, placePlatform, placeRunner, placeSide } from '../../track-camera';
import { placeWalker } from '../../walker/view';
import type { Box } from '../ground';
import { applyIntro, restCamera } from '../intro';
import { type HeroBox, keepOff, LANDMARK_FAR_M, LANDMARK_NEAR_M, landmarkPicks, placeFraming, placeLandmark, type Volume } from '../landmark-places';
import { PLAYABLE_HALF } from '../rig/terrain/valley';

const PUBLIC = join(__dirname, '..', '..', '..', '..', '..', '..', 'public');
const PATHS: ReadonlyMap<string, string> = new Map(catalog.assets.map((asset) => [asset.assetId, asset.path]));

const DESKTOP = 1280 / 800;
const PHONE = 412 / 915;
const DEG = Math.PI / 180;
const ALL_Z = { z0: -Infinity, z1: Infinity } as const;

interface Genre {
  readonly id: string;
  readonly place: (camera: PerspectiveCamera, look: Vector3) => void;
  readonly area: readonly Box[];
  readonly hero: HeroBox;
  readonly ground?: (x: number, z: number) => number;
}

/** Kamera arény 3/4 shora (`ArenaScene` StyledWorld): sklon a vzdálenost k hrdinovi v (0, 0). */
const arenaCamera = (tilt: number, distance: number) => (camera: PerspectiveCamera, look: Vector3) => {
  camera.position.set(0, distance * Math.sin(tilt * DEG), -distance * Math.cos(tilt * DEG));
  look.set(0, 0, 0);
  camera.lookAt(look);
};

/** Kamera hodu (`ThrowRig`): na šířku z boku přes hřiště −3…27 m, na výšku šikmo zezadu. */
const throwCamera = (camera: PerspectiveCamera, look: Vector3) => {
  if (camera.aspect < 1) {
    camera.position.set(-3.5, 7, -8);
    look.set(0, 2, 9);
  } else {
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const dist = Math.max(30 / (2 * tan * camera.aspect), 10 / (2 * tan));
    camera.position.set(-dist, 4, 12);
    look.set(0, 4, 12);
  }
  camera.lookAt(look);
};

const WATER = PLATFORM.fallBelowY / UNIT - 0.4;
const SLAB_HALF = PLATFORM.slabW / UNIT / 2;
const GLIDE_BOUND = GLIDE.bound / UNIT;

const GENRES: readonly Genre[] = [
  { id: 'runner', place: (camera, look) => placeRunner(camera, look, 0, 0), area: [{ x0: -PLAYABLE_HALF, x1: PLAYABLE_HALF, ...ALL_Z }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.4 } },
  { id: 'platform', place: (camera, look) => placePlatform(camera, look, 0, WATER + 1), area: [{ x0: -SLAB_HALF, x1: SLAB_HALF, ...ALL_Z }], hero: { x: 0, y: WATER + 1, z: 0, r: 0.6, h: 1.4 }, ground: () => WATER + 0.25 },
  {
    id: 'flap',
    place: (camera, look) => (camera.aspect < 1 ? placeAngled(camera, look, 0, FLAP.ceiling / UNIT / 2, 22, 50 * DEG, 5) : placeSide(camera, look, 0, FLAP.ceiling / UNIT / 2, 30, FLAP.ceiling / UNIT + 1, 26, 0.1)),
    area: [{ x0: -1.5, x1: 1.5, ...ALL_Z }],
    hero: { x: 0, y: 4, z: 0, r: 0.5, h: 1 },
    ground: () => -0.4,
  },
  { id: 'glide', place: (camera, look) => placeGlide(camera, look, 0, 3, 0), area: [{ x0: -GLIDE_BOUND, x1: GLIDE_BOUND, ...ALL_Z }], hero: { x: 0, y: 3, z: 0, r: 0.6, h: 1 } },
  // Bludiště 9 × 9 buněk po 4 m, hrdina u vchodu na straně kamery.
  { id: 'walker', place: (camera, look) => placeWalker(camera, look, 0, 0), area: [{ x0: -34, x1: 2, z0: -2, z1: 34 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.4 } },
  // Hřiště: míč letí do 18 m před hráčem a 3,5 m do strany (`BallScene`), brána za tím.
  { id: 'ball', place: (camera, look) => placeBall(camera, look), area: [{ x0: -8, x1: 8, z0: -3, z1: 22 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.4 } },
  { id: 'steer', place: (camera, look) => placeChase(camera, look, 0, 0, 0), area: [{ x0: -5, x1: 5, ...ALL_Z }], hero: { x: 0, y: 0, z: 0, r: 1, h: 1.5 } },
  { id: 'arena', place: arenaCamera(40, 16), area: [{ x0: -12, x1: 12, z0: -12, z1: 12 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.3 } },
  // Souboj kouká strměji (60°) na menší ring.
  { id: 'fight', place: arenaCamera(60, 14), area: [{ x0: -9, x1: 9, z0: -9, z1: 9 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.6 } },
  { id: 'throw', place: throwCamera, area: [{ x0: -2, x1: 2, z0: -3, z1: 27 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.4 } },
];

/** Genre camera with the lens of the stage (`ArcadeStage`: fov 60) and the far plane at the end of the fog (`FarAtFog`). */
function cameraOf(genre: Genre, aspect: number, look: Look): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, aspect, 0.1, look.fog[1]);
  genre.place(camera, new Vector3());
  camera.updateMatrixWorld();
  return camera;
}

interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  /** Hloubka nejbližšího a nejvzdálenějšího rohu před kamerou (m). */
  readonly near: number;
  readonly far: number;
}

/** Kvádr (pata ve středu, poloměr, výška) promítnutý kamerou – nezávisle na kódu, který místo hledal. */
function rectOf(camera: PerspectiveCamera, x: number, y: number, z: number, r: number, h: number): Rect {
  const points = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(x + (i & 1 ? r : -r), i & 2 ? y + h : y, z + (i & 4 ? r : -r)));
  const depths = points.map((point) => -point.clone().applyMatrix4(camera.matrixWorldInverse).z);
  const ndc = points.map((point) => point.clone().project(camera));
  return { minX: Math.min(...ndc.map((p) => p.x)), maxX: Math.max(...ndc.map((p) => p.x)), minY: Math.min(...ndc.map((p) => p.y)), maxY: Math.max(...ndc.map((p) => p.y)), near: Math.min(...depths), far: Math.max(...depths) };
}

/** Podíl obdélníku uvnitř obrazu. */
function inFrame(rect: Rect): number {
  const w = Math.max(0, Math.min(rect.maxX, 1) - Math.max(rect.minX, -1));
  const h = Math.max(0, Math.min(rect.maxY, 1) - Math.max(rect.minY, -1));
  return (w * h) / ((rect.maxX - rect.minX) * (rect.maxY - rect.minY));
}

const overlaps = (a: Omit<Rect, 'near' | 'far'>, b: Omit<Rect, 'near' | 'far'>): boolean => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
const onArea = (area: readonly Box[], x: number, z: number, r: number): boolean => area.some((box) => x + r > box.x0 && x - r < box.x1 && z + r > box.z0 && z - r < box.z1);
/** Poloměr paty, se kterým hledání počítá (`FOOT` v `landmark-places.ts`). */
const footOf = (id: string, scale: number): number => 0.35 * modelHeight(id as never) * scale;

describe('P54B T8: data orientačního bodu', () => {
  it.each(LOOK_IDS)('%s: 1–3 kandidáti z SCENERY_MODELS', (id) => {
    const candidates = LOOKS[id].landmark;
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.length).toBeLessThanOrEqual(3);
    for (const candidate of candidates) expect(Object.hasOwn(SCENERY_MODELS, candidate), candidate).toBe(true);
  });

  it('kandidát je v public/, má jednu síť a jeden materiál (jedno kreslicí volání) a žádný fialový vrchol', async () => {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const problems: string[] = [];
    for (const id of new Set(LOOK_IDS.flatMap((look) => LOOKS[look].landmark))) {
      const path = PATHS.get(id);
      if (path === undefined || !existsSync(join(PUBLIC, path))) {
        problems.push(`${id}: GLB chybí`);
        continue;
      }
      const doc = await io.read(join(PUBLIC, path));
      const meshes = doc.getRoot().listMeshes();
      const primitives = meshes.flatMap((mesh) => mesh.listPrimitives());
      if (meshes.length !== 1 || new Set(primitives.map((primitive) => primitive.getMaterial())).size !== 1) problems.push(`${id}: ${meshes.length} sítí`);
      for (const primitive of primitives) {
        const factor = primitive.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1];
        const colour = primitive.getAttribute('COLOR_0');
        for (let i = 0; i < primitive.getAttribute('POSITION')!.getCount(); i += 1) {
          const linear = colour === null ? [1, 1, 1] : colour.getElement(i, []);
          if (isPurple(toSrgb([linear[0]! * factor[0]!, linear[1]! * factor[1]!, linear[2]! * factor[2]!]))) {
            problems.push(`${id}: fialový vrchol ${i}`);
            break;
          }
        }
      }
    }
    expect(problems).toEqual([]);
  }, 30_000);
});

describe('P54B T8: výběr ze semínka', () => {
  it('totéž semínko vybere totéž, různá semínka projdou všechny kandidáty sady', () => {
    const jungle = LOOKS.jungle;
    expect(landmarkPicks(jungle, 42)).toEqual(landmarkPicks(jungle, 42));
    const seen = new Set(Array.from({ length: 60 }, (_, seed) => landmarkPicks(jungle, seed * 7919).landmark));
    expect([...seen].sort()).toEqual([...jungle.landmark].sort());
  });

  it('rámující kus je rekvizita sady, nikdy sám orientační bod, a nejvýš dva', () => {
    for (const id of LOOK_IDS) {
      for (const seed of [1, 2, 3]) {
        const picks = landmarkPicks(LOOKS[id], seed);
        expect(picks.framing.length).toBeLessThanOrEqual(2);
        for (const piece of picks.framing) {
          expect(LOOKS[id].props, `${id} ${piece}`).toContain(piece);
          expect(piece).not.toBe(picks.landmark);
        }
      }
    }
  });
});

/**
 * Kolik bodu musí být v záběru. Bludiště kouká 63–70° dolů a zem vidí jen do ~30 m od kamery,
 * kde stojí bludiště samo: za ním je v obraze nanejvýš pata bodu. Souboj kouká 60° dolů z 13–14 m:
 * zem 25 m od kamery leží na horním kraji obrazu, bod v pásmu 25–60 m je celý nad ním. Poletování
 * na výšku má úzký obraz (±15° do strany) a koridor letu ±12 m – mimo koridor je obraz vždy mimo.
 */
const LEAST_IN_FRAME: Readonly<Record<string, number>> = { 'walker desktop': 0.1, 'walker phone': 0, 'fight desktop': 0, 'fight phone': 0, 'glide phone': 0 };

describe('P54B T8: umístění podle kamery žánru', () => {
  for (const aspect of [DESKTOP, PHONE]) {
    for (const genre of GENRES) {
      const least = LEAST_IN_FRAME[`${genre.id} ${aspect < 1 ? 'phone' : 'desktop'}`] ?? 0.5;
      it(`${genre.id} ${aspect < 1 ? 'na výšku' : 'na šířku'}: bod v záběru (${least}), 25–60 m, 1,5–3×, za hrou a mimo hrací plochu`, () => {
        const look = LOOKS.forest;
        const camera = cameraOf(genre, aspect, look);
        const placed = placeLandmark({ camera, look, seed: 7, area: genre.area, hero: genre.hero, ground: genre.ground });
        expect(placed).not.toBeNull();
        const { id, x, y, z, scale } = placed!;
        const distance = Math.hypot(x - camera.position.x, z - camera.position.z);
        expect(distance).toBeGreaterThanOrEqual(LANDMARK_NEAR_M);
        expect(distance).toBeLessThanOrEqual(LANDMARK_FAR_M);
        expect(scale).toBeGreaterThanOrEqual(1.5);
        expect(scale).toBeLessThanOrEqual(3);
        const r = footOf(id, scale);
        expect(onArea(genre.area, x, z, r)).toBe(false);
        const rect = rectOf(camera, x, y, z, r, modelHeight(id) * scale);
        const hero = rectOf(camera, genre.hero.x, genre.hero.y, genre.hero.z, genre.hero.r, genre.hero.h);
        // Za hrou: celý bod je od kamery dál než hrdina.
        expect(rect.near).toBeGreaterThan(hero.far);
        expect(rect.far).toBeLessThan(look.fog[1]);
        expect(inFrame(rect)).toBeGreaterThanOrEqual(least);
      });
    }
  }

  it.each(LOOK_IDS)('%s: běžec na šířku i na výšku má bod v záběru před koncem mlhy', (lookId) => {
    const look = LOOKS[lookId];
    for (const aspect of [DESKTOP, PHONE]) {
      const camera = cameraOf(GENRES[0]!, aspect, look);
      const placed = placeLandmark({ camera, look, seed: 3, area: GENRES[0]!.area, hero: GENRES[0]!.hero });
      expect(placed).not.toBeNull();
      const rect = rectOf(camera, placed!.x, placed!.y, placed!.z, footOf(placed!.id, placed!.scale), modelHeight(placed!.id) * placed!.scale);
      expect(inFrame(rect)).toBeGreaterThanOrEqual(0.5);
      expect(rect.far).toBeLessThan(look.fog[1]);
    }
  });
});

describe('P54B T8: rámující kusy nezakryjí hrdinu', () => {
  for (const aspect of [DESKTOP, PHONE]) {
    for (const genre of GENRES) {
      it(`${genre.id} ${aspect < 1 ? 'na výšku' : 'na šířku'}: v popředí u kraje obrazu, mimo hrací plochu a kruh hrdiny`, () => {
        const look = LOOKS.castle;
        const camera = cameraOf(genre, aspect, look);
        const pieces = placeFraming({ camera, look, seed: 11, area: genre.area, hero: genre.hero, ground: genre.ground });
        expect(pieces.length).toBeLessThanOrEqual(2);
        const hero = rectOf(camera, genre.hero.x, genre.hero.y, genre.hero.z, genre.hero.r, genre.hero.h);
        for (const piece of pieces) {
          const r = footOf(piece.id, piece.scale);
          expect(onArea(genre.area, piece.x, piece.z, r)).toBe(false);
          expect(Math.hypot(piece.x - genre.hero.x, piece.z - genre.hero.z)).toBeGreaterThan(genre.hero.r + r);
          const rect = rectOf(camera, piece.x, piece.y, piece.z, r, modelHeight(piece.id) * piece.scale);
          expect(overlaps(rect, hero)).toBe(false);
          // Popředí: blíž kameře než hrdina; u kraje: kus obrazu, ne celý.
          expect((rect.near + rect.far) / 2).toBeLessThan(hero.near);
          expect(inFrame(rect)).toBeGreaterThan(0);
          expect(inFrame(rect)).toBeLessThan(1);
        }
      });
    }
  }

  it('aspoň polovina pevných kamer na šířku dostane rámující kus', () => {
    const framed = GENRES.filter((genre) => placeFraming({ camera: cameraOf(genre, DESKTOP, LOOKS.castle), look: LOOKS.castle, seed: 11, area: genre.area, hero: genre.hero, ground: genre.ground }).length > 0);
    expect(framed.length).toBeGreaterThanOrEqual(GENRES.length / 2);
  });
});

/**
 * P54B T15a: žánry, kde v T15 bod nebo rámující kus stál v obraze na hře (`judge.json`, telefon):
 * bod za trubkami poletování, na věži, nad pruhy rytmu, v místě přistání a pochodeň před soupeřem
 * v souboji. Hrací objemy jsou ty, které scéna předá nebo označí (`play`, `userData.frame`).
 */
interface PlayGenre extends Genre {
  readonly play: readonly Volume[];
}

const TIMING_TOP = (TIMING.baseH + 10 * TIMING.blockH) / UNIT;
const RIVAL_Z = 3;
const LANDER_PAD = { index: 0, x: 26, y: 0, z: 0, w: 12, h: 0.5, d: 12 } as const;

const PLAY_GENRES: readonly PlayGenre[] = [
  { ...GENRES.find((genre) => genre.id === 'flap')!, play: [{ x0: -1.5, y0: -0.4, z0: -Infinity, x1: 1.5, y1: FLAP.ceiling / UNIT, z1: Infinity }] },
  {
    // `TimingScene`: kamera před věží, výš na výšku; průsvitný sloupec tolerance (`frame = 'target'`) do výšky celé věže.
    id: 'timing',
    place: (camera, look) => {
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const dist = Math.max(10 / (2 * tan * camera.aspect), 7 / (2 * tan), 8);
      const y = TIMING.baseH / UNIT;
      camera.position.set(0, y + (camera.aspect < 1 ? 3.5 : 1.5), -dist);
      look.set(0, y, 0);
      camera.lookAt(look);
    },
    area: [{ x0: -(TIMING.amplitude / UNIT + 2), x1: TIMING.amplitude / UNIT + 2, z0: -2, z1: 2 }],
    hero: { x: 0, y: TIMING.baseH / UNIT, z: 0, r: 1.5, h: TIMING.blockH / UNIT },
    play: [{ x0: -1.5, y0: 0, z0: -0.6, x1: 1.5, y1: TIMING_TOP + 1, z1: -0.5 }],
  },
  {
    // `RhythmScene`: kamera za lištou, na výšku couvne a zvedne se; pruhy jedou 60 m do mlhy.
    id: 'rhythm',
    place: (camera, look) => {
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const back = Math.max(4.5, 4.8 / (2 * tan * camera.aspect) - 1);
      camera.position.set(0, 3.2 * (back / 4.5), -back);
      look.set(0, 0, 9);
      camera.lookAt(look);
    },
    area: [{ x0: -3, x1: 3, z0: -3, z1: 60 }],
    hero: { x: 0, y: 0, z: 0, r: 2, h: 0.3 },
    play: [{ x0: -2, y0: 0, z0: -2, x1: 2, y1: 0.5, z1: 60 }],
  },
  {
    // `DuelScene`: boční kamera na −x mezi rytíři; soupeř je `frame = 'target'`.
    id: 'duel',
    place: (camera, look) => {
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const dist = Math.max(6 / (2 * tan * camera.aspect), 3.2 / (2 * tan), 5);
      camera.position.set(-dist, 1.4, RIVAL_Z / 2);
      look.set(0, 1.1, RIVAL_Z / 2);
      camera.lookAt(look);
    },
    area: [{ x0: -2, x1: 2, z0: RIVAL_Z / 2 - 4.5, z1: RIVAL_Z / 2 + 4.5 }],
    hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.6 },
    play: [{ x0: -0.6, y0: 0, z0: RIVAL_Z - 0.6, x1: 0.6, y1: 1.8, z1: RIVAL_Z + 0.6 }],
  },
  {
    // Přistání (`placeLander`): loď 50 m nad zemí, plocha 26 m do strany; koridor od lodi na plochu.
    id: 'lander',
    place: (camera, look) => placeLander(camera, look, 0, 50, 0, LANDER_PAD, 3),
    area: [{ x0: -7.5, x1: 7.5, ...ALL_Z }],
    hero: { x: 0, y: 50, z: 0, r: 1, h: 3 },
    play: [{ x0: -1, y0: 0, z0: -6, x1: 32, y1: 53, z1: 6 }],
  },
];

/**
 * Obdélník kvádru mezi blízkou rovinou kamery a koncem mlhy – nezávisle na `volumeRect`: hustě
 * navzorkované hrany, nekonečná osa utnutá daleko za mlhou. Vzorky obdélník nanejvýš o kousek zmenší.
 */
function clippedRect(camera: PerspectiveCamera, volume: Volume, far: number): Omit<Rect, 'near' | 'far'> | null {
  const cut = (value: number, at: number): number => Math.max(at - 5 * far, Math.min(at + 5 * far, value));
  const lo = [cut(volume.x0, camera.position.x), cut(volume.y0, camera.position.y), cut(volume.z0, camera.position.z)];
  const hi = [cut(volume.x1, camera.position.x), cut(volume.y1, camera.position.y), cut(volume.z1, camera.position.z)];
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let axis = 0; axis < 3; axis += 1) {
    for (let corner = 0; corner < 4; corner += 1) {
      for (let step = 0; step <= 2000; step += 1) {
        const point = [0, 1, 2].map((other, k) => (other === axis ? lo[other]! + ((hi[other]! - lo[other]!) * step) / 2000 : (corner >> (k > axis ? k - 1 : k)) & 1 ? hi[other]! : lo[other]!));
        const at = new Vector3(point[0], point[1], point[2]);
        const depth = -at.clone().applyMatrix4(camera.matrixWorldInverse).z;
        if (depth < camera.near || depth > far) continue;
        at.project(camera);
        [minX, maxX, minY, maxY] = [Math.min(minX, at.x), Math.max(maxX, at.x), Math.min(minY, at.y), Math.max(maxY, at.y)];
      }
    }
  }
  return minX > maxX ? null : { minX, maxX, minY, maxY };
}

const heroVolume = (hero: HeroBox): Volume => ({ x0: hero.x - hero.r, y0: hero.y, z0: hero.z - hero.r, x1: hero.x + hero.r, y1: hero.y + hero.h, z1: hero.z + hero.r });

describe('P54B T15a: bod ani rámující kus se v obraze nepotká s hrou', () => {
  for (const aspect of [DESKTOP, PHONE]) {
    for (const genre of PLAY_GENRES) {
      it(`${genre.id} ${aspect < 1 ? 'na výšku' : 'na šířku'}: ani bod, ani kus nezakryje hrdinu, soupeře ani hrací pás`, () => {
        for (const lookId of ['forest', 'castle', 'jungle', 'meadow', 'city', 'desert'] as const) {
          const look = LOOKS[lookId];
          const camera = cameraOf(genre, aspect, look);
          const blocks = [...genre.play, heroVolume(genre.hero)].map((volume) => clippedRect(camera, volume, look.fog[1])).filter((rect) => rect !== null);
          for (const seed of [7, 11]) {
            const input = { camera, look, seed, area: genre.area, hero: genre.hero, play: genre.play, ground: genre.ground };
            const landmark = placeLandmark(input);
            const pieces = placeFraming(input);
            for (const placed of [...(landmark === null ? [] : [landmark]), ...pieces]) {
              const rect = rectOf(camera, placed.x, placed.y, placed.z, footOf(placed.id, placed.scale), modelHeight(placed.id) * placed.scale);
              for (const block of blocks) expect(overlaps(rect, block), `${lookId} ${seed} ${placed.id}`).toBe(false);
            }
          }
        }
      });
    }
  }

  it('bez hracích objemů by bod zakryl hru – scény T15 chybu opravdu ukážou', () => {
    // Na výšku bod poletování stál za trubkami a na věži; tytéž kamery bez `play` to zopakují.
    const hits = PLAY_GENRES.filter((genre) => {
      const look = LOOKS.jungle;
      const camera = cameraOf(genre, PHONE, look);
      const placed = placeLandmark({ camera, look, seed: 7, area: genre.area, hero: genre.hero, ground: genre.ground });
      if (placed === null) return false;
      const rect = rectOf(camera, placed.x, placed.y, placed.z, footOf(placed.id, placed.scale), modelHeight(placed.id) * placed.scale);
      return genre.play.some((volume) => {
        const block = clippedRect(camera, volume, look.fog[1]);
        return block !== null && overlaps(rect, block);
      });
    });
    expect(hits.map((genre) => genre.id)).toEqual(expect.arrayContaining(['flap', 'timing']));
  });
});

it.each(['forest', 'meadow', 'castle', 'underwater'] as const)('%s: aréna 40 × 40 m pod kamerou 40° vybere kandidáta, který se do proužku za hranou vejde', (lookId) => {
  // Hrdina uprostřed, kamera 12 m od něj (`StyledWorld`): za stěnou je vidět jen pár metrů země u horního kraje.
  const genre: Genre = { id: 'big-arena', place: arenaCamera(40, 12), area: [{ x0: -21.5, x1: 21.5, z0: -21.5, z1: 21.5 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.3 } };
  const look = LOOKS[lookId];
  const camera = cameraOf(genre, DESKTOP, look);
  for (const seed of [1, 2, 3]) {
    const placed = placeLandmark({ camera, look, seed, area: genre.area, hero: genre.hero })!;
    expect(look.landmark).toContain(placed.id);
    expect(inFrame(rectOf(camera, placed.x, placed.y, placed.z, footOf(placed.id, placed.scale), modelHeight(placed.id) * placed.scale))).toBeGreaterThanOrEqual(0.5);
  }
});

describe('P54B T8: bod, který jede s kamerou nad plochou, na ni nevjede', () => {
  const arena: readonly Box[] = [{ x0: -12, x1: 12, z0: -12, z1: 12 }];

  it('vysune se k nejbližšímu kraji s odstupem, mimo plochu zůstane, kde je', () => {
    expect(keepOff(arena, 3, 10, 2)).toEqual({ x: 3, z: 15 });
    expect(keepOff(arena, -11, 0, 2)).toEqual({ x: -15, z: 0 });
    expect(keepOff(arena, 0, 20, 2)).toEqual({ x: 0, z: 20 });
  });

  it('pás trati bez konce se opouští jen do strany', () => {
    expect(keepOff([{ x0: -4, x1: 4, ...ALL_Z }], 1, 40, 2)).toEqual({ x: 7, z: 40 });
  });

  it('kamera arény, která jede za hrdinou, vozí bod pořád mimo plochu', () => {
    const look = LOOKS.castle;
    const camera = cameraOf(GENRES.find((genre) => genre.id === 'arena')!, DESKTOP, look);
    const placed = placeLandmark({ camera, look, seed: 5, area: arena, hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.3 } })!;
    for (const [dx, dz] of [[0, -10], [9, -9], [-9, 4], [0, 9]] as const) {
      const r = footOf(placed.id, placed.scale);
      const at = keepOff(arena, placed.x + dx, placed.z + dz, r);
      expect(onArea(arena, at.x, at.z, r)).toBe(false);
    }
  });
});

describe('P54B T8: herní kamera bez průletu', () => {
  it.each([1, 0.5, -0.03])('průlet %s se vrátí na herní pohled', (left) => {
    const camera = new PerspectiveCamera(60, DESKTOP, 0.1, 70);
    const look = new Vector3();
    placeBall(camera, look);
    camera.updateMatrixWorld();
    const position = camera.position.clone();
    const direction = camera.getWorldDirection(new Vector3());
    applyIntro(camera, look, left);
    const rest = restCamera(camera, new PerspectiveCamera());
    expect(rest.position.distanceTo(position)).toBeLessThan(1e-6);
    expect(rest.getWorldDirection(new Vector3()).distanceTo(direction)).toBeLessThan(1e-6);
    expect(rest.aspect).toBe(camera.aspect);
  });

  it('kamera bez průletu zůstane, jak je', () => {
    const camera = new PerspectiveCamera(60, PHONE, 0.1, 70);
    camera.position.set(1, 2, 3);
    camera.lookAt(0, 0, 10);
    camera.updateMatrixWorld();
    expect(restCamera(camera, new PerspectiveCamera()).position.toArray()).toEqual([1, 2, 3]);
  });
});
