import { MeshStandardMaterial, DoubleSide } from 'three';

/** Core PBR values. Colors are sRGB inputs converted by Three; roughness is linear. */
export const SURFACES = {
  wood: { color:'#926441',roughness:0.62,metalness:0 },
  metal: { color:'#9ba5a8',roughness:0.28,metalness:0.85 },
  wall: { color:'#d6d0bc',roughness:0.91,metalness:0 },
  fabric: { color:'#497071',roughness:0.96,metalness:0 },
  glass: { color:'#aecfd1',roughness:0.12,metalness:0,transparent:true,opacity:0.22,depthWrite:false },
  water: { color:'#397f89',roughness:0.17,metalness:0.22,transparent:true,opacity:0.72,depthWrite:false },
} as const;
export type Surface = keyof typeof SURFACES;
export function surfaceMaterial(surface: Surface) {
  const material = new MeshStandardMaterial({...SURFACES[surface],side:DoubleSide});
  material.name = `surface:${surface}`;
  // Analytic triplanar grain: the same physical size on SDF, parametric and
  // instanced geometry, without depending on each generator's UV packing.
  // The derivative filter removes subpixel detail; this is static under replay.
  if (surface !== 'glass' && surface !== 'water') {
    material.customProgramCacheKey = () => `worldstream-surface-v1:${surface}`;
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSurfacePosition;')
        .replace('#include <project_vertex>', `
          vec4 surfacePosition = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            surfacePosition = batchingMatrix * surfacePosition;
          #endif
          #ifdef USE_INSTANCING
            surfacePosition = instanceMatrix * surfacePosition;
          #endif
          vSurfacePosition = (modelMatrix * surfacePosition).xyz;
          #include <project_vertex>`);
      const pattern = surface === 'wood'
        ? 'sin(p.x * 95.0 + 2.0 * sin(p.y * 3.5) + sin(p.y * 13.0))'
        : surface === 'fabric' ? 'sin(p.x * 360.0) * sin(p.y * 360.0)'
        : surface === 'metal' ? 'sin(p.x * 280.0 + sin(p.y * 6.0))'
        : 'sin(p.x * 150.0) * sin(p.y * 167.0)';
      const frequency = surface === 'fabric' ? 360 : surface === 'metal' ? 280 : surface === 'wall' ? 167 : 95;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vSurfacePosition;
        float surfaceGrain(vec2 p) {
          float filterWidth = max(fwidth(p.x), fwidth(p.y)) * ${frequency.toFixed(1)};
          return (${pattern}) * (1.0 - smoothstep(0.7, 3.0, filterWidth));
        }
        float surfaceValue(vec3 p) {
          vec3 weights = pow(abs(normalize(cross(dFdx(p), dFdy(p)))), vec3(4.0));
          weights /= max(weights.x + weights.y + weights.z, 0.0001);
          return dot(weights, vec3(surfaceGrain(p.yz), surfaceGrain(p.xz), surfaceGrain(p.xy)));
        }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float surfaceDetail = surfaceValue(vSurfacePosition);
          diffuseColor.rgb *= 1.0 + surfaceDetail * ${surface === 'wood' ? '0.12' : '0.035'};`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor + surfaceDetail * 0.035, 0.04, 1.0);`);
    };
  }
  return material;
}
export function readSurface(value: string | undefined): Surface | undefined {
  return value && Object.hasOwn(SURFACES,value.toLowerCase()) ? value.toLowerCase() as Surface : undefined;
}
