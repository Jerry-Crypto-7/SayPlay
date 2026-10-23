/**
 * Načtení modelu katalogu pro arkádu – jedna cache pro těla rolí i kulisy.
 *
 * Kulisa (P28D T6) bere model slitý po materiálech: `townhouse` má 18 sítí,
 * slitý 5, takže řada domů podél trati nestojí stovky kreslicích volání navíc.
 */

import type { AnimationClip, Bone, KeyframeTrack, Material, Mesh, Object3D, Side, SkinnedMesh, Texture, TypedArray, WebGLProgramParametersWithUniforms } from 'three';
import { Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, FrontSide, Group, Matrix4, Mesh as MeshClass, MeshDepthMaterial, MeshStandardMaterial, PropertyBinding, SRGBColorSpace, SkinnedMesh as SkinnedMeshClass, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { type Flora, type Look, LOOK_WIND, type LookId } from '@/play/arcade/look';
import { modelPath } from '@/play/arcade/models';

import type { ToyPart } from '../toy/applyToy';
import { trackLoad } from './pending-loads';
import { type MotionPart, motionOf } from '../toy/body-class';
import type { QualityTier } from './rig/quality';
import { toonPatch } from './rig/toon';
import { plantPaint } from './vegetation-places';

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
    pending = trackLoad(
      new GLTFLoader()
        .loadAsync(modelPath(id))
        .then((gltf) => singlePass(gltf.scene as Object3D))
        .catch(() => null),
    );
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
    pending = trackLoad(loadModel(id).then((model) => (model === null ? null : flatten(model))));
    flatCache.set(id, pending);
  }
  return pending;
}

/**
 * Rostlina vegetace (P46G T4): celý model jako jedna geometrie s barvou ve vrcholech,
 * vysoká 1, pata v počátku. Jeden materiál pro všechny druhy, takže druh je jedna
 * `InstancedMesh` a barvy listí sady (`plantPaint`) jdou přebarvit ve vrcholech.
 */
export interface PlantModel {
  readonly geometry: BufferGeometry;
  /** Zdroj byl oboustranný (gen3d, plochy trávy). */
  readonly double: boolean;
}

/** Texely textury barvy v bodě UV. Paletová textura low-poly sady má na plochu jednu barvu, vrchol ji přečte celou. */
function texelsOf(texture: Texture): ((u: number, v: number, target: Color) => Color) | null {
  const image = texture.image as (CanvasImageSource & { readonly width: number; readonly height: number }) | null;
  if (image === null || !(image.width > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;
  context.drawImage(image, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
  const wrap = (t: number, size: number): number => Math.min(size - 1, Math.floor((t - Math.floor(t)) * size));
  return (u, v, target) => {
    // glTF: v = 0 je horní řádek obrázku, textura se nepřevrací (`flipY = false`).
    const row = texture.flipY ? height - 1 - wrap(v, height) : wrap(v, height);
    const at = (row * width + wrap(u, width)) * 4;
    return target.setRGB(data[at]! / 255, data[at + 1]! / 255, data[at + 2]! / 255, SRGBColorSpace);
  };
}

/** Barva materiálu × COLOR_0 × textura do barvy vrcholů, sítě do jedné geometrie, výška 1 a pata ve středu. */
function bakePlant(model: Object3D): PlantModel | null {
  model.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  let double = false;
  const color = new Color();
  const factor = new Color();
  model.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true || Array.isArray(mesh.material)) return;
    const material = mesh.material as MeshStandardMaterial;
    double ||= material.side === DoubleSide;
    const part = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const count = part.getAttribute('position').count;
    const vertex = part.getAttribute('color');
    const uv = part.getAttribute('uv');
    const texels = material.map === null || uv === undefined ? null : texelsOf(material.map);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      color.copy(material.color);
      if (vertex !== undefined) color.multiply(factor.fromBufferAttribute(vertex as BufferAttribute, i));
      if (texels !== null) color.multiply(texels(uv!.getX(i), uv!.getY(i), factor));
      color.toArray(colors, i * 3);
    }
    for (const name of Object.keys(part.attributes)) if (name !== 'position' && name !== 'normal') part.deleteAttribute(name);
    if (part.getAttribute('normal') === undefined) part.computeVertexNormals();
    part.setAttribute('color', new Float32BufferAttribute(colors, 3));
    parts.push(part);
  });
  if (parts.length === 0) return null;
  // Slít jde jen všechno s indexy, nebo všechno bez nich.
  const same = parts.every((part) => part.index !== null) ? parts : parts.map((part) => (part.index === null ? part : part.toNonIndexed()));
  const geometry = same.length === 1 ? same[0]! : mergeGeometries(same);
  if (geometry === null) return null;
  const box = new Box3().setFromBufferAttribute(geometry.getAttribute('position') as BufferAttribute);
  const center = box.getCenter(new Vector3());
  const unit = 1 / Math.max(box.max.y - box.min.y, 1e-3);
  geometry.translate(-center.x, -box.min.y, -center.z).scale(unit, unit, unit);
  return { geometry, double };
}

