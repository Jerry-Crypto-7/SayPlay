'use client';

/**
 * Kulisa za mlhou (P46G T6): prstence siluet z `backdrop-shapes.ts`, každá
 * vrstva jedna síť – nejvýš tři volání kreslení navíc. Bez světla a stínu
 * (`MeshBasicMaterial` s barvami ve vrcholech), s mlhou: vzdálená vrstva
 * v ní mizí víc než bližší, mlha zůstává a konečně má co schovávat.
 *
 * Prstenec jede s kamerou (paralaxa v `layerAt`). Poloha se počítá
 * v `onBeforeRender` z kamery, kterou se právě kreslí: `useFrame` kulisy by
 * běžel před snímkem `World`, který kameru teprve postaví, a vrstva by o snímek
 * zaostávala. Jen vzhled: jádro o kulise neví, hash se nehne.
 */

import { useEffect, useMemo } from 'react';
import { DoubleSide, Mesh, MeshBasicMaterial, Vector3 } from 'three';

import type { Look } from '@/play/arcade/look';

import { buildBackdrop, layerAt } from './backdrop-shapes';

export interface HorizonBackdropProps {
  readonly look: Look;
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Délka trati (m): na jejím konci je vrstva o `approach` blíž. */
  readonly length: number;
  /** Půl šířky průseku nad cestou v nejbližší vrstvě (m). */
  readonly clear: number;
  /** Jak hluboko pata sahá pod zem (m); závod má rovinu, běžec kopce trati. */
  readonly skirt?: number;
  /** Výška trati v `z` (kopce běžce); bez ní rovina y = 0. */
  readonly ground?: (z: number) => number;
}

const eye = new Vector3();

export function HorizonBackdrop({ look, seed, length, clear, skirt = 0.05, ground }: HorizonBackdropProps) {
  const parts = useMemo(() => buildBackdrop(look, { seed, clear, skirt }), [look, seed, clear, skirt]);
  const material = useMemo(() => new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }), []);
  const meshes = useMemo(
    () =>
      parts.map(({ layer, geometry }) => {
        const mesh = new Mesh(geometry, material);
        mesh.name = `backdrop-${layer.kind}`;
        // Prstenec je všude kolem kamery; ořez by počítal se starou polohou.
        mesh.frustumCulled = false;
        mesh.userData.rigShadow = 'none';
        mesh.onBeforeRender = (_renderer, _scene, camera) => {
          eye.setFromMatrixPosition(camera.matrixWorld);
          const { x, z } = layerAt(layer, eye.x, eye.z, length);
          mesh.position.set(x, ground?.(z + layer.radius) ?? 0, z);
          mesh.updateMatrixWorld();
        };
        return mesh;
      }),
    [parts, material, length, ground],
  );
  useEffect(() => () => parts.forEach(({ geometry }) => geometry.dispose()), [parts]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <group name="backdrop">
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </group>
  );
}
