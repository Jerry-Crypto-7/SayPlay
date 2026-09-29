'use client';

/**
 * Svět běžce (P32-0 T5, vlastní P32A). Obal nad sdíleným `World` s pevným
 * ovládáním `runner`: kamera za hráčem a těla jsou společná, podklad je vlastní –
 * údolí s ledovou (písečnou, silniční…) dráhou a kulisy na jeho svazích (T3).
 */

import { useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { Box3, type Mesh, MeshStandardMaterial, type Object3D, Raycaster, Vector3 } from 'three';

import { UNIT } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';

import { buildValley, PLAYABLE_HALF } from '../look/rig/terrain/valley';
import { Scenery } from '../look/Scenery';
import { World, type WorldProps } from '../World';

/** Údolí začíná za kamerou úvodního záběru a končí za koncem mlhy po cíli. */
const BEHIND_M = 40;

function RunnerValley({ look, length, terrain }: { readonly look: Look; readonly length: number; readonly terrain: RefObject<Mesh | null> }) {
  const valley = useMemo(() => buildValley({ look, from: -BEHIND_M, to: length + look.fog[1] + 10 }), [look, length]);
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), []);
  useEffect(() => () => valley.geometry.dispose(), [valley]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <>
      {/* Stín jen přijímá: vlastní stín by se na rovné dráze odrážel jako akné. */}
      <mesh ref={terrain} geometry={valley.geometry} material={material} receiveShadow userData={{ rigShadow: 'receive', terrain: 'valley' }} />
      <Scenery look={look} layout="sides" inner={PLAYABLE_HALF + 1.5} from={-10} to={length + 10} ground={valley.heightAt} cap={look.terrain?.cap} />
    </>
  );
}

export interface GroundGap {
  /** Svislá mezera (px) mezi spodní hranou těla a terénem pod ní: + visí, − boří se. */
  readonly gap: number;
  /** Tatáž mezera v metrech světa – laťka skluzu visí nad dráhou schválně (1 m). */
  readonly lift: number;
}

export interface GroundReport {
  readonly hero: GroundGap | null;
  /** Každá viditelná překážka v záběru. */
  readonly obstacles: readonly GroundGap[];
}

declare global {
  interface Window {
    __playGround?: () => GroundReport;
  }
}

const shown = (object: Object3D): boolean => {
  for (let node: Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
};

/**
 * Sonda země (T3): paprskem shora najde nakreslený terén pod patou těla a obojí
 * promítne kamerou scény. E2e tak vidí, jestli hráč a překážky stojí na terénu.
 */
function GroundProbe({ terrain }: { readonly terrain: RefObject<Mesh | null> }) {
  const get = useThree((three) => three.get);
  useEffect(() => {
    const ray = new Raycaster();
    const down = new Vector3(0, -1, 0);
    const box = new Box3();
    const foot = new Vector3();
    const probe = (): GroundReport => {
      const { camera, scene, size } = get();
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      const ground = terrain.current;
      const gapOf = (node: Object3D): GroundGap | null => {
        if (ground === null || !shown(node)) return null;
        box.setFromObject(node);
        if (box.isEmpty()) return null;
        box.getCenter(foot);
        foot.y = box.min.y;
        const onScreen = foot.clone().project(camera);
        if (Math.abs(onScreen.x) > 1 || Math.abs(onScreen.y) > 1 || onScreen.z > 1) return null;
        ray.set(new Vector3(foot.x, foot.y + 100, foot.z), down);
        const hit = ray.intersectObject(ground, false)[0];
        if (hit === undefined) return null;
        return { gap: ((onScreen.y - hit.point.clone().project(camera).y) / 2) * size.height, lift: foot.y - hit.point.y };
      };
      let hero: GroundGap | null = null;
      const obstacles: GroundGap[] = [];
      scene.traverse((node) => {
        if (node.userData.frame === 'hero') hero = gapOf(node);
        else if (node.userData.item === 'obstacle') {
          const gap = gapOf(node);
          if (gap !== null) obstacles.push(gap);
        }
      });
      return { hero, obstacles };
    };
    window.__playGround = probe;
    return () => {
      if (window.__playGround === probe) delete window.__playGround;
    };
  }, [get, terrain]);
  return null;
}

export function RunnerWorld(props: Omit<WorldProps, 'control' | 'backdrop'>) {
  const terrain = useRef<Mesh>(null);
  const length = props.session.world.length / UNIT;
  return (
    <>
      <World {...props} control="runner" backdrop={<RunnerValley look={props.scene} length={length} terrain={terrain} />} />
      <GroundProbe terrain={terrain} />
    </>
  );
}