const plantCache = new Map<string, Promise<PlantModel | null>>();
const paintedCache = new Map<string, Promise<PlantModel | null>>();
const simpleCache = new Map<string, Promise<BufferAttribute | null>>();

/**
 * Zjednodušená rostlina telefonu (P54B T15d): pětina trojúhelníků, tvar nejvýš o 1 % výšky jinak
 * (strom 7 m o 7 cm, u kraje cesty pod 5 px telefonu). Hranice barev drží, ploše stínované modely
 * smí slévat i přes hrany (`Permissive`). Rostlina pod `SIMPLE_FROM` trojúhelníků zůstane celá.
 */
const SIMPLE_SHARE = 0.2;
const SIMPLE_ERROR = 0.01;
const SIMPLE_FROM = 600;

/** Indexy zjednodušené rostliny nad jejími vrcholy; `null` = kreslit celou (malá, nebo se zjednodušovač nenačetl). */
function simpleIndex(id: string, geometry: BufferGeometry): Promise<BufferAttribute | null> {
  let pending = simpleCache.get(id);
  if (pending === undefined) {
    const position = geometry.getAttribute('position');
    const count = geometry.index?.count ?? position.count;
    pending =
      count / 3 < SIMPLE_FROM
        ? Promise.resolve(null)
        : import('meshoptimizer/simplifier')
            .then(async ({ MeshoptSimplifier }) => {
              await MeshoptSimplifier.ready;
              const indices = geometry.index === null ? Uint32Array.from({ length: count }, (_, i) => i) : Uint32Array.from(geometry.index.array);
              const positions = new Float32Array(position.count * 3);
              for (let i = 0; i < position.count; i += 1) positions.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
              const colors = geometry.getAttribute('color').array as Float32Array;
              const target = Math.floor((count * SIMPLE_SHARE) / 3) * 3;
              const [simple] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, colors, 3, [1, 1, 1], null, target, SIMPLE_ERROR, ['Permissive']);
              return new BufferAttribute(simple, 1);
            })
            .catch(() => null);
    simpleCache.set(id, pending);
  }
  return pending;
}

/**
 * Rostlina `id` obarvená vegetací sady (`plantPaint`: listí, jehličí, podzim). Poloha,
 * normály a indexy se sdílejí mezi sadami, barvy má každá vlastní; `simple` (telefon)
 * vezme indexy zjednodušené (`simpleIndex`). Cache jako modely – nic se neuvolňuje.
 */
export function paintedPlant(id: string, flora: Flora, simple = false): Promise<PlantModel | null> {
  const key = `${id}|${flora.leaf}|${flora.autumn === true}|${simple}`;
  let pending = paintedCache.get(key);
  if (pending === undefined) {
    let baked = plantCache.get(id);
    if (baked === undefined) {
      baked = loadModel(id).then((model) => (model === null ? null : bakePlant(model)));
      plantCache.set(id, baked);
    }
    pending = baked.then(async (plant) => {
      if (plant === null) return null;
      const paint = plantPaint(id, flora);
      const source = plant.geometry.getAttribute('color') as BufferAttribute;
      const colors = new Float32Array(source.count * 3);
      const color = new Color();
      for (let i = 0; i < source.count; i += 1) paint(color.fromBufferAttribute(source, i)).toArray(colors, i * 3);
      const geometry = new BufferGeometry();
      geometry.setIndex((simple ? await simpleIndex(id, plant.geometry) : null) ?? plant.geometry.index);
      geometry.setAttribute('position', plant.geometry.getAttribute('position'));
      geometry.setAttribute('normal', plant.geometry.getAttribute('normal'));
      geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
      geometry.computeBoundingSphere();
      return { geometry, double: plant.double };
    });
    paintedCache.set(key, pending);
  }
  return pending;
}

