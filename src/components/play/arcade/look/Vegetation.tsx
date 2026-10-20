'use client';

/**
 * Vegetace podél cesty (P46G T4) a kolem hrací plochy (T7): rozmístění z `vegetation-places.ts`,
 * každý druh jedna `InstancedMesh` – jedno kreslicí volání na druh, ať je rostlin kolik chce.
 *
 * Trať má rostlin tisíce, kamera ale vidí jen kus před sebou (`FarAtFog`). Instance
 * jsou seřazené podle z; každý snímek se z okna kolem kamery vyberou ty, které vidí
 * kamera nebo stínová kamera slunce (P54B T15d: úzký záběr telefonu vidí z okna
 * čtvrtinu, stín na `low` skoro nic), a buffer se přepíše, jen když se výběr změní.
 * Stín vrhají jen stromy středu, drobnosti a linie v dálce ho jen přijímají.
 * Jen vzhled: jádro o vegetaci neví, hash se nehne.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import { type Camera, DynamicDrawUsage, Frustum, InstancedBufferAttribute, InstancedMesh, Matrix4, type PerspectiveCamera, Sphere, Vector3 } from 'three';

import type { Flora, Look, LookId } from '@/play/arcade/look';

import { toyMotionOn } from '../toy/applyToy';
import type { Box } from './ground';
import { blowPlantWind, type PlantModel, paintedPlant, plantDepthMaterial, plantMaterial, plantWind, plantWindFor, setPlantWind } from './load';
import { BEFORE_COMPOSER } from './rig/Post';
import type { QualityTier } from './rig/quality';
import { firstAtLeast } from './road-strip';
import { type Layer, type Plant, type RoadAt, type Side, type VegetationProfile, placeAround, placeVegetation } from './vegetation-places';

/** Okno kandidátů: kolik metrů za kamerou a rezerva za koncem mlhy na korunu stromu (m). */
const BEHIND_M = 15;
const MARGIN_M = 12;
/**
 * Rezerva ořezu. Výběr běží po kameře hry (`BEFORE_COMPOSER`), záběr je tedy přesný; obalová koule
 * se zvětší o výkyv koruny ve větru (nejvíc pláž v bouřce: 0,13 výšky, poloměr koule je aspoň půl
 * výšky). Stínová kamera je z minulého snímku a slunce jde za hrdinou – k ní ještě metry navíc.
 */
const SWAY_PAD = 1.3;
const SHADOW_PAD_M = 3;
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
  const plants = useMemo(() => placeVegetation({ flora, seed, from, to, road, clear, profile }), [flora, seed, from, to, road, clear, profile]);
  return <Plants flora={flora} plants={plants} profile={profile} ground={ground} bend={bend} />;
}

export interface VegetationAroundProps {
  readonly flora: Flora;
  readonly seed: number;
  /** Hrací plocha (m); objekt drží volající stálý (`useMemo`). */
  readonly box: Box;
  readonly clear: number;
  /** Vrstvy po stranách plochy (`placeAround`); stálý objekt. */
  readonly layers: Readonly<Record<Side, readonly Layer[]>>;
  /** Kolik metrů za kamerou (po z) okno kreslení drží: boční kamera vidí do stran po z daleko. */
  readonly behind?: number;
}

/** Vegetace kolem hrací plochy (P46G T7): aréna, bludiště, hřiště. */
export function VegetationAround({ flora, seed, box, clear, layers, behind }: VegetationAroundProps) {
  const [profile] = useState(profileOf);
  const plants = useMemo(() => placeAround({ flora, seed, box, clear, layers, profile }), [flora, seed, box, clear, layers, profile]);
  return <Plants flora={flora} plants={plants} profile={profile} behind={behind} />;
}

interface PlantsProps {
  readonly flora: Flora;
  readonly plants: readonly Plant[];
  readonly profile: VegetationProfile;
  readonly ground?: VegetationProps['ground'];
  readonly bend?: VegetationProps['bend'];
  readonly behind?: number;
}

/** Rostliny po druzích, každý druh jedna instancovaná síť. Telefon kreslí rostliny zjednodušené (`paintedPlant`). */
function Plants({ flora, plants, profile, ground, bend, behind = BEHIND_M }: PlantsProps) {
  const species = useMemo(() => {
    const byId = new Map<string, Plant[]>();
    for (const plant of plants) {
      const list = byId.get(plant.id) ?? [];
      list.push(plant);
      byId.set(plant.id, list);
    }
    const trees = new Set(flora.mid.map((entry) => entry.id));
    return [...byId].map(([id, list]) => ({ id, plants: list.sort((a, b) => a.z - b.z), cast: trees.has(id) }));
  }, [flora, plants]);
  return (
    <group name="vegetation">
      {species.map(({ id, plants: list, cast }) => (
        <Species key={id} id={id} flora={flora} plants={list} cast={cast} simple={profile === 'phone'} ground={ground} bend={bend} behind={behind} />
      ))}
    </group>
  );
}

