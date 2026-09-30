'use client';

/**
 * Kde na obrazovce stojí cíle mřížkové hry (P28C T4). Žije uvnitř plátna, aby
 * měl kameru a scénu, a do `project` zapíše funkci entita → střed jejího
 * objektu v pixelech okna. Klepnutí na plátno z ní vybere nejbližší cíl
 * a sonda e2e z ní čte souřadnice – jedna projekce pro obojí.
 *
 * Štítky ve světě (P34 T5, kit `.sp-world-tag`): táž projekce každý snímek
 * posadí štítky z `tags` nad jejich objekt – nejvýš 16 px od okraje scény;
 * sebraný nebo skrytý objekt štítek schová. Štítky kreslí shell (DOM, ne
 * WebGL), tady se jen posouvají.
 *
 * Nic nekreslí a jen čte: do světa ani do stavu běhu nesahá.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type MutableRefObject, type RefObject, useEffect } from 'react';
import { Box3, Vector3 } from 'three';

import { slotGroupName } from '@/components/viewer/representation';

export type ProjectTarget = (entityId: string) => { readonly x: number; readonly y: number } | null;

/** Štítek od okraje scény nejblíž tolik (kit: clamp 16px inside safe area). */
const TAG_EDGE_PX = 16;
/** Štítek visí nad středem objektu o tolik, ať objekt nezakryje. */
const TAG_LIFT_PX = 28;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high));

export function TapTargets({
  slots,
  project,
  tags,
}: {
  readonly slots: ReadonlyMap<string, string>;
  readonly project: MutableRefObject<ProjectTarget | null>;
  /** Vrstva štítků ve světě; děti nesou `data-tag-for` = entita, nad kterou visí. */
  readonly tags?: RefObject<HTMLDivElement | null>;
}) {
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

  useFrame(() => {
    const layer = tags?.current;
    const at = project.current;
    if (layer === null || layer === undefined || at === null) return;
    const frame = layer.getBoundingClientRect();
    // Nejdřív všechno přečíst, pak zapsat – čtení rozměrů po zápisu by každý snímek vynutilo přepočet.
    const placed = Array.from(layer.children as HTMLCollectionOf<HTMLElement>).map((tag) => ({ tag, point: at(tag.dataset.tagFor ?? ''), width: tag.offsetWidth, height: tag.offsetHeight }));
    for (const { tag, point, width, height } of placed) {
      if (point === null) {
        tag.style.visibility = 'hidden';
        continue;
      }
      tag.style.left = `${clamp(point.x - frame.left, TAG_EDGE_PX + width / 2, frame.width - TAG_EDGE_PX - width / 2)}px`;
      tag.style.top = `${clamp(point.y - frame.top - TAG_LIFT_PX, TAG_EDGE_PX + height, frame.height - TAG_EDGE_PX)}px`;
      tag.style.visibility = 'visible';
    }
  });
  return null;
}