/**
 * Vítr ve vegetaci (P54B T13): koruna se kývá, pata stojí – výchylka roste se čtvercem výšky vrcholu
 * (rostlina z `bakePlant` má výšku 1 a patu v y = 0). Fáze z polohy rostliny ve světě, kmit podle
 * její výšky (tráva rychleji než strom), směr ve světě pro všechny stejný. Čas a sílu nese `plantWind`,
 * nastavuje je `Wind` v rigu. Vypnutý vítr shader vůbec nemá: `low` a omezený pohyb nestojí nic.
 */
export const plantWind = { time: { value: 0 }, strength: { value: 0 } };
let windOn = false;

/** Výchylka vrcholu koruny při větru 1 (podíl výšky rostliny); kmit se k ní přičítá od −0,7 do 1,3. */
const BREEZE = 0.035;

const WIND_HEAD = '\nuniform float plantWindTime;\nuniform float plantWindStrength;';
const WIND_BODY = `
{
	mat4 windWorld = modelMatrix;
#ifdef USE_INSTANCING
	windWorld = modelMatrix * instanceMatrix;
#endif
	float windRate = 3.2 / sqrt(max(length(windWorld[1].xyz), 0.3));
	float windPhase = dot(windWorld[3].xz, vec2(0.35, 0.21));
	float windSway = 0.3 + 0.7 * sin(plantWindTime * windRate + windPhase) + 0.3 * sin(plantWindTime * windRate * 2.3 + windPhase * 1.7);
	vec3 windDir = normalize(transpose(mat3(windWorld)) * vec3(0.93, 0.0, 0.37));
	transformed += windDir * (plantWindStrength * windSway * transformed.y * transformed.y);
}`;

function windShader(shader: WebGLProgramParametersWithUniforms): void {
  if (!windOn) return;
  shader.uniforms.plantWindTime = plantWind.time;
  shader.uniforms.plantWindStrength = plantWind.strength;
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>${WIND_HEAD}`).replace('#include <begin_vertex>', `#include <begin_vertex>${WIND_BODY}`);
}

/** Síla větru scény: sada × nálada; na `low`, při omezeném pohybu a v sadě bez větru 0. */
export const plantWindFor = (look: Pick<Look, 'wind'>, lookId: LookId, tier: QualityTier, motion: boolean): number =>
  tier === 'low' || !motion ? 0 : BREEZE * LOOK_WIND[lookId] * (look.wind ?? 1);

const plantMaterials = new Map<boolean, MeshStandardMaterial>();
let depthMaterial: MeshDepthMaterial | null = null;

/** Zapne nebo vypne vítr všem rostlinám; three přeloží jen jejich programy (a příště vezme hotové). */
export function setPlantWind(on: boolean): void {
  if (on === windOn) return;
  windOn = on;
  for (const material of plantMaterials.values()) material.needsUpdate = true;
  if (depthMaterial !== null) depthMaterial.needsUpdate = true;
}

/**
 * Síla větru scény do uniformy. Shader se zapne první nenulovou silou a sestup na `low` ho už nevypne, jen ztiší:
 * sestup přichází, když zařízení nestíhá, a překlad programů by ho zasekl (P37B T7, `quality.ts`).
 */
export function blowPlantWind(strength: number): void {
  plantWind.strength.value = strength;
  if (strength > 0) setPlantWind(true);
}

/** Materiál všech rostlin: barva z vrcholů (a z instance), oboustranný pro zdroje, které oboustranné byly. */
export function plantMaterial(double: boolean): MeshStandardMaterial {
  let material = plantMaterials.get(double);
  if (material === undefined) {
    material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: double ? DoubleSide : FrontSide });
    material.onBeforeCompile = (shader) => {
      windShader(shader);
      toonPatch(shader, true);
    };
    material.customProgramCacheKey = () => (windOn ? 'plant-wind+toon' : 'plant+toon');
    material.userData.toon = true;
    plantMaterials.set(double, material);
  }
  return material;
}

/** Stín rostliny, která ho vrhá (`customDepthMaterial`): kývá se s ní, jinak by se koruna kývala ve vlastním nehybném stínu. */
export function plantDepthMaterial(): MeshDepthMaterial {
  if (depthMaterial === null) {
    depthMaterial = new MeshDepthMaterial();
    depthMaterial.onBeforeCompile = windShader;
    depthMaterial.customProgramCacheKey = () => (windOn ? 'plant-depth-wind' : 'plant-depth');
  }
  return depthMaterial;
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
    toonPatch(shader, true);
  };
  material.customProgramCacheKey = () => 'arcade-body+toon';
  material.userData.toon = true;
  bodyMaterials.set(side, material);
  return material;
}

