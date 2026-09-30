'use client';

/**
 * Svět plošinovky (P32-0 T5, vlastní P32F). Obal nad sdíleným `World` s pevným
 * ovládáním `platform`: boční kamera a těla jsou společná, podklad je vlastní
 * (P32F T5) – pevné desky jádra jsou ostrůvky ze skály s okrajem sady
 * (`islands.ts` od A, horní plocha přesně ve výšce desky) nad vlnící se hladinou.
 * Kvádry, které za desky kreslí `World`, se schovají; pohyblivá plošina si svůj
 * vzhled nechává – hráč z něj čte pohyb. Hrdina se při odrazu zmáčkne jako běžec
 * (`runner/heroMotion.ts`), dopad hlásí sběrnice efektů (`land`).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { Box3, type Mesh, MeshStandardMaterial, type Object3D, Raycaster, Vector3 } from 'three';

import { type ArcadeWorld, UNIT } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { PLATFORM } from '@/play/arcade/pieces/platform';

import { buildIslands, platformIslands } from '../look/rig/terrain/islands';
import { buildWater } from '../look/rig/terrain/water';
import { Scenery } from '../look/Scenery';
import { createHeroMotion } from '../runner/heroMotion';
import type { GroundGap } from '../runner/RunnerWorld';
import type { ArcadeSession } from '../session';
import { World, type WorldProps } from '../World';

/** Hladina pod plošinami jako v dnešní scéně (`World.tsx`): pod ní hráč spadne. */
const WATER = PLATFORM.fallBelowY / UNIT - 0.4;

declare global {
  interface Window {
    /** Pata hrdiny proti horní ploše ostrůvku pod ní (T5): e2e z ní čte, jestli hrdina stojí na nakreslené desce. */
    __playPlatform?: () => GroundGap | null;
  }
}

/** Klíč polohy těla v jednotkách jádra – tak, jak ji `World` zapíše skupině (x zrcadlené). */
const spotKey = (x: number, y: number, z: number): string => `${Math.round(x * UNIT)},${Math.round(y * UNIT)},${Math.round(z * UNIT)}`;

function PlatformSea({ world, look, terrain }: { readonly world: ArcadeWorld; readonly look: Look; readonly terrain: RefObject<Mesh | null> }) {
  const length = world.length / UNIT;
  const islands = useMemo(() => buildIslands({ look, islands: platformIslands(world), base: WATER }), [look, world]);
  const water = useMemo(() => buildWater({ look, half: 40, from: -30, to: length + 30, level: WATER, shore: islands.shoreDistance }), [look, length, islands]);
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), []);
  useEffect(() => () => islands.geometry.dispose(), [islands]);
  useEffect(
    () => () => {
      water.geometry.dispose();
      water.material.dispose();
    },
    [water],
  );
  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => water.setTime(performance.now() / 1000));
  return (
    <>
      <mesh geometry={water.geometry} material={water.material} receiveShadow userData={{ rigShadow: 'receive', terrain: 'water' }} />
      <mesh ref={terrain} geometry={islands.geometry} material={material} castShadow receiveShadow userData={{ rigShadow: 'both', terrain: 'islands' }} />
      <Scenery look={look} layout="behind" inner={11} from={-20} to={length + 20} y={WATER} size={1.6} />
    </>
  );
}

/**
 * Běží po snímku `World` (sourozenec za ním, jako `HeroPose` běžce): `World` každý
 * snímek zapíše skupinám polohu a viditelnost, tady se kvádry desek znovu schovají
 * a hrdina dostane zmáčknutí odrazu.
 */
function PlatformPose({ session, terrain }: { readonly session: ArcadeSession; readonly terrain: RefObject<Mesh | null> }) {
  const scene = useThree((three) => three.scene);
  const get = useThree((three) => three.get);
  const motion = useMemo(() => createHeroMotion(session, null), [session]);
  const slabs = useMemo(() => new Set(platformIslands(session.world).map((spot) => spotKey(spot.x, spot.top - PLATFORM.slabH / UNIT, spot.z))), [session]);
  const found = useRef<{ boxes: Object3D[]; hero: Object3D | null; frame: number }>({ boxes: [], hero: null, frame: 0 });

  useFrame(() => {
    const cached = found.current;
    cached.frame += 1;
    // Skupiny těl `World` staví jednou za svět; znovu hledat po jejich výměně. Desce za koncem
    // mlhy `World` polohu ještě nezapsal (a kreslí ji skrytou) – dohledá se, až přijde do záběru.
    const missing = cached.boxes.length !== slabs.size && cached.frame % 10 === 0;
    if (cached.hero?.parent == null || missing || cached.boxes.some((box) => box.parent === null)) {
      cached.boxes = [];
      cached.hero = null;
      scene.traverse((node) => {
        if (!Object.hasOwn(node.userData, 'frame')) return;
        if (node.userData.frame === 'hero') cached.hero = node;
        else if (slabs.has(spotKey(node.position.x, node.position.y, node.position.z))) cached.boxes.push(node);
      });
    }
    for (const box of found.current.boxes) box.visible = false;
    const hero = found.current.hero;
    if (hero === null) return;
    // Zmáčknutí kolem paty (objem drží); natažení ve vzduchu a dosednutí dává `World` vnitřní skupině.
    const { squash } = motion.sample();
    const wide = 1 + squash / 2;
    hero.scale.set(wide, hero.scale.y * (1 - squash), wide);
  });

  // Sonda: nejnižší bod nakresleného hrdiny proti ploše ostrůvku pod ním, obojí promítnuté kamerou (px).
  useEffect(() => {
    const ray = new Raycaster();
    const down = new Vector3(0, -1, 0);
    const box = new Box3();
    const probe = (): GroundGap | null => {
      const { camera, size } = get();
      const hero = found.current.hero;
      const ground = terrain.current;
      if (hero === null || ground === null) return null;
      hero.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      box.setFromObject(hero);
      if (box.isEmpty()) return null;
      const foot = box.getCenter(new Vector3()).setY(box.min.y);
      ray.set(new Vector3(foot.x, foot.y + 100, foot.z), down);
      const hit = ray.intersectObject(ground, false)[0];
      if (hit === undefined) return null;
      return { gap: ((foot.clone().project(camera).y - hit.point.clone().project(camera).y) / 2) * size.height, lift: foot.y - hit.point.y };
    };
    window.__playPlatform = probe;
    return () => {
      if (window.__playPlatform === probe) delete window.__playPlatform;
    };
  }, [get, terrain]);

  return null;
}

export function PlatformWorld(props: Omit<WorldProps, 'control' | 'backdrop'>) {
  const terrain = useRef<Mesh>(null);
  return (
    <>
      <World {...props} control="platform" backdrop={<PlatformSea world={props.session.world} look={props.scene} terrain={terrain} />} />
      {/* Až po `World`: jeho snímek musí běžet dřív (viz `PlatformPose`). */}
      <PlatformPose session={props.session} terrain={terrain} />
    </>
  );
}
