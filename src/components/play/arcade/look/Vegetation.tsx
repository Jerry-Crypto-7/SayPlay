'use client';

/**
 * Vegetace podél cesty (P46G T4): rozmístění z `vegetation-places.ts`, každý druh jedna
 * `InstancedMesh` – jedno kreslicí volání na druh, ať je rostlin kolik chce.
 *
 * Trať má rostlin tisíce, kamera ale vidí jen kus před sebou (`FarAtFog`). Instance
 * jsou seřazené podle z a do bufferu jde jen okno kolem kamery; posouvá se po
 * `STEP_M`, takže se buffer přepisuje jednou za pár metrů jízdy, ne každý snímek.
 * Stín vrhají jen stromy středu, drobnosti a linie v dálce ho jen přijímají.
 * Jen vzhled: jádro o vegetaci neví, hash se nehne.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { InstancedBufferAttribute, InstancedMesh, Matrix4, type PerspectiveCamera, Vector3 } from 'three';

import type { Flora } from '@/play/arcade/look';

import { type PlantModel, paintedPlant, plantMaterial } from './load';
import { type Plant, type RoadAt, type VegetationProfile, placeVegetation } from './vegetation-places';

/** Okno kreslení: kolik metrů za kamerou, krok posunu a rezerva za koncem mlhy na korunu stromu (m). */
const BEHIND_M = 15;
const STEP_M = 8;
const MARGIN_M = 12;
/** Pata rostliny na svahu stojí na nejnižším bodě v tomto poloměru (m), ať nevisí. */
const FOOT_M = 0.6;

/** Telefon jako start úrovně kvality (`startQuality`): hrubý ukazatel. Pevně při startu – hustota se za hry nemění. */
const profileOf = (): VegetationProfile => (window.matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop');

export interface VegetationProps {
  readonly flora: Flora;
  readonly seed: number;
  readonly from: number;
  readonly to: number;
  readonly road: (z: number) => RoadAt;
  readonly clear: number;
  /** Výška terénu (údolí běžce); bez ní rovina y = 0. */
  readonly ground?: (x: number, z: number) => number;
  /** Posun po zakřivené trati běžce (`runner/path.ts`): rostlina stojí vedle zatáčky, ne v ní. */
  readonly bend?: (z: number) => { readonly x: number; readonly y: number };
}

export function Vegetation({ flora, seed, from, to, road, clear, ground, bend }: VegetationProps) {
  const [profile] = useState(profileOf);
  const species = useMemo(() => {
    const byId = new Map<string, Plant[]>();
    for (const plant of placeVegetation({ flora, seed, from, to, road, clear, profile })) {
      const list = byId.get(plant.id) ?? [];
      list.push(plant);
      byId.set(plant.id, list);
    }
    const trees = new Set(flora.mid.map((entry) => entry.id));
    return [...byId].map(([id, plants]) => ({ id, plants: plants.sort((a, b) => a.z - b.z), cast: trees.has(id) }));
  }, [flora, seed, from, to, road, clear, profile]);
  return (
    <group name="vegetation">
      {species.map(({ id, plants, cast }) => (
        <Species key={id} id={id} flora={flora} plants={plants} cast={cast} ground={ground} bend={bend} />
      ))}
    </group>
  );
}

/** Index první hodnoty ≥ `value` ve vzestupném poli. */
function firstAtLeast(values: Float64Array, value: number): number {
  let [lo, hi] = [0, values.length];
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function Species({ id, flora, plants, cast, ground, bend }: { readonly id: string; readonly flora: Flora; readonly plants: readonly Plant[]; readonly cast: boolean; readonly ground?: VegetationProps['ground']; readonly bend?: VegetationProps['bend'] }) {
  const [model, setModel] = useState<PlantModel | null>(null);
  useEffect(() => {
    let live = true;
    void paintedPlant(id, flora).then((loaded) => {
      if (live) setModel(loaded);
    });
    return () => {
      live = false;
    };
  }, [id, flora]);
  const built = useMemo(() => {
    if (model === null) return null;
    const mesh = new InstancedMesh(model.geometry, plantMaterial(model.double), plants.length);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(plants.length * 3), 3);
    const matrices = new Float32Array(plants.length * 16);
    const colors = new Float32Array(plants.length * 3);
    const zs = new Float64Array(plants.length);
    const matrix = new Matrix4();
    const scale = new Vector3();
    plants.forEach((plant, i) => {
      const shift = bend?.(plant.z) ?? { x: 0, y: 0 };
      const r = Math.min(plant.reach, FOOT_M);
      const { x, z } = plant;
      const y = ground === undefined ? 0 : Math.min(ground(x, z), ground(x - r, z), ground(x + r, z), ground(x, z - r), ground(x, z + r));
      matrix.makeRotationY(plant.turn).scale(scale.setScalar(plant.height)).setPosition(x + shift.x, y + shift.y, z);
      matrix.toArray(matrices, i * 16);
      colors.set(plant.shade, i * 3);
      zs[i] = z;
    });
    mesh.count = 0;
    // Buffer drží jen okno kolem kamery; ořez celé sady by počítal s instancemi mimo něj.
    mesh.frustumCulled = false;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.userData.rigShadow = cast ? 'both' : 'receive';
    return { mesh, matrices, colors, zs };
  }, [model, plants, cast, ground, bend]);
  useEffect(() => () => built?.mesh.dispose(), [built]);
  const shown = useRef({ built: null as typeof built, lo: -1, hi: -1 });
  useFrame(({ camera }) => {
    if (built === null) return;
    const start = Math.floor((camera.position.z - BEHIND_M) / STEP_M) * STEP_M;
    const lo = firstAtLeast(built.zs, start);
    const hi = firstAtLeast(built.zs, start + STEP_M + BEHIND_M + (camera as PerspectiveCamera).far + MARGIN_M);
    const last = shown.current;
    if (last.built === built && last.lo === lo && last.hi === hi) return;
    shown.current = { built, lo, hi };
    const { instanceMatrix, instanceColor } = built.mesh;
    instanceMatrix.array.set(built.matrices.subarray(lo * 16, hi * 16));
    instanceColor!.array.set(built.colors.subarray(lo * 3, hi * 3));
    for (const [attribute, size] of [[instanceMatrix, 16], [instanceColor!, 3]] as const) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, (hi - lo) * size);
      attribute.needsUpdate = true;
    }
    built.mesh.count = hi - lo;
  });
  return built === null ? null : <primitive object={built.mesh} />;
}
