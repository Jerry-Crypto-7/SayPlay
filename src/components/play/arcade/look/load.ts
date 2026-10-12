/**
 * Načtení modelu katalogu pro arkádu – jedna cache pro těla rolí i kulisy.
 *
 * Kulisa (P28D T6) bere model slitý po materiálech: `townhouse` má 18 sítí,
 * slitý 5, takže řada domů podél trati nestojí stovky kreslicích volání navíc.
 */

import type { Bone, BufferGeometry, Material, Mesh, Object3D, Side, SkinnedMesh, TypedArray } from 'three';
import { BufferAttribute, DoubleSide, Float32BufferAttribute, Group, Matrix4, Mesh as MeshClass, MeshStandardMaterial, SkinnedMesh as SkinnedMeshClass } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { modelPath } from '@/play/arcade/models';

import type { ToyPart } from '../toy/applyToy';
import { type MotionPart, motionOf } from '../toy/body-class';

const modelCache = new Map<string, Promise<Object3D | null>>();

/**
 * Průhledný oboustranný materiál kreslí three dvěma průchody (rub, líc) a před každým
 * mu nastaví `needsUpdate`, takže každé kreslení znovu hodnotí program. Sklo a voda
 * akvária to dělaly 12× za snímek a stály kočičí arénu na telefonu desetinu snímku
 * (P35 T4). Jeden průchod stačí: tenké sklo ani hladina se samy nepřekrývají.
 */
export function singlePass(model: Object3D): Object3D {
  model.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material.transparent && material.side === DoubleSide) material.forceSinglePass = true;
    }
  });
  return model;
}

