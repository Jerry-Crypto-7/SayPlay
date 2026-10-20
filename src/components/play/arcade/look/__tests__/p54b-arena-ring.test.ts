/**
 * Prstenec kusů sady mezi hrací plochou a stěnou a rohové shluky v popředí kamery
 * (P54B T9). Pinuje se, co na snímku vypadá dobře a přitom je špatně: kus na hrací
 * ploše nebo v kruhu `keep` je pro hráče překážka, o které jádro neví (hrdina jím
 * projde), a druh navíc je kreslicí volání navíc, které na snímku nikdo nespočítá.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { BoxGeometry, Matrix4, MeshStandardMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import catalog from '@/assets/catalog-index.json';
import { UNIT } from '@/play/arcade/contract';
import { LOOK_IDS, LOOKS } from '@/play/arcade/look';
import { ARENA } from '@/play/arcade/pieces/arena';

import { isPurple, toSrgb } from '../../../../../../scripts/assets/cc0/palette.mjs';
import { arenaDecorPlaces, arenaRingPlaces, arenaRingPool, RING_KINDS, RING_LOWEST, RING_TALLEST, ringKindsOf, ringMesh } from '../rig/terrain/arenaDecor';
import { ARENA_WALL_GAP } from '../rig/terrain/arenaFloor';

const PUBLIC = join(__dirname, '..', '..', '..', '..', '..', '..', 'public');
const PATHS: ReadonlyMap<string, string> = new Map(catalog.assets.map((asset) => [asset.assetId, asset.path]));

const half = ARENA.half / UNIT;
/**
 * Těla na startu: hrdina uprostřed a věci u hrany a v předním rohu – jejich kruh
 * přesahuje za hranu, kam prstenec i shluky sahají. Uvnitř plochy by kontrola nic nezkoušela.
 */
const keep = [
  { x: 0, z: 0, r: 1.2 },
  { x: half - 0.4, z: 3, r: 1.6 },
  { x: -(half - 0.3), z: -(half - 0.3), r: 2.5 },
  { x: 2, z: half - 0.5, r: 1.4 },
];
const SEEDS = [1, 7, 2024, 987654321];

/** Vzdálenost bodu od hrací plochy (čtverec ±`half`); na ploše 0. */
const offFloor = (x: number, z: number): number => Math.hypot(Math.max(0, Math.abs(x) - half), Math.max(0, Math.abs(z) - half));

const placesOf = (id: (typeof LOOK_IDS)[number], seed: number) => arenaRingPlaces({ look: LOOKS[id], half, seed, keep });

