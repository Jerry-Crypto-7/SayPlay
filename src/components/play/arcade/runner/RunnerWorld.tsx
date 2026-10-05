'use client';

/**
 * Svět běžce (P32-0 T5, vlastní P32A). Obal nad sdíleným `World` s pevným
 * ovládáním `runner`: kamera za hráčem a těla jsou společná, podklad je vlastní –
 * údolí s ledovou (písečnou, silniční…) dráhou a kulisy na jeho svazích (T3).
 * Hrdina se navíc hýbe jako postava – náklon do úhybu, odraz, póza jízdy – a stojí
 * na kontaktním stínu (T5, `heroMotion.ts`).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { Box3, DataTexture, type Group, LinearFilter, type Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, Raycaster, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { UNIT } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';

import { GhostSlot } from '../GhostSlot';
import { buildValley, PLAYABLE_HALF } from '../look/rig/terrain/valley';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { World, type WorldProps } from '../World';
import { type Ride, blinksOnHit, createHeroMotion, rideOf } from './heroMotion';

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

/** Póza hrdiny, jak ji scéna opravdu kreslí (T5): e2e z ní čte náklon do úhybu. */
export interface HeroReport {
  /** Náklon do úhybu (°): + = na obrazovce doprava. */
  readonly roll: number;
  /** Předklon obalu hrdiny (°) – póza jízdy; předklon běhu z `poseOf` je na vnitřní skupině. */
  readonly pitch: number;
  readonly ride: Ride;
  /** Krytí kontaktního stínu (0 = žádný). */
  readonly shadow: number;
}

declare global {
  interface Window {
    __playHero?: () => HeroReport | null;
  }
}

const DEG = 180 / Math.PI;

/** Kontaktní stín: krytí na zemi, jak rychle slábne s výškou skoku (1/m), a nejširší kotouč (m). */
const SHADOW_OPACITY = 0.5;
const SHADOW_FADE = 1.2;
const SHADOW_MAX_M = 1.4;
/** Nad dráhou (výška 0, `playableGround`), ať se stín s terénem nepere o hloubku. */
const SHADOW_Y = 0.02;

/** Měkký kotouč stínu: bílá textura s průhledností od středu k okraji, barvu dá materiál. */
function blobTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      data[(y * size + x) * 4 + 3] = Math.round(255 * Math.max(0, 1 - r * r) ** 1.5);
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function heroIn(scene: Object3D): Object3D | null {
  let hero: Object3D | null = null;
  scene.traverse((node) => {
    if (node.userData.frame === 'hero') hero = node;
  });
  return hero;
}

/**
 * Pohyb hrdiny nad `World` (T5). Jeho snímek běží po snímku `World` (stejná priorita,
 * přihlášený později – `World` je dřív mezi sourozenci), takže poloha, přikrčení skluzu
 * a viditelnost, které `World` každý snímek zapíše znovu, tu už jsou; pohyb je jen
 * doplní. Relaci jen čte (`createHeroMotion`).
 */
function HeroPose({ session, hero, rides }: { readonly session: ArcadeSession; readonly hero: string; readonly rides: boolean }) {
  const scene = useThree((three) => three.scene);
  const ride = useMemo(() => rideOf(hero, rides), [hero, rides]);
  const blinks = useMemo(() => blinksOnHit(hero), [hero]);
  const motion = useMemo(() => createHeroMotion(session, ride), [session, ride]);
  const found = useRef<Object3D | null>(null);
  const shadow = useRef<Mesh>(null);
  const box = useMemo(() => new Box3(), []);
  const material = useMemo(() => new MeshBasicMaterial({ color: color.ink, map: blobTexture(), transparent: true, depthWrite: false, opacity: 0 }), []);
  useEffect(
    () => () => {
      material.map?.dispose();
      material.dispose();
    },
    [material],
  );

  useFrame(() => {
    if (found.current === null || found.current.parent === null) found.current = heroIn(scene);
    const group = found.current;
    const blob = shadow.current;
    if (group === null || blob === null) return;
    const pose = motion.sample();
    blob.visible = group.visible;
    // Úhyb kolem směru běhu (osa z), až po předklonu jízdy: pořadí ZYX.
    group.rotation.set(pose.pitch, 0, pose.roll, 'ZYX');
    const wide = 1 + pose.squash / 2;
    group.scale.set(wide, group.scale.y * (1 - pose.squash), wide);
    if (blinks && pose.flash > 0 && Math.floor(pose.flash * 6) % 2 === 1) group.visible = false;
    // Jízda neběží: poskok kroků, který `World` (`applyPose`) píše vnitřní skupině statického modelu, pryč.
    // Riggovaná postava má vnitřní skupinou scénu GLB na nule, primitiv rovnou sítě.
    const inner = group.children[0] as Group | undefined;
    if (ride !== null && inner?.isGroup === true) inner.position.y = 0;

    // Náklon a předklon otáčí tělo kolem paty: nejnižší roh by se zabořil. Tělo se
    // zvedne o tolik, aby stálo na hraně, na kterou se naklání.
    const feet = group.position.y;
    group.updateMatrixWorld(true);
    box.setFromObject(group);
    const dip = feet - box.min.y;
    if (dip > 0) group.position.y += dip;

    // Stín zůstává na dráze pod půdorysem těla; se skokem se zmenší a vybledne.
    const fade = 1 / (1 + Math.max(0, feet) * SHADOW_FADE);
    const spread = 0.6 + 0.4 * fade;
    blob.position.set((box.min.x + box.max.x) / 2, SHADOW_Y, (box.min.z + box.max.z) / 2);
    blob.scale.set(Math.min(box.max.x - box.min.x, SHADOW_MAX_M) * spread, Math.min(box.max.z - box.min.z, SHADOW_MAX_M) * spread, 1);
    material.opacity = SHADOW_OPACITY * fade;
  });

  useEffect(() => {
    const probe = (): HeroReport | null => {
      const group = found.current;
      if (group === null) return null;
      return { roll: group.rotation.z * DEG, pitch: group.rotation.x * DEG, ride, shadow: shadow.current?.visible === true ? material.opacity : 0 };
    };
    window.__playHero = probe;
    return () => {
      if (window.__playHero === probe) delete window.__playHero;
    };
  }, [ride, material]);

  return (
    // Stín si stín nevrhá ani nepřijímá (`ShadowFlags` rigu ho přeskočí).
    <mesh ref={shadow} rotation-x={-Math.PI / 2} material={material} userData={{ rigShadow: 'none' }}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

export function RunnerWorld(props: Omit<WorldProps, 'control' | 'backdrop'>) {
  const terrain = useRef<Mesh>(null);
  const length = props.session.world.length / UNIT;
  return (
    <>
      <World {...props} control="runner" backdrop={<RunnerValley look={props.scene} length={length} terrain={terrain} />} />
      <GroundProbe terrain={terrain} />
      {/* Až po `World`: jeho snímek musí běžet dřív (viz `HeroPose`). */}
      <HeroPose session={props.session} hero={props.cast.player} rides={props.scene.ride === true} />
      <GhostSlot ghost={props.ghost} session={props.session} />
    </>
  );
}
