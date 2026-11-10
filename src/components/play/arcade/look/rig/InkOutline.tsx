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
import { BackSide, Box3, BufferGeometry, Color, type Group, type InstancedBufferGeometry, InstancedMesh, Mesh, type Object3D, ShaderMaterial, SkinnedMesh, UniformsLib, UniformsUtils, Vector2, Vector3 } from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

import { colorHex } from '@/brand/tokens';
import { type InkKind, LOOK_STYLE } from '@/play/arcade/look/style';

import { type ToyUniforms, withToyDeform } from '../toy-deform';

import { flagShadow } from './StyleRig';

/** `obstacle` (P70D T2): překážka a nástraha v cestě inkoustem – v mlze a proti zemi splývaly. */
export type Ink = InkKind;

/** Tloušťka obrysu v CSS pixelech (profil vzhledu, P81). */
export const INK_PX = LOOK_STYLE.ink.px;

export const INK_COLOR: Readonly<Record<Ink, number>> = { hero: colorHex.ink, foe: colorHex['tomato-deep'], obstacle: colorHex.ink, scenery: colorHex.ink };

/**
 * Kolik obrys hrdiny a překážky vezme z tmavého odstínu povrchu (barva vrcholů × `INK_SHADE`) místo inkoustu.
 * Nepřítel zůstane rajčatový: barva obrysu je jeho signál hrozby. Model bez barev ve vrcholech (textura) má inkoust.
 * Obal se nesvítí ani netónuje: odstín 0,35 a čistý povrch vyšly na snímku (P75 T2, želva) SVĚTLEJŠÍ než stínované
 * tělo – světlá lemovka místo hrany. Proto tmavší odstín a třetina inkoustu.
 */
export const INK_SURFACE: Readonly<Record<Ink, number>> = LOOK_STYLE.ink.surface;
const INK_SHADE = '0.2';

