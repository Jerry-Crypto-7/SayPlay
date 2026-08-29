/**
 * Měřidlo rozmanitosti tvarů (P13 vlna 1 T7) — brána K1.
 *
 * ## Co se měří a proč zrovna tohle
 *
 * Otázka je „řekne ten jazyk dvanáct různých věcí?" a **nesmí ji zodpovědět
 * barva ani jméno**. Měřidlo proto vidí jen hotový mesh a počítá tři věci:
 *
 * 1. **Otisk geometrie** — FNV-1a nad kvantovanými vrcholy. Odpovídá na
 *    „jsou to doslova tytéž trojúhelníky?", nic víc. Je to detektor duplikátu,
 *    ne míra podobnosti: dva různé tvary mají různý otisk vždycky, takže by
 *    jako míra prošel i dvanáctkrát tentýž kámen o milimetr posunutý.
 * 2. **Profil siluet ze čtyř kamer** — tvar se otočí kolem `y` po 90° a
 *    vrcholy se hodí do mřížky 24×24. Tohle nese většinu rozsudku.
 * 3. **Profil topologie** — pět bezrozměrných čísel: poměry stran, plnost
 *    a poměr vrcholů k trojúhelníkům.
 *
 * ## Proč se normalizuje na vlastní kvádr tvaru
 *
 * Silueta se škáluje **na největší rozměr toho konkrétního meshe**, ne na
 * společné měřítko světa. Velká koule a malá koule jsou týž tvar a měřidlo to
 * má vidět; kdyby se normalizovalo společně, prošla by galerie, ve které je
 * dvanáctkrát kámen v dvanácti velikostech. Poměr stran se přitom neztratí —
 * dělí se **jedním** číslem pro všechny tři osy, takže kost zůstane dlouhá
 * a síť placatá.
 *
 * ## Proč je práh 0,15 a ne naměřená mezera
 *
 * Práh je **význam, ne pozorování**: siluety, které se liší v méně než 15 %
 * buněk, jsou pro oko tentýž tvar. Kdyby se posadil těsně pod naměřenou
 * nejbližší dvojici, měřil by tuhle galerii místo jazyka a první nový tvar by
 * ho shodil. Kontrolu, že práh není přestřelený, dělá `diversity.test.ts`
 * z druhé strany: tentýž program pod jiným semínkem musí spadnout **pod** něj.
 */

import { meshShapeProgram, type ShapeMesh } from '../../src/shape/surface-nets';
import type { ShapeProgram, Vec3 } from '../../src/shape/types';

/** Mřížka, ve které se galerie meshuje. Vysoká příčka žebříku z T5. */
export const DIVERSITY_RESOLUTION = 48;

/** Buněk na osu v siluetě. 24² = 576 buněk na kameru, 2 304 na tvar. */
export const SILHOUETTE_CELLS = 24;

/** Buněk na osu v prostorové mřížce, ze které se čte plnost. */
const SOLIDITY_CELLS = 12;

/** Úhly, o které se tvar otočí kolem `y`. Čtyři pohledy, po 90°. */
export const CAMERA_YAWS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2] as const;

/**
 * Pod tímhle prahem jsou dva tvary „týž tvar". Význam, ne naměřená mezera —
 * viz hlavička souboru.
 */
export const DIVERSITY_THRESHOLD = 0.15;

/** Váhy dvou profilů ve výsledné vzdálenosti. Silueta rozhoduje, topologie doplňuje. */
const SILHOUETTE_WEIGHT = 0.7;
const TOPOLOGY_WEIGHT = 0.3;

export interface ShapeProfile {
  readonly id: string;
  readonly geometryHash: string;
  readonly vertices: number;
  readonly triangles: number;
  /** Čtyři mřížky 24×24 jako bitová pole, jedna na kameru. */
  readonly silhouettes: readonly Uint8Array[];
  /** Pět bezrozměrných čísel: tři poměry stran, plnost, vrcholy na trojúhelník. */
  readonly topology: readonly number[];
}

/**
 * FNV-1a nad kvantovanými vrcholy. Ručně psaný, ~15 řádků, žádný WASM —
 * `CLAUDE.md` to zakazuje kvůli async initu na kritické cestě.
 *
 * Kvantuje se na tisíciny **relativně k rozsahu meshe**, ne absolutně: jinak by
 * otisk záležel na tom, jak velký tvar je, a dva stejné tvary v jiné velikosti
 * by dostaly jiný otisk. To by z detektoru duplikátu udělalo detektor měřítka.
 */
