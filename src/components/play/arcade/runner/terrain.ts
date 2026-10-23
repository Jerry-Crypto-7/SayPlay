/**
 * Terén běžce: údolí a pás cesty ohnuté po křivce trati. Stavba stojí na telefonu
 * ~0,5 s (mikro běžec řetězu má trať 446 m – 65 892 vrcholů údolí, z nichž 6s kolo
 * uvidí ~150 m), takže řetěz ji pustí ve workeru dřív, než na kolo běžce dojde
 * (`prebuildRunnerTerrain`), a scéna kola si vezme hotová pole (`prebuiltRunnerTerrain`,
 * P56C T18). Bez nich staví scéna synchronně jako dřív – jedna hra se nemění.
 */

import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';

import { type ArcadeWorld, UNIT } from '@/play/arcade/contract';
import { type Look, SURFACES } from '@/play/arcade/look';

import { buildValley, PATH_HALF, type Valley, valleyHeightAt } from '../look/rig/terrain/valley';
import { type RoadGeometry, roadGeometry } from '../look/road-strip';
import { type Path, type PathSpan, bendGeometry, levelSpansOf, pathOf, runnerPathOf } from './path';

/** Údolí začíná za kamerou úvodního záběru a končí za koncem mlhy po cíli. */
export const BEHIND_M = 40;

/** Konec údolí a cesty (m): za koncem mlhy po cíli. */
export const terrainEnd = (look: Look, length: number): number => length + look.fog[1] + 10;

export interface RunnerTerrain {
  readonly valley: Valley;
  readonly lane: Pick<RoadGeometry, 'surface' | 'edges' | 'marks'> | null;
}

/** Údolí ohnuté po křivce trati (P46D T3) a cesta jako jeden pás s hladkými okraji (P46G T2). */
export function buildRunnerTerrain(look: Look, length: number, path: Path | null): RunnerTerrain & { readonly heights: Float32Array } {
  const to = terrainEnd(look, length);
  const valley = buildValley({ look, from: -BEHIND_M, to });
  if (path !== null) bendGeometry(valley.geometry, path);
  const lane = roadGeometry([{ near: -BEHIND_M, far: to, center: 0, width: 2 * PATH_HALF }], SURFACES[look.surface]);
  if (lane !== null && path !== null) for (const geometry of [lane.surface, lane.edges, lane.marks]) if (geometry !== null) bendGeometry(geometry, path);
  return { valley, heights: valley.heights, lane: lane === null ? null : { surface: lane.surface, edges: lane.edges, marks: lane.marks } };
}

interface PackedGeometry {
  readonly attributes: Readonly<Record<string, { readonly array: Float32Array; readonly itemSize: number; readonly normalized: boolean }>>;
  readonly index: Uint16Array | Uint32Array | null;
  /** Střed a poloměr obalové koule, rohy obalového kvádru: hlavní vlákno je znovu nepočítá. */
  readonly sphere: readonly [number, number, number, number];
  readonly box: readonly [number, number, number, number, number, number];
}

export interface PackedTerrain {
  readonly valley: PackedGeometry;
  readonly heights: Float32Array;
  readonly lane: { readonly surface: PackedGeometry; readonly edges: PackedGeometry; readonly marks: PackedGeometry | null } | null;
}

function pack(geometry: BufferGeometry): PackedGeometry {
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const { center, radius } = geometry.boundingSphere!;
  const { min, max } = geometry.boundingBox!;
  return {
    attributes: Object.fromEntries(
      Object.entries(geometry.attributes).map(([name, attribute]) => [name, { array: attribute.array as Float32Array, itemSize: attribute.itemSize, normalized: attribute.normalized }]),
    ),
    index: geometry.index === null ? null : (geometry.index.array as Uint16Array | Uint32Array),
    sphere: [center.x, center.y, center.z, radius],
    box: [min.x, min.y, min.z, max.x, max.y, max.z],
  };
}

function unpack(packed: PackedGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, { array, itemSize, normalized }] of Object.entries(packed.attributes)) geometry.setAttribute(name, new BufferAttribute(array, itemSize, normalized));
  if (packed.index !== null) geometry.setIndex(new BufferAttribute(packed.index, 1));
  const [x, y, z, radius] = packed.sphere;
  const [x0, y0, z0, x1, y1, z1] = packed.box;
  geometry.boundingSphere = new Sphere(new Vector3(x, y, z), radius);
  geometry.boundingBox = new Box3(new Vector3(x0, y0, z0), new Vector3(x1, y1, z1));
  return geometry;
}

