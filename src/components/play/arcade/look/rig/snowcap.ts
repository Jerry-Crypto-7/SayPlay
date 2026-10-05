/**
 * Sněhová čepička kulis v zasněžené sadě (P32A T3): plochy s normálou nahoru
 * zbělají úpravou shaderu, žádné nové assety. Materiál se klonuje – model
 * katalogu sdílí materiály přes cache (`look/load.ts`) a jinde čepičku nemá.
 */

import { Color, type Material, type Mesh, type MeshStandardMaterial, type Object3D } from 'three';

/** Od jakého sklonu (y normály ve světě) sníh začíná a kde kryje celou plochu. */
const FROM = 0.55;
const FULL = 0.78;

const capped = new WeakMap<Material, Map<string, MeshStandardMaterial>>();

/** Klon materiálu s čepičkou barvy `cap`; jiný než neprůhledný `MeshStandardMaterial` vrátí beze změny. */
export function snowcapped(material: Material, cap: string): Material {
  if (material.type !== 'MeshStandardMaterial' || material.transparent || material.userData.snowcap === true) return material;
  let byCap = capped.get(material);
  if (byCap === undefined) capped.set(material, (byCap = new Map()));
  const known = byCap.get(cap);
  if (known !== undefined) return known;
  const clone = (material as MeshStandardMaterial).clone();
  clone.userData.snowcap = true;
  const color = new Color(cap);
  clone.onBeforeCompile = (shader) => {
    shader.uniforms.capColor = { value: color };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'varying float vCapUp;\n#include <common>')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n\tvCapUp = normalize(mat3(modelMatrix) * objectNormal).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'uniform vec3 capColor;\nvarying float vCapUp;\n#include <common>')
      .replace('#include <color_fragment>', `#include <color_fragment>\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, capColor, smoothstep(${FROM.toFixed(2)}, ${FULL.toFixed(2)}, vCapUp));`);
  };
  clone.customProgramCacheKey = () => 'snowcap';
  byCap.set(cap, clone);
  return clone;
}

/** Čepička na všech sítích podstromu. */
export function capSnow(root: Object3D, cap: string): void {
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh === true && !Array.isArray(mesh.material)) mesh.material = snowcapped(mesh.material, cap);
  });
}
