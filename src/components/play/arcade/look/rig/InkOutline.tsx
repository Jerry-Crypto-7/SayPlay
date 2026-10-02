/**
 * Inkoustový obrys (P36C T6): hrdina a nepřátelé dostanou obrys podle kitu –
 * 2,5 px (CSS, tedy škálovaný s DPR) za siluetou; hrdina inkoustem, nepřátelé
 * rajčatovou (kit `08-game-hud.md`: tomato = hrozba, sytější odstín čte i tenká čára).
 *
 * Technika: inverted hull. Ke každé síti dítě se stejnou geometrií, kreslené
 * zezadu (`BackSide`) a v prostoru obrazovky odsunuté po normále o pevný počet
 * pixelů. Postprocess obrys (`OutlineEffect` z postprocessing) by potřeboval
 * skládač, který úroveň `low` vůbec nemá (`quality.ts`), a navíc průchod masky
 * vybraných těl a průchod hran přes celý obraz. Obal stojí +1 volání kreslení na
 * síť, nepotřebuje skládač a drží na každé úrovni kvality.
 *
 * Normály obalu jsou vyhlazené podle polohy (`toCreasedNormals`), jinak by se ploše
 * stínované modely na hranách roztrhly. Mimo hash: jen kreslení, jádro o něm neví.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import { BackSide, type BufferGeometry, Color, type Group, Mesh, type Object3D, ShaderMaterial, SkinnedMesh, UniformsLib, UniformsUtils, Vector2 } from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

import { colorHex } from '@/brand/tokens';

export type Ink = 'hero' | 'foe';

/** Tloušťka obrysu v CSS pixelech (kit: inkoustové obrysy 2,5 px). */
export const INK_PX = 2.5;

export const INK_COLOR: Readonly<Record<Ink, number>> = { hero: colorHex.ink, foe: colorHex['tomato-deep'] };

const VERTEX = /* glsl */ `
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <fog_pars_vertex>
uniform vec2 inkOffset;
void main() {
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  // Směr normály v obraze; normála mířící přímo do kamery patří zadní stěně, kterou zakryje tělo.
  vec2 dir = (projectionMatrix * modelViewMatrix * vec4(objectNormal, 0.0)).xy;
  float len = length(dir);
  if (len > 1e-6) gl_Position.xy += dir / len * inkOffset * gl_Position.w;
  #include <fog_vertex>
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 color;
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Jeden materiál na barvu a renderer: posun (NDC na 2,5 px) se přepočítá z velikosti plátna. */
function inkMaterial(ink: Ink): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([UniformsLib.fog, { color: { value: new Color(INK_COLOR[ink]) }, inkOffset: { value: new Vector2() } }]),
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: BackSide,
    fog: true,
    toneMapped: false,
  });
}

/**
 * Materiál na barvu a druh sítě. Jeden materiál pro riggovanou i statickou síť (nebo
 * s morfy i bez) by three při každém kreslení přepnul program (`needsProgramChange`).
 */
const materials = new Map<string, ShaderMaterial>();
function inkMaterialOf(ink: Ink, mesh: Mesh, geometry: BufferGeometry): ShaderMaterial {
  const key = `${ink}:${(mesh as SkinnedMesh).isSkinnedMesh === true}:${geometry.morphAttributes.position !== undefined}:${geometry.morphAttributes.normal !== undefined}`;
  let material = materials.get(key);
  if (material === undefined) materials.set(key, (material = inkMaterial(ink)));
  return material;
}

/** Posun o `INK_PX` CSS pixelů v NDC: celá šířka plátna jsou 2 jednotky. */
export function setInkViewport(width: number, height: number): void {
  for (const material of materials.values()) (material.uniforms.inkOffset!.value as Vector2).set((2 * INK_PX) / width, (2 * INK_PX) / height);
}

/** Vyhlazená kopie geometrie, sdílená všemi klony téhož modelu; s originálem se i zahodí. */
const hulls = new WeakMap<BufferGeometry, BufferGeometry>();
function hullOf(source: BufferGeometry): BufferGeometry {
  let hull = hulls.get(source);
  if (hull === undefined) {
    // Neindexovanou geometrii `toCreasedNormals` přepíše na místě – originál by ztratil ploché stínování.
    hull = toCreasedNormals(source.index === null ? source.clone() : source, Math.PI);
    hulls.set(source, hull);
    const drop = hull;
    source.addEventListener('dispose', () => drop.dispose());
  }
  return hull;
}

/** Je uzel obal obrysu? Sondy záběru ho přeskakují (`frameOf` v `ArcadeStage.tsx`). */
export const isInk = (node: Object3D): boolean => node.userData.ink !== undefined;

/**
 * Každé síti pod `root`, která obal ještě nemá, přidá obal jako dítě: dědí tak
 * polohu, pózu i viditelnost. Riggovaná síť dostane obal na téže kostře. Vrací,
 * kolik obalů přibylo. Volá se opakovaně – modely se dotahují až po připojení.
 */
export function inkMeshes(root: Object3D, ink: Ink): number {
  const fresh: Mesh[] = [];
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true || isInk(mesh) || mesh.children.some(isInk)) return;
    fresh.push(mesh);
  });
  for (const mesh of fresh) {
    const geometry = hullOf(mesh.geometry);
    const material = inkMaterialOf(ink, mesh, geometry);
    let hull: Mesh;
    if ((mesh as SkinnedMesh).isSkinnedMesh === true) {
      const skinned = new SkinnedMesh(geometry, material);
      skinned.bind((mesh as SkinnedMesh).skeleton, (mesh as SkinnedMesh).bindMatrix);
      hull = skinned;
    } else hull = new Mesh(geometry, material);
    hull.userData.ink = ink;
    // Značka pro rig stínů (`ShadowFlags` ve `StyleRig.tsx`): bez ní by obal vrhal stín a kreslil se podruhé.
    hull.userData.rigShadow = 'off';
    hull.morphTargetInfluences = mesh.morphTargetInfluences;
    hull.morphTargetDictionary = mesh.morphTargetDictionary;
    hull.frustumCulled = mesh.frustumCulled;
    mesh.add(hull);
  }
  return fresh.length;
}

/** Počet obalů pod uzlem – sonda záběru (`__playFrame().heroInk`). */
export function inkCount(root: Object3D): number {
  let count = 0;
  root.traverse((node) => {
    if (isInk(node)) count += 1;
  });
  return count;
}

/**
 * Obrys rodičovské skupiny: vlož jako dítě skupiny těla. Každý snímek dorovná obaly
 * nově dotažených sítí (podstrom těla má jednotky až desítky uzlů).
 */
export function InkOutline({ ink }: { readonly ink: Ink }) {
  const anchor = useRef<Group>(null);
  const size = useThree((three) => three.size);
  useFrame(() => {
    setInkViewport(size.width, size.height);
    const parent = anchor.current?.parent;
    if (parent != null) inkMeshes(parent, ink);
  });
  return <group ref={anchor} />;
}