export function packTerrain(built: ReturnType<typeof buildRunnerTerrain>): PackedTerrain {
  const { lane } = built;
  return {
    valley: pack(built.valley.geometry),
    heights: built.heights,
    lane: lane === null ? null : { surface: pack(lane.surface), edges: pack(lane.edges), marks: lane.marks === null ? null : pack(lane.marks) },
  };
}

/** Pole, která worker předá bez kopie (`postMessage` s přenosem). */
export function transferablesOf(packed: PackedTerrain): ArrayBuffer[] {
  const geometries = [packed.valley, packed.lane?.surface, packed.lane?.edges, packed.lane?.marks].filter((geometry): geometry is PackedGeometry => geometry != null);
  const arrays = [packed.heights, ...geometries.flatMap((geometry) => [...Object.values(geometry.attributes).map((attribute) => attribute.array), ...(geometry.index === null ? [] : [geometry.index])])];
  return [...new Set(arrays.map((array) => array.buffer as ArrayBuffer))];
}

export function unpackTerrain(packed: PackedTerrain, look: Look, length: number): RunnerTerrain {
  const { lane } = packed;
  return {
    valley: { geometry: unpack(packed.valley), heightAt: valleyHeightAt(-BEHIND_M, terrainEnd(look, length), packed.heights) },
    lane: lane === null ? null : { surface: unpack(lane.surface), edges: unpack(lane.edges), marks: lane.marks === null ? null : unpack(lane.marks) },
  };
}

export interface TerrainJob {
  readonly id: number;
  readonly look: Look;
  readonly length: number;
  readonly seed: number;
  readonly spans: readonly PathSpan[];
}

export type TerrainReply = { readonly id: number; readonly terrain: PackedTerrain } | { readonly id: number; readonly error: string };

/** Tělo workeru: táž stavba jako na hlavním vlákně, křivka ze semínka a mostů světa (`runnerPathOf`). */
export function runTerrainJob(job: TerrainJob): TerrainReply {
  try {
    return { id: job.id, terrain: packTerrain(buildRunnerTerrain(job.look, job.length, pathOf(job.seed, job.spans))) };
  } catch (thrown) {
    return { id: job.id, error: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}

interface Prebuilt {
  /** Sada a délka, pro které worker stavěl: scéna s jinou sadou staví sama. */
  readonly key: string;
  terrain: PackedTerrain | null;
}

const prebuilt = new WeakMap<ArcadeWorld, Prebuilt>();
const jobs = new Map<number, Prebuilt>();
let nextJob = 0;
let worker: Worker | null = null;

const keyOf = (look: Look, length: number): string => `${length}|${JSON.stringify(look)}`;

function terrainWorker(): Worker {
  if (worker !== null) return worker;
  // `new URL(..., import.meta.url)` webpack pozná a worker zabalí (vzor `feed/preview.ts`).
  const created = new Worker(new URL('./terrain-worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<TerrainReply>) => {
    const entry = jobs.get(event.data.id);
    jobs.delete(event.data.id);
    if (entry !== undefined && 'terrain' in event.data) entry.terrain = event.data.terrain;
  };
  worker = created;
  return created;
}

/** Pustí stavbu terénu kola běžce ve workeru; jiné kolo, už puštěné kolo nebo prostředí bez workerů nic nedělá. */
export function prebuildRunnerTerrain(world: ArcadeWorld, look: Look): void {
  if (typeof Worker === 'undefined' || prebuilt.has(world) || runnerPathOf(world) === null) return;
  const length = world.length / UNIT;
  const entry: Prebuilt = { key: keyOf(look, length), terrain: null };
  prebuilt.set(world, entry);
  const id = (nextJob += 1);
  jobs.set(id, entry);
  terrainWorker().postMessage({ id, look, length, seed: world.seed, spans: levelSpansOf(world) } satisfies TerrainJob);
}

/** Terén, který worker pro tento svět a sadu už postavil; jinak `null` a scéna staví sama. */
export function prebuiltRunnerTerrain(world: ArcadeWorld, look: Look): RunnerTerrain | null {
  const entry = prebuilt.get(world);
  const length = world.length / UNIT;
  if (entry?.terrain == null || entry.key !== keyOf(look, length)) return null;
  return unpackTerrain(entry.terrain, look, length);
}
