/**
 * Život v pozadí sady (P54B T10). Pinuje se, co z obrazu nikdo nepozná: hejno, které krouží
 * mimo záběr, za mlhou, na hrací ploše nebo uvnitř orientačního bodu, se nikde neprojeví
 * chybou – scéna vypadá jako dřív. Umístění se staví skutečnými kamerami žánrů na šířku
 * (1280 × 800) i na výšku (Pixel 7) kolem bodu z `placeLandmark` a promítá se nezávisle
 * na kódu, který místa hledal.
 */

import { InstancedMesh, PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { type AmbientKind, LOOK_IDS, type LookId, LOOKS } from '@/play/arcade/look';
import { FLAP } from '@/play/arcade/pieces/flap';
import { GLIDE } from '@/play/arcade/pieces/glide';
import { PLATFORM } from '@/play/arcade/pieces/platform';

import { isPurple } from '../../../../../../scripts/assets/cc0/palette.mjs';
import { placeBall } from '../../ball/camera';
import { placeGlide } from '../../glide/camera';
import { placeChase } from '../../steer/SteerScene';
import { placeAngled, placePlatform, placeRunner, placeSide } from '../../track-camera';
import { placeWalker } from '../../walker/view';
import { LIFE, lifeCount, lifeMesh, placeLife, tickLife } from '../Ambient';
import type { Box } from '../ground';
import { footOf, type HeroBox, placeLandmark } from '../landmark-places';
import { PLAYABLE_HALF } from '../rig/terrain/valley';

const DESKTOP = 1280 / 800;
const PHONE = 412 / 915;
const DEG = Math.PI / 180;
const ALL_Z = { z0: -Infinity, z1: Infinity } as const;
/** Kruh hrdiny (`HERO_KEEP_M` v `landmark-places.ts`). */
const HERO_KEEP_M = 2;

/** Zadání úkolu: kdo kde žije. */
const EXPECTED: Readonly<Record<LookId, readonly AmbientKind[]>> = {
  meadow: ['birds', 'butterflies'],
  city: [],
  mall: ['dust'],
  supermarket: ['dust'],
  living_room: ['dust'],
  factory: ['dust'],
  forest: ['birds'],
  jungle: ['butterflies'],
  desert: [],
  beach: ['birds'],
  ocean: ['jumping-fish'],
  underwater: ['fish'],
  snow: [],
  volcano: ['sparks'],
  cave: ['bats'],
  space: ['meteors'],
  castle: ['birds'],
  graveyard: ['bats'],
};

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

/** Kamery a plochy žánrů jako v `p54b-landmark.test.ts`. */
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
  { id: 'walker', place: (camera, look) => placeWalker(camera, look, 0, 0), area: [{ x0: -34, x1: 2, z0: -2, z1: 34 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.4 } },
  { id: 'ball', place: (camera, look) => placeBall(camera, look), area: [{ x0: -8, x1: 8, z0: -3, z1: 22 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.4 } },
  { id: 'steer', place: (camera, look) => placeChase(camera, look, 0, 0, 0), area: [{ x0: -5, x1: 5, ...ALL_Z }], hero: { x: 0, y: 0, z: 0, r: 1, h: 1.5 } },
  { id: 'arena', place: arenaCamera(40, 16), area: [{ x0: -12, x1: 12, z0: -12, z1: 12 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.3 } },
  { id: 'fight', place: arenaCamera(60, 14), area: [{ x0: -9, x1: 9, z0: -9, z1: 9 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.6 } },
  { id: 'throw', place: throwCamera, area: [{ x0: -2, x1: 2, z0: -3, z1: 27 }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.4 } },
];

/**
 * Kde orientační bod v záběru není, není tam ani život kolem něj (`p54b-landmark.test.ts`,
 * `LEAST_IN_FRAME`): bludiště a souboj koukají strmě dolů a zem 25 m od kamery leží na horním
 * kraji obrazu nebo nad ním, poletování na výšku má úzký obraz nad koridorem letu.
 */
const OUT_OF_VIEW: ReadonlySet<string> = new Set(['walker desktop', 'walker phone', 'fight desktop', 'fight phone', 'glide phone']);

function cameraOf(genre: Genre, aspect: number, fogFar: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, aspect, 0.1, fogFar);
  genre.place(camera, new Vector3());
  camera.updateMatrixWorld();
  return camera;
}

/** Bod promítnutý kamerou: NDC a hloubka před ní (m). */
function seen(camera: PerspectiveCamera, x: number, y: number, z: number): { readonly x: number; readonly y: number; readonly depth: number } {
  const depth = -new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).z;
  const ndc = new Vector3(x, y, z).project(camera);
  return { x: ndc.x, y: ndc.y, depth };
}

/** Nejvzdálenější roh kvádru hrdiny od kamery (m). */
function heroFar(camera: PerspectiveCamera, hero: HeroBox): number {
  let far = -Infinity;
  for (let i = 0; i < 8; i += 1) {
    const corner = new Vector3(hero.x + (i & 1 ? hero.r : -hero.r), i & 2 ? hero.y + hero.h : hero.y, hero.z + (i & 4 ? hero.r : -hero.r));
    far = Math.max(far, -corner.applyMatrix4(camera.matrixWorldInverse).z);
  }
  return far;
}

const onArea = (area: readonly Box[], x: number, z: number, r: number): boolean => area.some((box) => x + r > box.x0 && x - r < box.x1 && z + r > box.z0 && z - r < box.z1);
const LIVING = LOOK_IDS.filter((id) => LOOKS[id].ambient.length > 0);

function stubPage(search: string, reduce: boolean): void {
  vi.stubGlobal('window', { location: { search }, matchMedia: () => ({ matches: reduce }) });
}

afterEach(() => vi.unstubAllGlobals());

describe('P54B T10: kdo v sadě žije', () => {
  it.each(LOOK_IDS)('%s', (id) => {
    expect(LOOKS[id].ambient).toEqual(EXPECTED[id]);
  });

  it('barvy života nejsou fialové', () => {
    for (const [kind, spec] of Object.entries(LIFE)) {
      for (const hex of spec.colours) {
        const srgb = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
        expect(isPurple(srgb), `${kind} ${hex}`).toBe(false);
      }
    }
  });
});

describe('P54B T10: počet kusů a kreslicí volání', () => {
  it.each(LIVING)('%s: nejvýš 3 sítě navíc, žádná nevrhá stín, `low` kreslí polovinu', (id) => {
    const clock = { value: 0 };
    const meshes = LOOKS[id].ambient.map((kind) => lifeMesh(kind, clock));
    expect(meshes.length).toBeGreaterThan(0);
    expect(meshes.length).toBeLessThanOrEqual(3);
    for (const [index, mesh] of meshes.entries()) {
      const kind = LOOKS[id].ambient[index]!;
      expect(mesh).toBeInstanceOf(InstancedMesh);
      // Stínový průchod by síť kreslil znovu; rig stínů (`ShadowFlags`) značku nepřepíše.
      expect(mesh.castShadow).toBe(false);
      expect(mesh.userData.rigShadow).toBeDefined();
      expect(mesh.instanceMatrix.count).toBe(lifeCount(kind, 'high'));
      expect(lifeCount(kind, 'medium')).toBe(lifeCount(kind, 'high'));
      expect(lifeCount(kind, 'low') * 2).toBe(lifeCount(kind, 'high'));
      expect(lifeCount(kind, 'low')).toBeGreaterThanOrEqual(2);
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
    }
  });
});

describe('P54B T10: hodiny kresby a omezený pohyb', () => {
  it('pohyb jde z času kresby; při prefers-reduced-motion i ?toy=off stojí', () => {
    stubPage('', false);
    expect(tickLife(2, 0.25)).toBe(2.25);
    stubPage('', true);
    expect(tickLife(2, 0.25)).toBe(2);
    stubPage('?toy=off', false);
    expect(tickLife(2, 0.25)).toBe(2);
  });

  it('materiál bere čas z jedné sdílené uniformy', () => {
    const clock = { value: 3 };
    const mesh = lifeMesh('birds', clock);
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '' };
    (mesh.material as unknown as { onBeforeCompile(shader: unknown): void }).onBeforeCompile(shader);
    expect(shader.uniforms.lifeTime).toBe(clock);
    expect(shader.vertexShader).toContain('uniform float lifeTime;');
    expect(shader.vertexShader).toContain('transformed = ');
  });
});

describe('P54B T10: život je v záběru, mimo hrací plochu a mimo kruh hrdiny', () => {
  for (const aspect of [DESKTOP, PHONE]) {
    for (const genre of GENRES) {
      const view = `${genre.id} ${aspect < 1 ? 'phone' : 'desktop'}`;
      it(`${view}: kolem orientačního bodu, za hrdinou, před koncem mlhy`, () => {
        for (const lookId of LIVING) {
          const look = LOOKS[lookId];
          const camera = cameraOf(genre, aspect, look.fog[1]);
          const landmark = placeLandmark({ camera, look, seed: 7, area: genre.area, hero: genre.hero, ground: genre.ground })!;
          const column = footOf(landmark);
          const far = heroFar(camera, genre.hero);
          for (const kind of look.ambient) {
            const lives = placeLife({ camera, foot: landmark, id: landmark.id, scale: landmark.scale, kind });
            expect(lives).toHaveLength(lifeCount(kind, 'high'));
            let inView = 0;
            for (const life of lives) {
              const at = { x: landmark.x + life.x, y: landmark.y + life.y, z: landmark.z + life.z };
              const label = `${view} ${lookId} ${kind}`;
              // Celý rozkmit (dráha i tělo) zůstane v patě bodu, kterou T8 drží mimo plochu i kruh hrdiny.
              expect(Math.hypot(life.x, life.z) + life.reach, label).toBeLessThanOrEqual(column + 1e-9);
              expect(onArea(genre.area, at.x, at.z, life.reach), label).toBe(false);
              expect(Math.hypot(at.x - genre.hero.x, at.z - genre.hero.z) - life.reach, label).toBeGreaterThanOrEqual(genre.hero.r + HERO_KEEP_M - 1e-9);
              const point = seen(camera, at.x, at.y, at.z);
              // Za hrou a před koncem mlhy (tam končí i kamera, `FarAtFog`).
              expect(point.depth, label).toBeGreaterThan(far);
              expect(point.depth, label).toBeLessThan(look.fog[1]);
              if (Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1) inView += 1;
            }
            if (!OUT_OF_VIEW.has(view)) expect(inView / lives.length, `${view} ${lookId} ${kind} v záběru`).toBeGreaterThanOrEqual(0.9);
            // Nízký život (motýli, ryby, prach) má kotvu v půlce paty u kamery: před bodem, ne schovaný za ním.
            if (LIFE[kind].front) {
              const toward = new Vector3(camera.position.x - landmark.x, 0, camera.position.z - landmark.z).normalize();
              for (const life of lives) expect(life.x * toward.x + life.z * toward.z, `${view} ${lookId} ${kind}`).toBeGreaterThan(0);
            }
            // Celým rozkmitem nad patou bodu, ne v zemi; jen ryba skáče z hladiny a zase pod ni.
            if (kind !== 'jumping-fish') for (const life of lives) expect(life.y - life.down, `${view} ${lookId} ${kind}`).toBeGreaterThanOrEqual(-1e-9);
          }
        }
      });
    }
  }

  it('na `low` je v záběru i první polovina kusů, kterou úroveň kreslí', () => {
    const look = LOOKS.meadow;
    const camera = cameraOf(GENRES[0]!, PHONE, look.fog[1]);
    const landmark = placeLandmark({ camera, look, seed: 3, area: GENRES[0]!.area, hero: GENRES[0]!.hero })!;
    const lives = placeLife({ camera, foot: landmark, id: landmark.id, scale: landmark.scale, kind: 'birds' }).slice(0, lifeCount('birds', 'low'));
    for (const life of lives) {
      const point = seen(camera, landmark.x + life.x, landmark.y + life.y, landmark.z + life.z);
      expect(Math.max(Math.abs(point.x), Math.abs(point.y))).toBeLessThanOrEqual(1);
    }
  });

  it('totéž místo dá totéž rozmístění (stream pure-rand, žádná náhoda z běhu)', () => {
    const look = LOOKS.castle;
    const camera = cameraOf(GENRES[0]!, DESKTOP, look.fog[1]);
    const landmark = placeLandmark({ camera, look, seed: 5, area: GENRES[0]!.area, hero: GENRES[0]!.hero })!;
    const input = { camera, foot: landmark, id: landmark.id, scale: landmark.scale, kind: 'birds' as const };
    expect(placeLife(input)).toEqual(placeLife(input));
  });
});