/**
 * Zářící kopie materiálu modelu (věci arény svítí): záře má barvu materiálu.
 * Nese-li barvu vrchol – zlatá rybka (`COLOR_0` pod bílým materiálem) i slité
 * tělo –, záře se jí násobí; jinak z bílého materiálu zářila bílá a zlaté
 * rybky kočky byly bílé fleky (P35 T8). `clone()` úpravu shaderu nepřenese,
 * proto kopie volá tu zdrojovou (slité tělo bez ní kreslilo kov 1, skoro černě).
 * Záře je toon bez palety (P56B T6): zářící věc má svítit svou barvou, ne barvou sady.
 */
export function glowingCopy(source: Material, intensity: number): Material {
  const glow = source.clone();
  if (!(glow instanceof MeshStandardMaterial)) return glow;
  glow.emissive.copy(glow.color);
  glow.emissiveMap = glow.map;
  glow.emissiveIntensity = intensity;
  const tinted = glow.vertexColors;
  glow.onBeforeCompile = (shader, renderer) => {
    source.onBeforeCompile(shader, renderer);
    if (tinted) shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;');
    toonPatch(shader, false);
  };
  glow.customProgramCacheKey = () => `${source.customProgramCacheKey()}+glow`;
  glow.userData.toon = true;
  return glow;
}

/** Klon materiálu i s úpravou shaderu, kterou `clone()` nepřenese – záblesk zásahu bojovníka (`FightFx`). */
export function patchedClone<T extends Material>(source: T): T {
  const copy = source.clone() as T;
  copy.onBeforeCompile = source.onBeforeCompile;
  copy.customProgramCacheKey = source.customProgramCacheKey;
  return copy;
}

/**
 * Okrajový svit postav (P54B T14): hrdina, nepřítel a riggované postavy mají na hranách siluety
 * světlo barvy oblohy sady (`light[0]`) – Fresnel normály a směru ke kameře, přičtený k záři před
 * světly, takže ho ACES, ladění i mlha zpracují jako zbytek těla. Na telefonu (`low` bez AO a bloomu)
 * se riggovaná postava slévala se zemí (soud T15a: low-poly liška čitelnější než riggovaná).
 * Barvu a sílu nesou sdílené uniformy (`setCharacterRim` v rigu): sada, nálada ani úroveň kvality
 * program nepřekládají. Svítí na každé úrovni – pár operací na pixel postavy.
 */
export const characterRim = { color: { value: new Color() }, strength: { value: 0 } };

/**
 * Záře svitu na samé hraně siluety; dovnitř těla slábne s mocninou `RIM_POWER`. Svit má barvu těla
 * s podílem `RIM_WHITE` bílé: čistá barva oblohy (0,45, mocnina 3) lišku z kamery za zády vybělila
 * celou a slepý soud telefonu dal přednost syté postavě bez svitu (5 z 10). Bílý podíl zvedne i černého medvěda.
 */
export const RIM_STRENGTH = 0.35;
const RIM_POWER = '4.0';
const RIM_WHITE = '0.25';

const RIM_HEAD = '\nuniform vec3 rimColor;\nuniform float rimStrength;';
const RIM_BODY = `\n\ttotalEmissiveRadiance += rimColor * mix(diffuseColor.rgb, vec3(1.0), ${RIM_WHITE}) * (rimStrength * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), ${RIM_POWER}));`;

/** Barva svitu z palety scény (obloha polokoule, nálada a denní doba už v ní jsou). */
export function setCharacterRim(look: Pick<Look, 'light'>): void {
  characterRim.color.value.set(look.light[0]);
  characterRim.strength.value = RIM_STRENGTH;
}

function rimShader(shader: WebGLProgramParametersWithUniforms): void {
  shader.uniforms.rimColor = characterRim.color;
  shader.uniforms.rimStrength = characterRim.strength;
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>${RIM_HEAD}`).replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${RIM_BODY}`);
}

const rimCopies = new WeakMap<Material, Material>();

/**
 * Kopie materiálu se svitem, jedna na zdroj (sdílený materiál slitých těl tak dál kreslí mince bez
 * svitu). Kopie nese `userData.rim` i v klonech, aby se svit nevložil dvakrát. Neosvětlený materiál
 * (bez záře) zůstane.
 */
export function rimMaterial(source: Material): Material {
  if (source.userData.rim === true || !('emissive' in source)) return source;
  let copy = rimCopies.get(source);
  if (copy === undefined) {
    copy = source.clone();
    copy.userData.rim = true;
    copy.userData.toon = true;
    // Postava je toon bez palety (P56B T6): hrdina a nepřítel drží svou barvu proti zemi.
    copy.onBeforeCompile = (shader, renderer) => {
      source.onBeforeCompile(shader, renderer);
      toonPatch(shader, false);
      rimShader(shader);
    };
    copy.customProgramCacheKey = () => `${source.customProgramCacheKey()}+rim`;
    rimCopies.set(source, copy);
  }
  return copy;
}