export function loadModel(id: string): Promise<Object3D | null> {
  let pending = modelCache.get(id);
  if (pending === undefined) {
    pending = new GLTFLoader()
      .loadAsync(modelPath(id))
      .then((gltf) => singlePass(gltf.scene as Object3D))
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

/**
 * Zářící kopie materiálu modelu (věci arény svítí): záře má barvu materiálu.
 * Nese-li barvu vrchol – zlatá rybka (`COLOR_0` pod bílým materiálem) i slité
 * tělo –, záře se jí násobí; jinak z bílého materiálu zářila bílá a zlaté
 * rybky kočky byly bílé fleky (P35 T8). `clone()` úpravu shaderu nepřenese,
 * proto kopie volá tu zdrojovou (slité tělo bez ní kreslilo kov 1, skoro černě).
 */
export function glowingCopy(source: Material, intensity: number): Material {
  const glow = source.clone();
  if (!(glow instanceof MeshStandardMaterial)) return glow;
  glow.emissive.copy(glow.color);
  glow.emissiveMap = glow.map;
  glow.emissiveIntensity = intensity;
  if (!glow.vertexColors) return glow;
  glow.onBeforeCompile = (shader, renderer) => {
    source.onBeforeCompile(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;');
  };
  glow.customProgramCacheKey = () => `${source.customProgramCacheKey()}+glow`;
  return glow;
}

const constant = (count: number, values: readonly number[]): Float32BufferAttribute =>
  new Float32BufferAttribute(Float32Array.from({ length: count * values.length }, (_, i) => values[i % values.length]!), values.length);

/**
 * Tělo z jednoho kusu (P32A T2-R1): mince, překážka i terč jsou 3–5 sítí, každá
 * s vlastním materiálem, takže slití po materiálech (`flatten`) by kreslicí volání
 * neušetřilo. Materiál se proto rozepíše do vrcholů a tělo je jedna síť – jedno
 * volání v obraze i ve stínu (běžec na Pixel 7: ~200 volání na snímek, těla ~60 %).
 *
 * Model s texturou, průhledností nebo jiným materiálem se slije aspoň po materiálech,
 * když to sítě ušetří (P35 T4): akvárium „glowing fish“ (19 sítí, sklo a voda průhledné)
 * zůstávalo celé a kočičí aréna se 14 rybami kreslila ~180 volání na snímek – Pixel 7
 * se 4× CPU 15 FPS (O10). Model s kostrou, instancemi, morfy, body nebo čarami se nechá, jak je.
 */
export function mergeBody(model: Object3D): Object3D {
  model.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  let side: Side | null = null;
  let plain = true;
  let rigid = true;
  let meshes = 0;
  model.traverse((node) => {
    if (!rigid) return;
    const mesh = node as Mesh;
    if (!mesh.isMesh) {
      rigid = !('isPoints' in node || 'isLine' in node || 'isSprite' in node);
      return;
    }
    meshes += 1;
    const { material, geometry } = mesh;
    if ('isSkinnedMesh' in mesh || 'isInstancedMesh' in mesh || Object.keys(geometry.morphAttributes).length > 0) {
      rigid = false;
      return;
    }
    if (!plain) return;
    if (!plainStandard(material) || (side !== null && material.side !== side) || geometry.getAttribute('normal') === undefined) {
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
  if (!rigid) return model;
  if (!plain || side === null) {
    const flat = flatten(model);
    return flat.children.length < meshes ? flat : model;
  }
  const merged = parts.length > 1 ? mergeGeometries(parts) : parts[0];
  return merged === null || merged === undefined ? model : new MeshClass(merged, bodyMaterial(side));
}

/** Síť a všichni předci až po `root` jsou vidět. */
function shownUnder(node: Object3D, root: Object3D): boolean {
  for (let at: Object3D | null = node; at !== null && at !== root; at = at.parent) if (!at.visible) return false;
  return true;
}

/** Stejný typ pole a normalizace jako `like`, `count` × 4 složky. */
const skinAttribute = (like: BufferAttribute, count: number): BufferAttribute =>
  new BufferAttribute(new (like.array.constructor as new (length: number) => TypedArray)(count * 4), 4, like.normalized);

/**
 * Riggovaná postava z jednoho kusu (P36C T9): rytíř KayKit je 6 riggovaných sítí a 9 tuhých
 * (zbraně, štíty, helma) zavěšených na kostech, všechno jedním materiálem – s obrysem
 * (T6) a stínem 45 kreslicích volání na postavu; dva rytíři byli na telefonu víc než
 * polovina arény. Sítě se slijí do jedné SkinnedMesh na materiál a kostru:
 *
 * - riggovaná geometrie se předem přenese svou `bindMatrix` – slitá síť má vazbu jednotkovou;
 * - tuhá dostane váhu 1 na kost, pod kterou visí, a geometrii v prostoru vazby té kosti
 *   (`boneInverse⁻¹ · kost⁻¹ · síť`, vše v klidu).
 *
 * Attached bind přepočítá `bindMatrixInverse` z `matrixWorld`, takže poloha vrcholu pak
 * závisí jen na kostech a slitá postava stojí v každé póze tam, kde stály díly. Model bez
 * kostry, síť s morfy, víc materiály, dětmi, cizí kostrou, jinými atributy nebo skrytá
 * zůstane, jak je. Mění `root` na místě – volá se jednou na načtený model, před klonováním.
 */
export function mergeRig(root: Object3D): Object3D {
  root.updateMatrixWorld(true);
  let skeleton: SkinnedMesh['skeleton'] | null = null;
  let template: BufferGeometry | null = null;
  root.traverse((node) => {
    if (skeleton === null && (node as SkinnedMesh).isSkinnedMesh === true) {
      skeleton = (node as SkinnedMesh).skeleton;
      template = (node as SkinnedMesh).geometry;
    }
  });
  if (skeleton === null || template === null) return root;
  const { bones, boneInverses } = skeleton as SkinnedMesh['skeleton'];
  const skinIndex = (template as BufferGeometry).getAttribute('skinIndex') as BufferAttribute;
  const skinWeight = (template as BufferGeometry).getAttribute('skinWeight') as BufferAttribute;
  const sameBones = (other: SkinnedMesh['skeleton']): boolean => other.bones.length === bones.length && other.bones.every((bone, i) => bone === bones[i]);

  const groups = new Map<Material, { readonly sources: Mesh[]; readonly parts: BufferGeometry[] }>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    const { geometry, material } = mesh;
    if (mesh.isMesh !== true || mesh.children.length > 0 || Array.isArray(material) || Object.keys(geometry.morphAttributes).length > 0 || !shownUnder(mesh, root)) return;
    let part: BufferGeometry;
    if ((mesh as SkinnedMesh).isSkinnedMesh === true) {
      if (!sameBones((mesh as SkinnedMesh).skeleton)) return;
      part = geometry.clone().applyMatrix4((mesh as SkinnedMesh).bindMatrix);
    } else {
      let bone: Object3D | null = mesh.parent;
      while (bone !== null && !bones.includes(bone as Bone)) bone = bone === root ? null : bone.parent;
      if (bone === null) return;
      const index = bones.indexOf(bone as Bone);
      const toBind = boneInverses[index]!.clone().invert().multiply(bone.matrixWorld.clone().invert()).multiply(mesh.matrixWorld);
      part = geometry.clone().applyMatrix4(toBind);
      const count = part.getAttribute('position').count;
      const indices = skinAttribute(skinIndex, count);
      const weights = skinAttribute(skinWeight, count);
      for (let i = 0; i < count; i += 1) {
        indices.setXYZW(i, index, 0, 0, 0);
        weights.setXYZW(i, 1, 0, 0, 0);
      }
      part.setAttribute('skinIndex', indices);
      part.setAttribute('skinWeight', weights);
    }
    part.clearGroups();
    const group = groups.get(material) ?? { sources: [], parts: [] };
    group.sources.push(mesh);
    group.parts.push(part);
    groups.set(material, group);
  });

  const identity = new Matrix4();
  for (const [material, { sources, parts }] of groups) {
    if (parts.length < 2) continue;
    // Jiné atributy nebo index jen u části dílů: `mergeGeometries` by vrátil null s chybou v konzoli.
    const shape = (part: BufferGeometry): string => `${part.index !== null}:${Object.keys(part.attributes).sort().join(',')}`;
    if (parts.some((part) => shape(part) !== shape(parts[0]!))) continue;
    const geometry = mergeGeometries(parts);
    if (geometry === null) continue;
    const merged = new SkinnedMeshClass(geometry, material);
    merged.frustumCulled = sources.every((source) => source.frustumCulled);
    root.add(merged);
    merged.bind(skeleton, identity);
    for (const source of sources) source.removeFromParent();
  }
  return root;
}

/** Nejvýš tolik pohyblivých dílů na tělo – každý je síť (a obrys) navíc. */
export const MAX_PARTS = 2;

/** Pivot vyčleněného dílu nese roli a stranu (−1, 1) podle x pivotu – `toyPartsOf`. */
interface PartTag {
  readonly role: string;
  readonly side: number;
}

/**
 * Tělo, které se hýbe (P45D T6): nejvýš `MAX_PARTS` dílů z `catalog-motion.json`
 * se vyčlení jako vlastní slitá síť pod skupinou v pivotu, zbytek se slije jako
 * dřív. Sdílený model z `loadModel` zůstane celý – díly se odebírají z klonu.
 * Pivot je poloha uzlu v prostoru modelu, tedy v prostoru slité geometrie.
 */
export function mergePosed(model: Object3D, parts: readonly MotionPart[]): Object3D {
  const rest = model.clone(true);
  rest.updateMatrixWorld(true);
  const out = new Group();
  for (const part of parts) {
    if (out.children.length === MAX_PARTS) break;
    const node = rest.getObjectByName(part.node);
    if (node === undefined) continue;
    const piece = node.clone(true);
    node.matrixWorld.decompose(piece.position, piece.quaternion, piece.scale);
    node.removeFromParent();
    const [x, y, z] = part.pivot;
    const body = mergeBody(new Group().add(piece));
    body.position.set(-x, -y, -z);
    const pivot = new Group();
    pivot.position.set(x, y, z);
    pivot.userData.toyPart = { role: part.role, side: Math.sign(x) || 1 } satisfies PartTag;
    out.add(pivot.add(body));
  }
  return out.children.length === 0 ? mergeBody(model) : out.add(mergeBody(rest));
}

/** Díly těla z `mergePosed` pro `applyToy`; pivoty se hýbou, jejich matice se nesmí zmrazit. */
export function toyPartsOf(root: Object3D): ToyPart[] {
  const parts: ToyPart[] = [];
  root.traverse((node) => {
    const tag = node.userData.toyPart as PartTag | undefined;
    if (tag !== undefined) parts.push({ pivot: node, role: tag.role, side: tag.side });
  });
  return parts;
}

/** Tělo modelu `id`: hýbající se role (`posed`) s díly v katalogu je dostane vyčleněné, jinak jedna síť. */
export function bodyFor(model: Object3D, id: string, posed: boolean): Object3D {
  const parts = posed ? motionOf(id)?.parts : undefined;
  return parts === undefined ? mergeBody(model) : mergePosed(model, parts);
}

const bodyCache = new Map<string, Promise<Object3D | null>>();

/** Model těla role (`World.tsx`), slitý `mergeBody`; `posed` = role, která se hýbe (hrdina, nepřítel). */
export function loadBodyModel(id: string, { posed = false }: { readonly posed?: boolean } = {}): Promise<Object3D | null> {
  const key = posed && motionOf(id)?.parts !== undefined ? `${id}:posed` : id;
  let pending = bodyCache.get(key);
  if (pending === undefined) {
    pending = loadModel(id).then((model) => (model === null ? null : bodyFor(model, id, posed)));
    bodyCache.set(key, pending);
  }
  return pending;
}