const VERTEX = /* glsl */ `
#include <common>
#include <color_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <fog_pars_vertex>
uniform vec2 inkOffset;
void main() {
  #include <color_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #ifdef USE_INSTANCING
  objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  // Směr normály v obraze; normála mířící přímo do kamery patří zadní stěně, kterou zakryje tělo.
  vec2 dir = (projectionMatrix * modelViewMatrix * vec4(objectNormal, 0.0)).xy;
  float len = length(dir);
  if (len > 1e-6) gl_Position.xy += dir / len * inkOffset * gl_Position.w;
  #include <fog_vertex>
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 inkColor;
uniform float inkSurface;
#include <color_pars_fragment>
#include <fog_pars_fragment>
void main() {
  vec3 ink = inkColor;
  #ifdef USE_COLOR
  ink = mix(inkColor, vColor.rgb * ${INK_SHADE}, inkSurface);
  #endif
  gl_FragColor = vec4(ink, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const shaderOf = (uniforms: ShaderMaterial['uniforms'], vertexShader: string, vertexColors: boolean): ShaderMaterial =>
  new ShaderMaterial({ uniforms, vertexShader, fragmentShader: FRAGMENT, side: BackSide, fog: true, toneMapped: false, vertexColors });

/** Jeden materiál na barvu, druh sítě a renderer: posun (NDC na `INK_PX`) se přepočítá z velikosti plátna. */
function inkMaterial(ink: Ink, vertexColors: boolean): ShaderMaterial {
  const uniforms = { inkColor: { value: new Color(INK_COLOR[ink]) }, inkSurface: { value: INK_SURFACE[ink] }, inkOffset: { value: new Vector2() } };
  const material = shaderOf(UniformsUtils.merge([UniformsLib.fog, uniforms]), VERTEX, vertexColors);
  if (ink === 'scenery') {
    // P81: obal kulisy hlouběji, ať prosvítá jen za siluetou, ne vnitřními stěnami modelu (iglú, led).
    material.polygonOffset = true;
    material.polygonOffsetFactor = 4;
    material.polygonOffsetUnits = 16;
  }
  return material;
}

/**
 * Obal deformovaného těla (P45D T6) se ohne stejně jako tělo, jinak by obrys
 * křídel zůstal stát. Uniformy obrysu sdílí s materiálem barvy (posun z
 * `setInkViewport` platí dál), uniformy deformace s tělem.
 */
function deformedInk(base: ShaderMaterial, toy: ToyUniforms): ShaderMaterial {
  return shaderOf({ ...base.uniforms, ...toy }, withToyDeform(VERTEX), base.vertexColors);
}

/**
 * Materiál na barvu a druh sítě. Jeden materiál pro riggovanou i statickou síť (nebo
 * s morfy i bez) by three při každém kreslení přepnul program (`needsProgramChange`).
 */
const materials = new Map<string, ShaderMaterial>();
function inkMaterialOf(ink: Ink, mesh: Mesh, geometry: BufferGeometry): ShaderMaterial {
  const tinted = geometry.attributes.color !== undefined;
  const key = `${ink}:${(mesh as SkinnedMesh).isSkinnedMesh === true}:${(mesh as InstancedMesh).isInstancedMesh === true}:${geometry.morphAttributes.position !== undefined}:${geometry.morphAttributes.normal !== undefined}:${tinted}`;
  let material = materials.get(key);
  if (material === undefined) materials.set(key, (material = inkMaterial(ink, tinted)));
  return material;
}

/** Posun o `INK_PX` CSS pixelů v NDC: celá šířka plátna jsou 2 jednotky. */
export function setInkViewport(width: number, height: number): void {
  for (const material of materials.values()) (material.uniforms.inkOffset!.value as Vector2).set((2 * INK_PX) / width, (2 * INK_PX) / height);
}

/** Vyhlazená kopie geometrie, sdílená všemi klony téhož modelu; s originálem se i zahodí. */
const hulls = new WeakMap<BufferGeometry, BufferGeometry>();
function hullOf(source: BufferGeometry, welded: boolean): BufferGeometry {
  let hull = hulls.get(source);
  if (hull === undefined) {
    if (welded) {
      // P81 kulisy: ploché modely mají každý trojúhelník zvlášť; bez svaření vrcholů se obal po normálách roztrhne
      // a prosvítá tělem jako černé střepy. Jen poloha (a kostra), barva obalu je pak čistý inkoust.
      const bare = new BufferGeometry();
      for (const name of ['position', 'skinIndex', 'skinWeight']) {
        const attribute = source.getAttribute(name);
        if (attribute !== undefined) bare.setAttribute(name, attribute);
      }
      bare.setIndex(source.index);
      hull = mergeVertices(bare, 1e-4);
      hull.computeVertexNormals();
    } else
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

/** Obří sítě bez obrysu kulisy: svaření vrcholů obalu stojí CPU při přípravě. */
const SCENERY_INK_MAX_VERTICES = 40_000;
/** Plochá široká síť je zem (podlaha, dno, louka): výška pod tímto podílem šířky při šířce nad `GROUND_WIDE_M`. */
const GROUND_FLAT = 0.15;
const GROUND_WIDE_M = 4;
const box = new Box3();
const extent = new Vector3();
const worldScale = new Vector3();

/** Patří síť tělu s vlastním obrysem (`InkOutline`)? Rodič se značkou `inkOwner` dostane obrys svého druhu. */
function ownedInk(mesh: Object3D): boolean {
  for (let node: Object3D | null = mesh; node !== null; node = node.parent) if (node.userData.inkOwner !== undefined) return true;
  return false;
}

/**
 * Smí kulisa nebo rekvizita dostat obrys (P81, `ShadowFlags`)? Jen pevný viditelný model: ne zem a terén
 * (`userData.terrain`, plochá široká síť – obrys by tam byl neviditelný, jen cena), ne průhledné, neviditelné
 * materiály (hitbox, maska), instancované glyfy textu, život s vlastním pohybem ve shaderu (`rigShadow: 'none'`)
 * ani tělo hrdiny, nepřítele či překážky – ty mají vlastní obrys a jeho barva je signál.
 */
export function outlinable(mesh: Mesh): boolean {
  const shadow = mesh.userData.rigShadow;
  if (shadow === 'none' || shadow === 'off' || shadow === 'receive' || mesh.userData.terrain !== undefined || isInk(mesh) || mesh.children.some(isInk)) return false;
  if ((mesh.parent !== null && isInk(mesh.parent)) || ownedInk(mesh)) return false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (materials.some((material) => material.transparent || !material.depthWrite || !material.visible || !material.colorWrite)) return false;
  const geometry = mesh.geometry;
  if ((geometry as InstancedBufferGeometry).isInstancedBufferGeometry === true || geometry.attributes.normal === undefined) return false;
  const count = geometry.attributes.position?.count ?? 0;
  if (count === 0 || count > SCENERY_INK_MAX_VERTICES) return false;
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  box.copy(geometry.boundingBox!).getSize(extent).multiply(mesh.getWorldScale(worldScale));
  const wide = Math.max(Math.abs(extent.x), Math.abs(extent.z));
  return !(wide > GROUND_WIDE_M && Math.abs(extent.y) < wide * GROUND_FLAT);
}

/**
 * Každé síti pod `root`, která obal ještě nemá, přidá obal jako dítě: dědí tak
 * polohu, pózu i viditelnost. Riggovaná síť dostane obal na téže kostře. Vrací,
 * kolik obalů přibylo. Volá se opakovaně – modely se dotahují až po připojení.
 */
export function inkMeshes(root: Object3D, ink: Ink): number {
  const fresh: Mesh[] = [];
  const pick = (node: Object3D) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true || isInk(mesh) || mesh.children.some(isInk)) return;
    fresh.push(mesh);
  };
  // Kulisa jen sama za sebe: její vnořené sítě posoudí `outlinable` každou zvlášť.
  if (ink === 'scenery') pick(root);
  else root.traverse(pick);
  for (const mesh of fresh) {
    // Tělo vrhá stín hned, ne až s plošným průchodem rigu (`flagShadow`); obal níž stín nevrhá.
    if (mesh.userData.rigShadow === undefined) flagShadow(mesh);
    const geometry = hullOf(mesh.geometry, ink === 'scenery');
    const base = inkMaterialOf(ink, mesh, geometry);
    const toy = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.userData.toyDeform as ToyUniforms | undefined;
    const material = toy === undefined ? base : deformedInk(base, toy);
    let hull: Mesh;
    if ((mesh as SkinnedMesh).isSkinnedMesh === true) {
      const skinned = new SkinnedMesh(geometry, material);
      skinned.bind((mesh as SkinnedMesh).skeleton, (mesh as SkinnedMesh).bindMatrix);
      hull = skinned;
    } else if ((mesh as InstancedMesh).isInstancedMesh === true) {
      // P81: obrys instancované kulisy sdílí matice instancí; počet dorovná před kreslením.
      const source = mesh as InstancedMesh;
      const instanced = new InstancedMesh(geometry, material, source.count);
      instanced.instanceMatrix = source.instanceMatrix;
      instanced.onBeforeRender = () => {
        instanced.count = source.count;
      };
      instanced.frustumCulled = false;
      hull = instanced;
    } else hull = new Mesh(geometry, material);
    hull.userData.ink = ink;
    // Značka pro rig stínů (`ShadowFlags` ve `StyleRig.tsx`): bez ní by obal vrhal stín a kreslil se podruhé.
    hull.userData.rigShadow = 'off';
    hull.morphTargetInfluences = mesh.morphTargetInfluences;
    hull.morphTargetDictionary = mesh.morphTargetDictionary;
    if ((mesh as InstancedMesh).isInstancedMesh !== true) hull.frustumCulled = mesh.frustumCulled;
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
 * Obrys po kolika snímcích dorovná obaly: riggovaná postava má v podstromu kostru (zombie
 * 26 uzlů) a průchod každý snímek za každé tělo stál telefon (Pixel 7, CPU 4×) ~0,8 ms
 * snímku (P54B T15c). Nově dotažený model je bez obrysu nejvýš dva snímky.
 */
const INK_SCAN_FRAMES = 3;

/**
 * Obrys rodičovské skupiny: vlož jako dítě skupiny těla. Každý `INK_SCAN_FRAMES`. snímek
 * dorovná obaly nově dotažených sítí; první snímek hned.
 */
export function InkOutline({ ink }: { readonly ink: Ink }) {
  const anchor = useRef<Group>(null);
  const size = useThree((three) => three.size);
  const frames = useRef(0);
  useFrame(() => {
    setInkViewport(size.width, size.height);
    const parent = anchor.current?.parent;
    if (parent != null && frames.current++ % INK_SCAN_FRAMES === 0) inkMeshes(parent, ink);
  });
  // Značka rodiče hned při připojení: obrys kulis (`outlinable`) běží každý 30. snímek a model dotažený mezi
  // dvěma průchody obrysu těla by jinak mohl dostat inkoust kulisy místo rajčatového obrysu nepřítele.
  const mark = (group: Group | null) => {
    anchor.current = group;
    if (group?.parent != null) group.parent.userData.inkOwner = ink;
  };
  return <group ref={mark} />;
}
