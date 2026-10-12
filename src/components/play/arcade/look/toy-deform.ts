/**
 * Deformace vrcholů těla bez kostry (P45D T6): ~900 modelů je jedna síť, takže
 * křídla, ocas a nohy nejsou díly. Vertex shader ohne oblast podle prahů z
 * `catalog-motion.json` (`regions`, jednotky modelu):
 *
 * - křídla – vrchol s |x − midX| > wingX se otočí kolem kloubu na okraji trupu
 *   (obě křídla nahoru při `flap` > 0, jako díl `wing` v `applyToy`);
 * - ocas – vrchol za z < tailZ se otočí kolem y podle `sway + stride`;
 * - nohy – vrchol pod y < legY se střihne po z podle `stride`, znaménko podle strany x.
 *
 * Každé tělo dostane klon materiálu se stejným `customProgramCacheKey`: three pak
 * sdílí program (žádná nová kompilace) a uniformy má každý klon své. Normály se
 * neohýbají a stín kreslí nedeformovanou síť – hračka, ne kostra.
 */

import type { Material, Mesh, Object3D, WebGLProgramParametersWithUniforms } from 'three';
import { Box3, Matrix4, Vector3, Vector4 } from 'three';

import { LEG, TAIL, WING, type ToyDeform } from '../toy/applyToy';
import type { ToyRegions } from '../toy/body-class';

/** Práh oblasti, kterou model nemá: žádný vrchol za ním neleží. */
const FAR = 1e6;

/** Uniformy jedné sítě: póza sdílená celým tělem, prahy a převod sítě do prostoru modelu. */
export interface ToyUniforms extends ToyDeform {
  readonly toyRegions: { value: Vector4 };
  readonly toyFrame: { value: Matrix4 };
  readonly toyFrameInv: { value: Matrix4 };
}

const GLSL = /* glsl */ `
uniform float toyFlap;
uniform float toySway;
uniform float toyStride;
uniform vec4 toyRegions;
uniform mat4 toyFrame;
uniform mat4 toyFrameInv;
vec3 toyDeform(vec3 local) {
  vec3 q = (toyFrame * vec4(local, 1.0)).xyz;
  vec3 p = q;
  float d = q.x - toyRegions.x;
  float reach = abs(d) - toyRegions.y;
  if (reach > 0.0) {
    float a = ${WING.toFixed(4)} * toyFlap;
    float hinge = toyRegions.x + sign(d) * toyRegions.y;
    p.x = hinge + (q.x - hinge) * cos(a);
    p.y += reach * sin(a);
  }
  float back = toyRegions.z - q.z;
  if (back > 0.0) {
    float a = ${TAIL.toFixed(4)} * (toySway + toyStride);
    p.x -= back * sin(a);
    p.z = toyRegions.z - back * cos(a);
  }
  float below = toyRegions.w - q.y;
  if (below > 0.0) p.z -= below * sin(sign(d) * ${LEG.toFixed(4)} * toyStride);
  return (toyFrameInv * vec4(p, 1.0)).xyz;
}`;

/** Vloží deformaci do vertex shaderu s chunky three (`common`, `begin_vertex`) – tělo i obrys. */
export const withToyDeform = (vertexShader: string): string =>
  vertexShader.replace('#include <common>', `#include <common>\n${GLSL}`).replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed = toyDeform(transformed);');

/** CPU obraz GLSL `toyDeform` v prostoru modelu (`regions` = midX, wingX, tailZ, legY). */
export function deformPoint(point: Vector3, regions: Vector4, pose: { readonly flap: number; readonly sway: number; readonly stride: number }): Vector3 {
  const p = point.clone();
  const d = point.x - regions.x;
  const reach = Math.abs(d) - regions.y;
  if (reach > 0) {
    const a = WING * pose.flap;
    const hinge = regions.x + Math.sign(d) * regions.y;
    p.x = hinge + (point.x - hinge) * Math.cos(a);
    p.y += reach * Math.sin(a);
  }
  const back = regions.z - point.z;
  if (back > 0) {
    const a = TAIL * (pose.sway + pose.stride);
    p.x -= back * Math.sin(a);
    p.z = regions.z - back * Math.cos(a);
  }
  const below = regions.w - point.y;
  if (below > 0) p.z -= below * Math.sin(Math.sign(d) * LEG * pose.stride);
  return p;
}

/**
 * Klon materiálu s deformací. `clone()` úpravu shaderu nepřenese, proto obal volá
 * tu zdrojovou (slité tělo bez ní kreslí kov 1, skoro černě – viz `glowingCopy`).
 */
export function deformMaterial(source: Material, uniforms: ToyUniforms): Material {
  const copy = source.clone();
  copy.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    source.onBeforeCompile(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = withToyDeform(shader.vertexShader);
  };
  copy.customProgramCacheKey = () => `${source.customProgramCacheKey()}+toy`;
  copy.userData.toyDeform = uniforms;
  return copy;
}

/**
 * Každé síti pod `root` (klon těla jedné postavy) dá klon materiálu s deformací
 * oblastí `regions`; vrací uniformy pózy pro `applyToy`, bez oblastí nic nemění.
 * Síť nemusí ležet v prostoru modelu (nesloučený model má vlastní matice), proto
 * nese převod `toyFrame`. Střed x bez křídel (strana nohou) je střed modelu.
 */
export function deformBody(root: Object3D, regions: ToyRegions | undefined): ToyDeform | undefined {
  if (regions === undefined) return undefined;
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const meshes: { readonly mesh: Mesh; readonly frame: Matrix4 }[] = [];
  const box = new Box3();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true) return;
    const frame = toRoot.clone().multiply(mesh.matrixWorld);
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(frame));
    meshes.push({ mesh, frame });
  });
  const deform: ToyDeform = { toyFlap: { value: 0 }, toySway: { value: 0 }, toyStride: { value: 0 } };
  const bounds = new Vector4(regions.midX ?? (box.min.x + box.max.x) / 2, regions.wingX ?? FAR, regions.tailZ ?? -FAR, regions.legY ?? -FAR);
  for (const { mesh, frame } of meshes) {
    const uniforms: ToyUniforms = { ...deform, toyRegions: { value: bounds }, toyFrame: { value: frame }, toyFrameInv: { value: frame.clone().invert() } };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((material) => deformMaterial(material, uniforms)) : deformMaterial(mesh.material, uniforms);
  }
  return deform;
}