function Species({ id, flora, plants, cast, simple, ground, bend, behind }: { readonly id: string; readonly flora: Flora; readonly plants: readonly Plant[]; readonly cast: boolean; readonly simple: boolean; readonly ground?: VegetationProps['ground']; readonly bend?: VegetationProps['bend']; readonly behind: number }) {
  const [model, setModel] = useState<PlantModel | null>(null);
  useEffect(() => {
    let live = true;
    void paintedPlant(id, flora, simple).then((loaded) => {
      if (live) setModel(loaded);
    });
    return () => {
      live = false;
    };
  }, [id, flora, simple]);
  const built = useMemo(() => {
    if (model === null) return null;
    const mesh = new InstancedMesh(model.geometry, plantMaterial(model.double), plants.length);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(plants.length * 3), 3).setUsage(DynamicDrawUsage);
    const matrices = new Float32Array(plants.length * 16);
    const colors = new Float32Array(plants.length * 3);
    const zs = new Float64Array(plants.length);
    // Obalová koule rostliny ve světě: střed a poloměr.
    const spheres = new Float32Array(plants.length * 4);
    const bound = model.geometry.boundingSphere!;
    const matrix = new Matrix4();
    const scale = new Vector3();
    const center = new Vector3();
    plants.forEach((plant, i) => {
      const shift = bend?.(plant.z) ?? { x: 0, y: 0 };
      const r = Math.min(plant.reach, FOOT_M);
      const { x, z } = plant;
      const y = ground === undefined ? 0 : Math.min(ground(x, z), ground(x - r, z), ground(x + r, z), ground(x, z - r), ground(x, z + r));
      matrix.makeRotationY(plant.turn).scale(scale.setScalar(plant.height)).setPosition(x + shift.x, y + shift.y, z);
      matrix.toArray(matrices, i * 16);
      colors.set(plant.shade, i * 3);
      zs[i] = z;
      center.copy(bound.center).applyMatrix4(matrix).toArray(spheres, i * 4);
      spheres[i * 4 + 3] = bound.radius * plant.height;
    });
    mesh.count = 0;
    // Buffer drží jen vybrané instance; ořez celé sady by počítal s ostatními.
    mesh.frustumCulled = false;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.userData.rigShadow = cast ? 'both' : 'receive';
    // Kolik instancí kreslí obraz a kolik z nich (předpona) stín; slunce z posledního stínového průchodu.
    const drawn = { all: 0, cast: 0, sun: null as Camera | null };
    if (cast) {
      mesh.customDepthMaterial = plantDepthMaterial();
      mesh.onBeforeShadow = (_renderer, _scene, _camera, shadowCamera) => {
        drawn.sun = shadowCamera;
        mesh.count = drawn.cast;
      };
      mesh.onAfterShadow = () => {
        mesh.count = drawn.all;
      };
    }
    return { mesh, matrices, colors, zs, spheres, drawn, picked: new Int32Array(plants.length), seenOnly: new Int32Array(plants.length), shown: new Int32Array(plants.length) };
  }, [model, plants, cast, ground, bend]);
  useEffect(() => () => built?.mesh.dispose(), [built]);
  const cull = useMemo(() => ({ view: new Frustum(), shadow: new Frustum(), matrix: new Matrix4(), sphere: new Sphere() }), []);
  useFrame(({ camera }) => {
    if (built === null) return;
    const { mesh, spheres, drawn, picked, seenOnly, shown } = built;
    const lo = firstAtLeast(built.zs, camera.position.z - behind);
    const hi = firstAtLeast(built.zs, camera.position.z + (camera as PerspectiveCamera).far + MARGIN_M);
    const view = cull.view.setFromProjectionMatrix(cull.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const sun = drawn.sun === null ? null : cull.shadow.setFromProjectionMatrix(cull.matrix.multiplyMatrices(drawn.sun.projectionMatrix, drawn.sun.matrixWorldInverse));
    const { sphere } = cull;
    // Stínící napřed: stínový průchod kreslí jen jejich předponu. Před prvním stínovým průchodem vrhají stín všechny.
    let cast = 0;
    let only = 0;
    for (let i = lo; i < hi; i += 1) {
      sphere.center.fromArray(spheres, i * 4);
      sphere.radius = spheres[i * 4 + 3]! * SWAY_PAD + SHADOW_PAD_M;
      if (mesh.castShadow && (sun === null || sun.intersectsSphere(sphere))) {
        picked[cast++] = i;
        continue;
      }
      sphere.radius -= SHADOW_PAD_M;
      if (view.intersectsSphere(sphere)) seenOnly[only++] = i;
    }
    const all = cast + only;
    picked.set(seenOnly.subarray(0, only), cast);
    let same = all === drawn.all && cast === drawn.cast;
    for (let k = 0; same && k < all; k += 1) same = picked[k] === shown[k];
    if (same) return;
    shown.set(picked.subarray(0, all));
    const { instanceMatrix, instanceColor } = mesh;
    for (let k = 0; k < all; k += 1) {
      const i = picked[k]!;
      for (let j = 0; j < 16; j += 1) instanceMatrix.array[k * 16 + j] = built.matrices[i * 16 + j]!;
      for (let j = 0; j < 3; j += 1) instanceColor!.array[k * 3 + j] = built.colors[i * 3 + j]!;
    }
    for (const [attribute, size] of [[instanceMatrix, 16], [instanceColor!, 3]] as const) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, all * size);
      attribute.needsUpdate = true;
    }
    drawn.all = all;
    drawn.cast = cast;
    mesh.count = all;
  }, BEFORE_COMPOSER);
  return built === null ? null : <primitive object={built.mesh} />;
}

/**
 * Vítr ve vegetaci (P54B T13): sílu ze sady a nálady a čas kresby do uniforem rostlin (`plantWind`).
 * Bouřka kmitá i rychleji. Scéna na `low` a s omezeným pohybem (`toyMotionOn`) vítr v shaderu nemá,
 * sestup na `low` za hry ho ztiší (`blowPlantWind`). Nová scéna začíná bez větru.
 */
export function Wind({ look, lookId, tier }: { readonly look: Look; readonly lookId: LookId; readonly tier: QualityTier }) {
  const strength = plantWindFor(look, lookId, tier, toyMotionOn());
  const pace = Math.sqrt(look.wind ?? 1);
  useEffect(() => blowPlantWind(strength), [strength]);
  useEffect(() => () => setPlantWind(false), []);
  useFrame((_, delta) => {
    if (strength > 0) plantWind.time.value += delta * pace;
  });
  return null;
}
