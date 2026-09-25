'use client';

/**
 * Kde na obrazovce stojí cíle mřížkové hry (P28C T4). Žije uvnitř plátna, aby
 * měl kameru a scénu, a do `project` zapíše funkci entita → střed jejího
 * objektu v pixelech okna. Klepnutí na plátno z ní vybere nejbližší cíl
 * a sonda e2e z ní čte souřadnice – jedna projekce pro obojí.
 *
 * Nic nekreslí a jen čte: do světa ani do stavu běhu nesahá.
 */

import { useThree } from '@react-three/fiber';
import { type MutableRefObject, useEffect } from 'react';
import { Box3, Vector3 } from 'three';

import { slotGroupName } from '@/components/viewer/representation';

export type ProjectTarget = (entityId: string) => { readonly x: number; readonly y: number } | null;

export function TapTargets({ slots, project }: { readonly slots: ReadonlyMap<string, string>; readonly project: MutableRefObject<ProjectTarget | null> }) {
  const camera = useThree((three) => three.camera);
  const scene = useThree((three) => three.scene);
  const canvas = useThree((three) => three.gl.domElement);
  useEffect(() => {
    const box = new Box3();
    const center = new Vector3();
    project.current = (entityId) => {
      const node = scene.getObjectByName(slotGroupName(slots.get(entityId) ?? entityId));
      if (node === undefined) return null;
      // Sebraný objekt runtime schová (`visible = false` na obalu slotu) – na ten se neklepe.
      for (let at: typeof node | null = node; at !== null; at = at.parent) if (!at.visible) return null;
      node.updateWorldMatrix(true, true);
      box.setFromObject(node);
      if (box.isEmpty()) return null;
      box.getCenter(center).project(camera);
      if (center.z > 1) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + ((center.x + 1) / 2) * rect.width, y: rect.top + ((1 - center.y) / 2) * rect.height };
    };
    return () => {
      project.current = null;
    };
  }, [camera, scene, canvas, slots, project]);
  return null;
}
