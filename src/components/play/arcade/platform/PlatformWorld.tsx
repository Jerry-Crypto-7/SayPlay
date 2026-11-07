'use client';

import { renderHeld } from '../effects/render-feel';

/**
 * Svět plošinovky (P32-0 T5, vlastní P32F). Obal nad sdíleným `World` s pevným
 * ovládáním `platform`: boční kamera a těla jsou společná, podklad je vlastní
 * (P32F T5) – pevné desky jádra jsou ostrůvky ze skály s okrajem sady
 * (`islands.ts` od A, horní plocha přesně ve výšce desky) nad vlnící se hladinou.
 * Kvádry, které za desky kreslí `World`, se schovají; pohyblivá plošina si svůj
 * vzhled nechává – hráč z něj čte pohyb. Krok, skok a dopad hrdiny podle třídy těla
 * mu dává hračková póza ze sdíleného `World` (P45D T7, T8), dopad hlásí i sběrnice
 * efektů (`land`).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { Box3, type Mesh, MeshStandardMaterial, type Object3D, Raycaster, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { type ArcadeWorld, UNIT } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { PLATFORM } from '@/play/arcade/pieces/platform';

import { GhostSlot } from '../GhostSlot';
import { HorizonBackdrop } from '../look/Backdrop';
import { FieldGround } from '../look/FieldGround';
import { type Box, mix } from '../look/ground';
import { Landmark } from '../look/Landmark';
import { VegetationAround } from '../look/Vegetation';
import { LAYERS, type Layer, type Side } from '../look/vegetation-places';
import { type Block, buildBlocks, streetBlocks, urbanLook } from '../look/rig/terrain/city-blocks';
import { buildIslands, platformIslands, platformSlabKeys, spotKey } from '../look/rig/terrain/islands';
import { buildWater } from '../look/rig/terrain/water';
import { Scenery } from '../look/Scenery';
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

function PlatformSea({ world, look, terrain }: { readonly world: ArcadeWorld; readonly look: Look; readonly terrain: RefObject<Mesh | null> }) {
  const length = world.length / UNIT;
  const urban = urbanLook(look);
  const spots = useMemo(() => platformIslands(world), [world]);
  const islands = useMemo(() => buildIslands({ look, islands: spots, base: WATER, roofOnly: urban }), [look, spots, urban]);
  // Město (P46G doplněk): desky jsou střechy domů, za břehem ulice.
  const houses = useMemo(() => {
    if (!urban) return null;
    const under = spots.map((s): Block => ({ x0: s.x - s.w / 2 + HOUSE_IN, x1: s.x + s.w / 2 - HOUSE_IN, z0: s.z - s.d / 2 + HOUSE_IN, z1: s.z + s.d / 2 - HOUSE_IN, base: WATER - 0.5, top: s.top - 0.3 }));
    const street = streetBlocks({ from: -30, to: length + 30, x0: STREET_X, base: BANK, seed: world.seed });
    return mergeGeometries([buildBlocks(under, world.seed, ['-x', '-z', '+z'], false), buildBlocks(street, world.seed + 1, ['-x', '-z', '+z'], true)]);
  }, [urban, spots, length, world.seed]);
  useEffect(() => () => houses?.dispose(), [houses]);
  // Písek: horní plocha desek je zem sady, břeh v téže barvě s nimi na snímku splýval – břeh je světlejší písek dun.
  const bankLook = useMemo((): Look => (look.cover === 'sand' ? { ...look, ground: look.terrain?.lane ?? mix(look.ground, '#ffffff', 0.35) } : look), [look]);
  const bankArea = useMemo(() => ({ x0: BANK_FROM, x1: BACKDROP_BEYOND + 20, z0: -40, z1: length + 40 }), [length]);
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
      {houses !== null && <mesh geometry={houses} material={material} receiveShadow userData={{ rigShadow: 'receive' }} />}
      {/* Břeh za ostrůvky (+x, boční kamera stojí na −x) v barvách sady a na něm vegetace – jen za nimi, před kamerou nic, takže doskok ani minci nezakryje. */}
      <FieldGround look={bankLook} area={bankArea} y={BANK} podium={false} />
      {look.flora !== undefined && (
        <group position={[0, BANK, 0]}>
          <VegetationAround flora={look.flora} seed={world.seed} box={{ x0: -SLAB_HALF, x1: SLAB_HALF, z0: -10, z1: length + 10 }} clear={BANK_FROM + 1 - SLAB_HALF} layers={BEHIND_ONLY} behind={30} />
        </group>
      )}
      <Scenery look={look} layout="behind" inner={11} from={-20} to={length + 20} y={BANK} size={1.6} vegetation={look.flora !== undefined} />
      {/* Kulisa za mlhou (P46G T7) z břehu, za řadou kulis a vegetací. */}
      <HorizonBackdrop look={look} seed={world.seed} length={length} clear={0} ground={AT_BANK} beyond={BACKDROP_BEYOND} />
      <Landmark look={look} seed={world.seed} area={SLAB_AREA} ground={ON_BANK} follow="track" />
    </>
  );
}

/** Břeh za ostrůvky (m): kousek nad hladinou, začíná 3 m za hranou desek. */
const BANK = WATER + 0.25;
const SLAB_HALF = PLATFORM.slabW / UNIT / 2;
const BANK_FROM = SLAB_HALF + 3;
/** Pás desek po celé trati: orientační bod stojí za ním na břehu a jede s boční kamerou (P54B T8). */
const SLAB_AREA: readonly Box[] = [{ x0: -SLAB_HALF, x1: SLAB_HALF, z0: -Infinity, z1: Infinity }];
const ON_BANK = (): number => BANK;
/** Vegetace plošinovky jen za tratí: před kamerou (−x) a na koncích nic. */
const BEHIND_ONLY: Readonly<Record<Side, readonly Layer[]>> = { '-x': [], '+x': LAYERS, '-z': [], '+z': [] };
/** Dům pod deskou o kousek uvnitř její hrany (m) – zezadu ho kryje pás pod lemem střechy. */
const HOUSE_IN = 0.05;
/** Přední stěna ulice (m): za řadou pouličních kulis (`Scenery` 11–17 m). */
const STREET_X = 18;
/** Kulisa stojí na břehu. */
const AT_BANK = (): number => BANK;
/** Nejbližší vrstva kulisy (m): boční kamera 10–18 m před ostrůvky, kulisy 11–17 m za nimi. */
const BACKDROP_BEYOND = 36;

/**
 * Běží po snímku `World` (sourozenec za ním, jako `HeroPose` běžce): `World` každý
 * snímek zapíše skupinám polohu a viditelnost, tady se kvádry desek znovu schovají.
 * Hrdinu pózuje jen `World` (hračková póza vnitřní skupiny, P45D T7): druhé zmáčknutí
 * odrazu na obalu by se s jeho skokem sečetlo.
 */
function PlatformPose({ session, terrain }: { readonly session: ArcadeSession; readonly terrain: RefObject<Mesh | null> }) {
  const scene = useThree((three) => three.scene);
  const get = useThree((three) => three.get);
  const slabs = useMemo(() => platformSlabKeys(session.world), [session]);
  const found = useRef<{ boxes: Object3D[]; hero: Object3D | null; frame: number }>({ boxes: [], hero: null, frame: 0 });

  useFrame(() => {
    if (renderHeld(session)) return;
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
      <GhostSlot ghost={props.ghost} session={props.session} />
    </>
  );
}