const toonCopies = new WeakMap<Material, Material>();

/**
 * Toon kopie materiálu modelu, který se neslil (textura, průhlednost – P56B T6), jedna na zdroj.
 * Materiál, který toon už nese, a materiál mimo `MeshStandardMaterial` (jiné kotvy shaderu) zůstanou.
 */
export function toonMaterial(source: Material): Material {
  if (source.userData.toon === true || (source as MeshStandardMaterial).isMeshStandardMaterial !== true) return source;
  let copy = toonCopies.get(source);
  if (copy === undefined) {
    copy = source.clone();
    copy.userData.toon = true;
    copy.onBeforeCompile = (shader, renderer) => {
      source.onBeforeCompile(shader, renderer);
      toonPatch(shader, true);
    };
    copy.customProgramCacheKey = () => `${source.customProgramCacheKey()}+toon`;
    toonCopies.set(source, copy);
  }
  return copy;
}

/** Toon všem sítím kulisy pod `root` (klon modelu z `fitModel`); zdrojové materiály se nemění. */
export function toonLit(root: Object3D): Object3D {
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toonMaterial) : toonMaterial(mesh.material);
  });
  return root;
}

/** Svit všem sítím pod `root` – klon těla postavy nebo načtená riggovaná postava; zdrojové materiály se nemění. */
export function rimLit(root: Object3D): Object3D {
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(rimMaterial) : rimMaterial(mesh.material);
  });
  return root;
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

/** Odchylka od klidu, pod kterou je hodnota stopy klidová (vývoz z Blenderu má šum do ~1e-6). */
const REST_EPS = 1e-5;

/** Klidová hodnota vlastnosti uzlu, kterou stopa klipu přepisuje; jiné vlastnosti žádnou nemají. */
function restOf(node: Object3D, property: string): readonly number[] | null {
  if (property === 'position') return node.position.toArray();
  if (property === 'quaternion') return node.quaternion.toArray();
  if (property === 'scale') return node.scale.toArray();
  return null;
}

/** Stopa po celou dobu na klidové hodnotě kosti (natočení i jako −q). */
function atRest(track: KeyframeTrack, root: Object3D): boolean {
  const { nodeName, objectName, propertyName, propertyIndex } = PropertyBinding.parseTrackName(track.name);
  const node = objectName === undefined && propertyIndex === undefined ? PropertyBinding.findNode(root, nodeName) : null;
  const rest = node === null ? null : restOf(node as Object3D, propertyName);
  const size = track.getValueSize();
  // Kubická stopa glTF nese u každého klíče i tečny: velikost hodnoty nesedí a stopa zůstane.
  if (rest === null || size !== rest.length) return false;
  const values = track.values;
  const sign = propertyName === 'quaternion' && rest.reduce((sum, value, i) => sum + value * values[i]!, 0) < 0 ? -1 : 1;
  return values.every((value, i) => Math.abs(value - sign * rest[i % size]!) <= REST_EPS * Math.max(1, Math.abs(rest[i % size]!)));
}

/**
 * Klipy bez stop, které drží kost celou dobu v klidu (P54B T15c). Quaternius a KayKit vyvážejí
 * posun, natočení i měřítko každé kosti v každém klipu a 65–80 % stop se z klidu nehne; míchač
 * je přesto každý snímek vyhodnotí, smíchá a zapíše. Riggované zombie střelnice (69 stop,
 * 44–52 v klidu) tím stály telefon (Pixel 7, CPU 4×) 11 % FPS. Kost, na kterou klip nesahá,
 * drží míchač v hodnotě z doby navázání (`PropertyMixer`, zbytek váhy do 1) – tedy v klidu,
 * na který by ji klidová stopa nastavila: póza ani prolnutí klipů se nezmění. Mění klipy na
 * místě – volá se jednou na načtený model, před klonováním.
 */
export function dropRestTracks(clips: readonly AnimationClip[], root: Object3D): void {
  for (const clip of clips) clip.tracks = clip.tracks.filter((track) => !atRest(track, root));
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
    pending = trackLoad(loadModel(id).then((model) => (model === null ? null : bodyFor(model, id, posed))));
    bodyCache.set(key, pending);
  }
  return pending;
}