describe('P54B T9: prstenec a rohy arény', () => {
  it('nic na hrací ploše ani v kruhu keep; kus je vysoký 0,5–2 m', () => {
    for (const id of LOOK_IDS) {
      for (const seed of SEEDS) {
        const pieces = placesOf(id, seed);
        expect(pieces.length, `${id} ${seed}`).toBeGreaterThan(20);
        for (const piece of pieces) {
          const name = `${id} ${seed} ${piece.id} (${piece.x.toFixed(2)}, ${piece.z.toFixed(2)})`;
          // Celý půdorys (kružnice opsaná modelu) leží mimo plochu, ne jen střed.
          expect(offFloor(piece.x, piece.z), `${name} on the floor`).toBeGreaterThanOrEqual(piece.reach - 1e-9);
          for (const spot of keep) expect(Math.hypot(piece.x - spot.x, piece.z - spot.z), `${name} in keep`).toBeGreaterThanOrEqual(spot.r + piece.reach - 1e-9);
          expect(piece.height, name).toBeGreaterThanOrEqual(RING_LOWEST - 1e-9);
          expect(piece.height, name).toBeLessThanOrEqual(RING_TALLEST + 1e-9);
        }
      }
    }
  });

  it('prstenec stojí mezi hranou a stěnou po stranách a vzadu; na straně kamery (−z) ne', () => {
    for (const id of LOOK_IDS) {
      const ring = placesOf(id, 7).filter((piece) => piece.cluster === null);
      expect(ring.length, id).toBeGreaterThan(15);
      for (const piece of ring) {
        // Střed v mezeře před stěnou; kus širší než mezera stojí těsně u hrany a zády se opře o stěnu.
        expect(offFloor(piece.x, piece.z), `${id} ${piece.id}`).toBeLessThanOrEqual(Math.max(piece.reach, ARENA_WALL_GAP) + 1e-9);
        expect(piece.z, `${id} ${piece.id} on the camera side`).toBeGreaterThanOrEqual(-half);
      }
      for (const side of ['-x', '+x', '+z'] as const) {
        const on = ring.filter((piece) => (side === '+z' ? piece.z > half : side === '+x' ? piece.x > half : piece.x < -half));
        expect(on.length, `${id} ${side}`).toBeGreaterThan(4);
      }
    }
  });

  it('2–4 rohové shluky po 2–5 kusech u obou předních rohů, v popředí kamery', () => {
    const counts = new Set<number>();
    for (const id of LOOK_IDS) {
      for (const seed of SEEDS) {
        const clusters = new Map<number, ReturnType<typeof placesOf>>();
        for (const piece of placesOf(id, seed)) if (piece.cluster !== null) clusters.set(piece.cluster, [...(clusters.get(piece.cluster) ?? []), piece]);
        expect(clusters.size, `${id} ${seed}`).toBeGreaterThanOrEqual(2);
        expect(clusters.size, `${id} ${seed}`).toBeLessThanOrEqual(4);
        counts.add(clusters.size);
        const sides = new Set<number>();
        for (const pieces of clusters.values()) {
          expect(pieces.length, `${id} ${seed}`).toBeGreaterThanOrEqual(2);
          expect(pieces.length, `${id} ${seed}`).toBeLessThanOrEqual(5);
          for (const piece of pieces) {
            // Přední roh: blíž kameře než přední hrana (+ kus u boční stěny u ní) a u boční hrany.
            expect(piece.z, `${id} ${seed} ${piece.id}`).toBeLessThan(-half + 2.5);
            expect(Math.abs(piece.x), `${id} ${seed} ${piece.id}`).toBeGreaterThan(half - 2.5);
          }
          sides.add(Math.sign(pieces[0]!.x));
        }
        expect([...sides].sort(), `${id} ${seed}: both front corners`).toEqual([-1, 1]);
      }
    }
    // Počet shluků jde ze semínka – jinak by „2–4“ bylo vždy 2.
    expect(counts.size).toBeGreaterThan(1);
  });

  it('stejné semínko = stejná výzdoba, jiné semínko = jiná', () => {
    for (const id of LOOK_IDS) {
      const a = placesOf(id, 7);
      expect(placesOf(id, 7), id).toEqual(a);
      expect(placesOf(id, 8), id).not.toEqual(a);
    }
  });

  it('nejvýš 6 druhů = nejvýš 6 kreslicích volání navíc; s výzdobou podlahy ≥ 8 odlišných modelů', () => {
    const box = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial();
    const matrix = new Matrix4();
    const at = new Vector3();
    for (const id of LOOK_IDS) {
      for (const seed of SEEDS) {
        const pieces = placesOf(id, seed);
        const kinds = ringKindsOf(pieces);
        // Scéna staví na druh jednu instancovanou síť, která stín nevrhá: druh = jedno volání.
        const meshes = [...kinds].map(([, list]) => ringMesh(list, box, material));
        expect(meshes.length, `${id} ${seed}`).toBeLessThanOrEqual(RING_KINDS);
        expect(meshes.reduce((sum, mesh) => sum + mesh.count, 0)).toBe(pieces.length);
        for (const mesh of meshes) expect(mesh.castShadow).toBe(false);
        // Instance stojí tam, kde ji místo hlídalo: pata na zemi v (x, z), měřítko = výška.
        const [first] = [...kinds.values()];
        meshes[0]!.getMatrixAt(0, matrix);
        at.setFromMatrixPosition(matrix);
        expect(at.x).toBeCloseTo(first![0]!.x, 4);
        expect(at.y).toBe(0);
        expect(at.z).toBeCloseTo(first![0]!.z, 4);
        expect(at.setFromMatrixScale(matrix).y).toBeCloseTo(first![0]!.height, 5);
        const floor = new Set(arenaDecorPlaces({ look: LOOKS[id], half, seed, keep }).map((place) => place.kind));
        expect(floor.size + kinds.size, `${id} ${seed}: distinct decor models`).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('každý model prstence je v katalogu, má GLB v public/ a žádný fialový vrchol', async () => {
    const ids = [...new Set(LOOK_IDS.flatMap((id) => arenaRingPool(LOOKS[id])))];
    expect(ids.filter((id) => !PATHS.has(id))).toEqual([]);
    expect(ids.filter((id) => !existsSync(join(PUBLIC, PATHS.get(id)!)))).toEqual([]);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const purple: string[] = [];
    for (const id of ids) {
      const doc = await io.read(join(PUBLIC, PATHS.get(id)!));
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const factor = primitive.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1];
          const colour = primitive.getAttribute('COLOR_0');
          const count = primitive.getAttribute('POSITION')!.getCount();
          for (let i = 0; i < count; i += 1) {
            const linear = colour === null ? [1, 1, 1] : colour.getElement(i, []);
            if (isPurple(toSrgb([linear[0]! * factor[0]!, linear[1]! * factor[1]!, linear[2]! * factor[2]!]))) {
              purple.push(`${id} vrchol ${i}`);
              break;
            }
          }
        }
      }
    }
    expect(purple).toEqual([]);
  }, 90_000);
});
