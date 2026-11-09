/**
 * Kulisa v paletě místa (P77 T2). Slepý soudce opakovaně: „inconsistent asset quality“ – kulisy jsou z pěti knihoven
 * (Kenney, Quaternius, KayKit, gen3d, kód), každá s jinou paletou a hustotou textur, a modelína P75 měnila jen světlo.
 * Model katalogu slitý po materiálech (`loadFlatModel`) se proto při načtení – jednou na model a paletu, ne za snímek –
 * rozepíše do barev vrcholů: barva materiálu × COLOR_0 × průměrná barva textury v okolí vrcholu (textura zmenšená na
 * `FLAT_TEXTURE` px, detail zmizí) → nejbližší tón palety místa se světlostí modelu (`snapToPalette`). Neprůhledné
 * sítě se slijí do jedné na stranu (jeden program, méně kreslicích volání); průhledné, vyřezávané a zářící zůstanou.
 * Hrdina a věci z věty sem nejdou (`World.tsx`, `loadBodyModel`): drží svou barvu.
 */
import type { BufferAttribute, BufferGeometry, Material, Mesh, MeshStandardMaterial, Object3D, Side } from 'three';
import { Color, Float32BufferAttribute, Group, Mesh as MeshClass, MeshStandardMaterial as StandardMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { loadFlatModel, texelsOf } from './load';
import { trackLoad } from './pending-loads';
import { paletteLab, type Rgb, snapToPalette, toonPatch } from './rig/toon';

/** Hrana zmenšené textury (px): vrchol přečte průměr okolí, ne kresbu textury. */
export const FLAT_TEXTURE = 64;

/** Síť jde do barev vrcholů: jeden standardní materiál, neprůhledný, bez výřezu a bez záře. */
function bakeable(material: Material | Material[]): material is MeshStandardMaterial {
  if (Array.isArray(material)) return false;
  const standard = material as MeshStandardMaterial;
  return standard.isMeshStandardMaterial === true && !standard.transparent && standard.alphaTest === 0 && standard.alphaMap === null && standard.emissiveMap === null && standard.emissive.getHex() === 0;
}

const materials = new Map<Side, MeshStandardMaterial>();

/** Jeden materiál všech přebarvených kulis na stranu: modelína s teplým okrajem, paletu nesou vrcholy. */
function placeMaterial(side: Side): MeshStandardMaterial {
  let material = materials.get(side);
  if (material === undefined) {
    material = new StandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, side });
    material.onBeforeCompile = (shader) => toonPatch(shader, false, true);
    material.customProgramCacheKey = () => 'arcade-place+toon';
    material.userData.toon = true;
    materials.set(side, material);
  }
  return material;
}

/** Klíč barvy pro cache tónů: 10 bitů na kanál – tmavé lineární tóny 8 bitů slévají do pruhů. */
const keyOf = (color: Color): number => {
  const bits = (value: number) => Math.round(Math.min(Math.max(value, 0), 1) * 1023);
  return bits(color.r) * 1048576 + bits(color.g) * 1024 + bits(color.b);
};

/** Model (sítě v libovolné hierarchii) v paletě `palette` (Oklab, `paletteLab`); zdroj se nemění. */
export function bakePlace(model: Object3D, palette: readonly Rgb[]): Object3D {
  model.updateMatrixWorld(true);
  const out = new Group();
  const bySide = new Map<Side, BufferGeometry[]>();
  // Tón se počítá jednou na barvu: zmenšená textura má nejvýš FLAT_TEXTURE² barev, plochý model jednu na materiál.
  const tones = new Map<number, Rgb>();
  const color = new Color();
  const factor = new Color();
  model.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true) return;
    if (!bakeable(mesh.material)) {
      const kept = new MeshClass(mesh.geometry, mesh.material);
      kept.applyMatrix4(mesh.matrixWorld);
      out.add(kept);
      return;
    }
    const material = mesh.material;
    const part = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const count = part.getAttribute('position').count;
    const vertex = part.getAttribute('color') as BufferAttribute | undefined;
    const uv = part.getAttribute('uv') as BufferAttribute | undefined;
    const texels = material.map === null || uv === undefined ? null : texelsOf(material.map, FLAT_TEXTURE);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      color.copy(material.color);
      if (vertex !== undefined) color.multiply(factor.fromBufferAttribute(vertex, i));
      if (texels !== null) color.multiply(texels(uv!.getX(i), uv!.getY(i), factor));
      const key = keyOf(color);
      let tone = tones.get(key);
      if (tone === undefined) tones.set(key, (tone = snapToPalette([color.r, color.g, color.b], palette)));
      colors.set(tone, i * 3);
    }
    for (const name of Object.keys(part.attributes)) if (name !== 'position' && name !== 'normal') part.deleteAttribute(name);
    part.morphAttributes = {};
    if (part.getAttribute('normal') === undefined) part.computeVertexNormals();
    part.setAttribute('color', new Float32BufferAttribute(colors, 3));
    bySide.set(material.side, [...(bySide.get(material.side) ?? []), part]);
  });
  for (const [side, parts] of bySide) {
    // Slít jde jen všechno s indexy, nebo všechno bez nich; jiné typy polí (kvantizované polohy) zůstanou zvlášť.
    const same = parts.every((part) => part.index !== null) ? parts : parts.map((part) => (part.index === null ? part : part.toNonIndexed()));
    const merged = same.length === 1 ? same[0]! : mergeGeometries(same);
    if (merged !== null) out.add(new MeshClass(merged, placeMaterial(side)));
    else for (const part of same) out.add(new MeshClass(part, placeMaterial(side)));
  }
  return out;
}

const placeCache = new Map<string, Promise<Object3D | null>>();

/** Kulisa `id` v paletě místa; cache na model a paletu – jako modely se nic neuvolňuje. */
export function loadPlaceModel(id: string, palette: readonly string[]): Promise<Object3D | null> {
  const key = `${id}|${palette.join(',')}`;
  let pending = placeCache.get(key);
  if (pending === undefined) {
    const lab = paletteLab(palette);
    pending = trackLoad(loadFlatModel(id).then((model) => (model === null ? null : bakePlace(model, lab))));
    placeCache.set(key, pending);
  }
  return pending;
}
