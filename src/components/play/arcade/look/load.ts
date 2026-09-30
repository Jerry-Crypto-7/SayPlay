/**
 * Načtení modelu katalogu pro arkádu – jedna cache pro těla rolí i kulisy.
 *
 * Kulisa (P28D T6) bere model slitý po materiálech: `townhouse` má 18 sítí,
 * slitý 5, takže řada domů podél trati nestojí stovky kreslicích volání navíc.
 */

import type { BufferGeometry, Material, Mesh, Object3D, Side } from 'three';
import { Float32BufferAttribute, Group, Mesh as MeshClass, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { modelPath } from '@/play/arcade/models';

const modelCache = new Map<string, Promise<Object3D | null>>();

export function loadModel(id: string): Promise<Object3D | null> {
  let pending = modelCache.get(id);
  if (pending === undefined) {
    pending = new GLTFLoader()
      .loadAsync(modelPath(id))
      .then((gltf) => gltf.scene as Object3D)
      .catch(() => null);
    modelCache.set(id, pending);
  }
  return pending;
}

/** Jedna síť na materiál; geometrie, které spolu slít nejdou, zůstanou samy. */
function flatten(model: Object3D): Object3D {
  model.updateMatrixWorld(true);
  const byMaterial = new Map<Material, BufferGeometry[]>();
  const out = new Group();
  model.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) {
      if (mesh.isMesh) out.add(new MeshClass(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld), mesh.material));
      return;
    }
    const list = byMaterial.get(mesh.material) ?? [];
    list.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
    byMaterial.set(mesh.material, list);
  });
  for (const [material, geometries] of byMaterial) {
    const merged = geometries.length > 1 ? mergeGeometries(geometries) : geometries[0];
    if (merged) out.add(new MeshClass(merged, material));
    else for (const geometry of geometries) out.add(new MeshClass(geometry, material));
  }
  return out;
}

const flatCache = new Map<string, Promise<Object3D | null>>();

export function loadFlatModel(id: string): Promise<Object3D | null> {
  let pending = flatCache.get(id);
  if (pending === undefined) {
    pending = loadModel(id).then((model) => (model === null ? null : flatten(model)));
    flatCache.set(id, pending);
  }
  return pending;
}

/** Mapy, které se do vrcholů rozepsat nedají – model s kteroukoli z nich zůstane, jak je. */
const MAPS = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap', 'envMap', 'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap'] as const;

const plainStandard = (material: Material | Material[]): material is MeshStandardMaterial =>
  !Array.isArray(material) &&
  material.type === 'MeshStandardMaterial' &&
  !material.transparent &&
  material.opacity === 1 &&
  !material.vertexColors &&
  MAPS.every((key) => (material as MeshStandardMaterial)[key] === null);

const bodyMaterials = new Map<Side, MeshStandardMaterial>();

/**
 * Jeden materiál pro všechna slitá těla (jeden program, jedno nahrání uniform):
 * barva z vrcholů, drsnost a kov z `pbr`, záře z `glow`.
 */
function bodyMaterial(side: Side): MeshStandardMaterial {
  let material = bodyMaterials.get(side);
  if (material !== undefined) return material;
  material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, side });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute vec2 pbr;\nattribute vec3 glow;\nvarying vec2 vPbr;\nvarying vec3 vGlow;\n#include <common>')
      .replace('#include <color_vertex>', '#include <color_vertex>\n\tvPbr = pbr;\n\tvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying vec2 vPbr;\nvarying vec3 vGlow;\n#include <common>')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor *= vPbr.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor *= vPbr.y;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vGlow;');
  };
  material.customProgramCacheKey = () => 'arcade-body';
  bodyMaterials.set(side, material);
  return material;
}

const constant = (count: number, values: readonly number[]): Float32BufferAttribute =>
  new Float32BufferAttribute(Float32Array.from({ length: count * values.length }, (_, i) => values[i % values.length]!), values.length);

/**
 * Tělo z jednoho kusu (P32A T2-R1): mince, překážka i terč jsou 3–5 sítí, každá
 * s vlastním materiálem, takže slití po materiálech (`flatten`) by kreslicí volání
 * neušetřilo. Materiál se proto rozepíše do vrcholů a tělo je jedna síť – jedno
 * volání v obraze i ve stínu (běžec na Pixel 7: ~200 volání na snímek, těla ~60 %).
 * Model s texturou, průhledností, kostrou nebo jiným materiálem se nechá, jak je.
 */
export function mergeBody(model: Object3D): Object3D {
  model.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  let side: Side | null = null;
  let plain = true;
  model.traverse((node) => {
    if (!plain) return;
    const mesh = node as Mesh;
    if (!mesh.isMesh) {
      plain = !('isPoints' in node || 'isLine' in node || 'isSprite' in node);
      return;
    }
    const { material, geometry } = mesh;
    if ('isSkinnedMesh' in mesh || 'isInstancedMesh' in mesh || !plainStandard(material) || (side !== null && material.side !== side) || Object.keys(geometry.morphAttributes).length > 0 || geometry.getAttribute('normal') === undefined) {
      plain = false;
      return;
    }
    side = material.side;
    const part = geometry.index === null ? geometry.clone() : geometry.toNonIndexed();
    for (const name of Object.keys(part.attributes)) if (name !== 'position' && name !== 'normal') part.deleteAttribute(name);
    part.applyMatrix4(mesh.matrixWorld);
    const count = part.getAttribute('position').count;
    const { r, g, b } = material.emissive;
    part.setAttribute('color', constant(count, [material.color.r, material.color.g, material.color.b]));
    part.setAttribute('pbr', constant(count, [material.roughness, material.metalness]));
    part.setAttribute('glow', constant(count, [r * material.emissiveIntensity, g * material.emissiveIntensity, b * material.emissiveIntensity]));
    part.clearGroups();
    parts.push(part);
  });
  if (!plain || side === null) return model;
  const merged = parts.length > 1 ? mergeGeometries(parts) : parts[0];
  return merged === null || merged === undefined ? model : new MeshClass(merged, bodyMaterial(side));
}

const bodyCache = new Map<string, Promise<Object3D | null>>();

/** Model těla role (`World.tsx`), slitý `mergeBody`. */
export function loadBodyModel(id: string): Promise<Object3D | null> {
  let pending = bodyCache.get(id);
  if (pending === undefined) {
    pending = loadModel(id).then((model) => (model === null ? null : mergeBody(model)));
    bodyCache.set(id, pending);
  }
  return pending;
}
