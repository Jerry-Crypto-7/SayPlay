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

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { DoubleSide, Mesh, MeshBasicMaterial, Vector3 } from 'three';

import type { Look } from '@/play/arcade/look';

import { buildBackdrop, layerAt } from './backdrop-shapes';

export interface HorizonBackdropProps {
  readonly look: Look;
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Délka trati (m): na jejím konci je vrstva o `approach` blíž. Scéna bez trati (hřiště, ring) ji nemá – vrstvy se nepřibližují. */
  readonly length?: number;
  /** Půl šířky průseku nad cestou v nejbližší vrstvě (m); 0 = bez průseku. */
  readonly clear: number;
  /** Jak hluboko pata sahá pod zem (m); závod má rovinu, běžec kopce trati. */
  readonly skirt?: number;
  /** Výška trati v `z` (kopce běžce, hladina pod plošinami); bez ní rovina y = 0. */
  readonly ground?: (z: number) => number;
  /** Nejmenší poloměr nejbližší vrstvy (m): kulisa nikdy nestojí na hrací ploše (`backdropLayers`). */
  readonly beyond?: number;
}

const eye = new Vector3();

export function HorizonBackdrop({ look, seed, length = Infinity, clear, skirt = 0.05, ground, beyond = 0 }: HorizonBackdropProps) {
  const parts = useMemo(() => buildBackdrop(look, { seed, clear, skirt, beyond }), [look, seed, clear, skirt, beyond]);
  const material = useMemo(() => new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }), []);
  // Nejvzdálenější vrstvu nahrazuje malovaná obloha (P75 T3): vlastní materiál, ať se rozplyne sama.
  const far = useMemo(() => new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }), []);
  const meshes = useMemo(
    () =>
      parts.map(({ layer, geometry }, index) => {
        const mesh = new Mesh(geometry, index === 0 && parts.length > 1 ? far : material);
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
    [parts, material, far, length, ground],
  );
  // Průhledná jen během prolnutí: napořád průhledná vrstva by se řadila s vodou a částicemi.
  useFrame(({ scene }) => {
    const painted = (scene.userData.paintedSky as number | undefined) ?? 0;
    const fading = painted > 0 && painted < 1;
    if (far.transparent !== fading) {
      far.transparent = fading;
      far.needsUpdate = true;
    }
    far.opacity = 1 - painted;
    far.visible = painted < 1;
  });
  useEffect(() => () => parts.forEach(({ geometry }) => geometry.dispose()), [parts]);
  useEffect(
    () => () => {
      material.dispose();
      far.dispose();
    },
    [material, far],
  );
  return (
    <group name="backdrop">
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </group>
  );
}