export function geometryHash(mesh: ShapeMesh): string {
  const span = Math.max(
    mesh.bounds.max[0] - mesh.bounds.min[0],
    mesh.bounds.max[1] - mesh.bounds.min[1],
    mesh.bounds.max[2] - mesh.bounds.min[2],
    1e-9,
  );

  let hash = 0x811c9dc5;
  for (let i = 0; i < mesh.positions.length; i += 1) {
    const axis = i % 3;
    const relative = (mesh.positions[i] - mesh.bounds.min[axis]) / span;
    const quantized = Math.round(relative * 1000) | 0;
    hash = Math.imul(hash ^ (quantized & 0xff), 0x01000193);
    hash = Math.imul(hash ^ ((quantized >>> 8) & 0xff), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Střed a poloměr, na které se mesh normalizuje. Jedno měřítko pro všechny osy. */
function normalizer(mesh: ShapeMesh): { center: Vec3; scale: number } {
  const center: Vec3 = [
    (mesh.bounds.min[0] + mesh.bounds.max[0]) / 2,
    (mesh.bounds.min[1] + mesh.bounds.max[1]) / 2,
    (mesh.bounds.min[2] + mesh.bounds.max[2]) / 2,
  ];
  const scale =
    Math.max(
      mesh.bounds.max[0] - mesh.bounds.min[0],
      mesh.bounds.max[1] - mesh.bounds.min[1],
      mesh.bounds.max[2] - mesh.bounds.min[2],
      1e-9,
    ) / 2;
  return { center, scale };
}

function silhouette(mesh: ShapeMesh, yaw: number): Uint8Array {
  const cells = new Uint8Array(SILHOUETTE_CELLS * SILHOUETTE_CELLS);
  const { center, scale } = normalizer(mesh);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = (mesh.positions[i] - center[0]) / scale;
    const y = (mesh.positions[i + 1] - center[1]) / scale;
    const z = (mesh.positions[i + 2] - center[2]) / scale;

    // Otočení kolem `y`; kamera se pak dívá podél `-z`, takže vodorovná
    // souřadnice obrazu je `u` a svislá `y`.
    const u = x * cos - z * sin;

    const column = Math.floor(((u + 1) / 2) * SILHOUETTE_CELLS);
    const row = Math.floor(((y + 1) / 2) * SILHOUETTE_CELLS);
    if (column < 0 || column >= SILHOUETTE_CELLS || row < 0 || row >= SILHOUETTE_CELLS) continue;
    cells[row * SILHOUETTE_CELLS + column] = 1;
  }
  return cells;
}

function topologyProfile(mesh: ShapeMesh): readonly number[] {
  const { center, scale } = normalizer(mesh);
  const extents = [
    (mesh.bounds.max[0] - mesh.bounds.min[0]) / (2 * scale),
    (mesh.bounds.max[1] - mesh.bounds.min[1]) / (2 * scale),
    (mesh.bounds.max[2] - mesh.bounds.min[2]) / (2 * scale),
  ];

  const occupied = new Uint8Array(SOLIDITY_CELLS ** 3);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const index = [0, 1, 2].map((axis) => {
      const value = (mesh.positions[i + axis] - center[axis]) / scale;
      return Math.min(SOLIDITY_CELLS - 1, Math.max(0, Math.floor(((value + 1) / 2) * SOLIDITY_CELLS)));
    });
    occupied[(index[0] * SOLIDITY_CELLS + index[1]) * SOLIDITY_CELLS + index[2]] = 1;
  }
  const solidity = occupied.reduce<number>((sum, cell) => sum + cell, 0) / occupied.length;

  // Vrcholy na trojúhelník. U uzavřeného meshe ze surface nets sedí kolem 0,5;
  // odchylka znamená okraje, díry nebo oddělené kusy.
  const verticesPerTriangle =
    mesh.triangleCount === 0 ? 0 : Math.min(1, mesh.vertexCount / (2 * mesh.triangleCount));

  return [...extents, solidity, verticesPerTriangle];
}

export function profileShape(program: ShapeProgram, sessionSeed: number): ShapeProfile {
  const mesh = meshShapeProgram(program, sessionSeed, {
    resolution: DIVERSITY_RESOLUTION,
    bounds: program.targetBounds,
  });

  return {
    id: program.shapeId,
    geometryHash: geometryHash(mesh),
    vertices: mesh.vertexCount,
    triangles: mesh.triangleCount,
    silhouettes: CAMERA_YAWS.map((yaw) => silhouette(mesh, yaw)),
    topology: topologyProfile(mesh),
  };
}

/**
 * Podíl buněk, ve kterých se dvě siluety neshodují, zprůměrovaný přes čtyři
 * kamery. Nula znamená pixel po pixelu totéž.
 */
export function silhouetteDistance(a: ShapeProfile, b: ShapeProfile): number {
  let total = 0;
  for (let camera = 0; camera < CAMERA_YAWS.length; camera += 1) {
    const left = a.silhouettes[camera];
    const right = b.silhouettes[camera];
    let different = 0;
    for (let cell = 0; cell < left.length; cell += 1) {
      if (left[cell] !== right[cell]) different += 1;
    }
    total += different / left.length;
  }
  return total / CAMERA_YAWS.length;
}

/** Průměrná absolutní odchylka pěti bezrozměrných čísel, oříznutá na [0, 1]. */
export function topologyDistance(a: ShapeProfile, b: ShapeProfile): number {
  const sum = a.topology.reduce(
    (acc, value, index) => acc + Math.abs(value - b.topology[index]),
    0,
  );
  return Math.min(1, sum / a.topology.length);
}

/** Jedno číslo, na kterém stojí brána. */
export function shapeDistance(a: ShapeProfile, b: ShapeProfile): number {
  return (
    SILHOUETTE_WEIGHT * silhouetteDistance(a, b) + TOPOLOGY_WEIGHT * topologyDistance(a, b)
  );
}

export interface DiversityPair {
  readonly a: string;
  readonly b: string;
  readonly distance: number;
  readonly silhouette: number;
  readonly topology: number;
}

export interface DiversityReport {
  readonly measuredAt: string;
  readonly task: string;
  readonly resolution: number;
  readonly silhouetteCells: number;
  readonly cameras: number;
  readonly threshold: number;
  readonly weights: { readonly silhouette: number; readonly topology: number };
  readonly shapes: readonly {
    readonly id: string;
    readonly geometryHash: string;
    readonly vertices: number;
    readonly triangles: number;
    readonly topology: readonly number[];
  }[];
  readonly closestPair: DiversityPair;
  readonly pairs: readonly DiversityPair[];
  readonly duplicateHashes: readonly string[];
}

export function buildDiversityReport(
  entries: readonly { readonly id: string; readonly program: ShapeProgram }[],
  sessionSeed: number,
  measuredAt: string,
): DiversityReport {
  const profiles = entries.map((item) => profileShape(item.program, sessionSeed));

  const pairs: DiversityPair[] = [];
  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      pairs.push({
        a: profiles[i].id,
        b: profiles[j].id,
        distance: Number(shapeDistance(profiles[i], profiles[j]).toFixed(4)),
        silhouette: Number(silhouetteDistance(profiles[i], profiles[j]).toFixed(4)),
        topology: Number(topologyDistance(profiles[i], profiles[j]).toFixed(4)),
      });
    }
  }
  pairs.sort((left, right) => left.distance - right.distance);

  const seen = new Map<string, string[]>();
  for (const profile of profiles) {
    const bucket = seen.get(profile.geometryHash) ?? [];
    bucket.push(profile.id);
    seen.set(profile.geometryHash, bucket);
  }

  return {
    measuredAt,
    task: 'P13 vlna 1 T7',
    resolution: DIVERSITY_RESOLUTION,
    silhouetteCells: SILHOUETTE_CELLS,
    cameras: CAMERA_YAWS.length,
    threshold: DIVERSITY_THRESHOLD,
    weights: { silhouette: SILHOUETTE_WEIGHT, topology: TOPOLOGY_WEIGHT },
    shapes: profiles.map((profile) => ({
      id: profile.id,
      geometryHash: profile.geometryHash,
      vertices: profile.vertices,
      triangles: profile.triangles,
      topology: profile.topology.map((value) => Number(value.toFixed(4))),
    })),
    closestPair: pairs[0],
    pairs,
    duplicateHashes: [...seen.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([hash, ids]) => `${hash}: ${ids.join(', ')}`),
  };
}
