'use client';

/**
 * Galerie knihovny terénu (P32A T9). Jeden generátor pod rigem vzhledu
 * (`StyleRig`) s pevnou kamerou, jak ho uvidí scéna stopy, která ho převezme:
 * ostrůvky z boku nad vodou jako plošinovka, aréna šikmo shora, voda za lodí.
 * Po `READY_FRAMES` snímcích nastaví `data-ready` a e2e fotí.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { MeshStandardMaterial } from 'three';

import { Scenery } from '@/components/play/arcade/look/Scenery';
import { StyleRig } from '@/components/play/arcade/look/rig/StyleRig';
import { buildArenaFloor } from '@/components/play/arcade/look/rig/terrain/arenaFloor';
import { type IslandSpot, buildIslands } from '@/components/play/arcade/look/rig/terrain/islands';
import { buildWater } from '@/components/play/arcade/look/rig/terrain/water';
import { UNIT } from '@/play/arcade/contract';
import { LOOKS, type Look, type LookId } from '@/play/arcade/look';
import { ARENA } from '@/play/arcade/pieces/arena';
import { PLATFORM } from '@/play/arcade/pieces/platform';

export type TerrainKit = 'islands' | 'arena' | 'water';

type Vec = readonly [number, number, number];

/** Kamera a bod, na který kouká; bod drží i výřez stínu slunce (značka hrdiny rigu). */
const VIEWS: Readonly<Record<TerrainKit, { readonly control: string; readonly camera: Vec; readonly target: Vec }>> = {
  islands: { control: 'platform', camera: [-15, 9, 4], target: [0, 3.6, 16] },
  arena: { control: 'move_free', camera: [0, 21, -25], target: [0, 0, 5] },
  water: { control: 'steer', camera: [0, 6.5, -8], target: [0, 0.5, 16] },
};

/** Hladina pod plošinami jako v dnešní scéně (`World.tsx`). */
const PLATFORM_WATER = PLATFORM.fallBelowY / UNIT - 0.4;

/** Ostrovy v moři pro vodu: pěna kolem břehů. */
const REEF: readonly IslandSpot[] = [
  { x: 7, z: 16, w: 9, d: 7, top: 1.3, round: true },
  { x: -10, z: 28, w: 13, d: 10, top: 2.2, round: true },
  { x: 4, z: 40, w: 7, d: 6, top: 1, round: true },
];

const READY_FRAMES = 45;

function useVertexMaterial(): MeshStandardMaterial {
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), []);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

function Sea({ look, level, half, from, to, shore }: { readonly look: Look; readonly level: number; readonly half: number; readonly from: number; readonly to: number; readonly shore: (x: number, z: number) => number }) {
  const water = useMemo(() => buildWater({ look, half, from, to, level, shore }), [look, half, from, to, level, shore]);
  useEffect(
    () => () => {
      water.geometry.dispose();
      water.material.dispose();
    },
    [water],
  );
  useFrame(({ clock }) => water.setTime(clock.elapsedTime));
  return <mesh geometry={water.geometry} material={water.material} receiveShadow userData={{ rigShadow: 'receive' }} />;
}

function Islands({ look, spots, base, sea }: { readonly look: Look; readonly spots: readonly IslandSpot[]; readonly base: number; readonly sea: { readonly half: number; readonly from: number; readonly to: number } }) {
  const islands = useMemo(() => buildIslands({ look, islands: spots, base }), [look, spots, base]);
  const material = useVertexMaterial();
  useEffect(() => () => islands.geometry.dispose(), [islands]);
  return (
    <>
      <mesh geometry={islands.geometry} material={material} castShadow receiveShadow userData={{ rigShadow: 'both' }} />
      <Sea look={look} level={base} shore={islands.shoreDistance} {...sea} />
    </>
  );
}

function Arena({ look }: { readonly look: Look }) {
  const arena = useMemo(() => buildArenaFloor({ look, half: ARENA.half / UNIT }), [look]);
  const material = useVertexMaterial();
  useEffect(
    () => () => {
      arena.floor.dispose();
      arena.walls.dispose();
    },
    [arena],
  );
  return (
    <>
      <mesh geometry={arena.floor} material={material} receiveShadow userData={{ rigShadow: 'receive' }} />
      <mesh geometry={arena.walls} material={material} castShadow receiveShadow userData={{ rigShadow: 'both' }} />
      {/* Kulisy za stěnami ze všech čtyř stran, jako `ArenaScene`. */}
      {[0, Math.PI / 2].map((turn) => (
        <group key={turn} rotation={[0, turn, 0]}>
          <Scenery look={look} layout="sides" inner={arena.sceneryInner} from={-arena.sceneryInner} to={arena.sceneryInner} cap={look.terrain?.cap} />
        </group>
      ))}
    </>
  );
}

function Frame({ camera: at, target }: { readonly camera: Vec; readonly target: Vec }) {
  const camera = useThree((three) => three.camera);
  useLayoutEffect(() => {
    camera.position.set(...at);
    camera.lookAt(...target);
    camera.updateMatrixWorld();
  }, [camera, at, target]);
  return <group position={target} userData={{ frame: 'hero' }} />;
}

function Ready({ surface }: { readonly surface: RefObject<HTMLDivElement | null> }) {
  const frames = useRef(0);
  useFrame(() => {
    frames.current += 1;
    if (frames.current === READY_FRAMES && surface.current !== null) surface.current.dataset.ready = '1';
  });
  return null;
}

export function TerrainLab({ kit, lookId, islands }: { readonly kit: TerrainKit; readonly lookId: LookId; readonly islands: readonly IslandSpot[] }) {
  const surface = useRef<HTMLDivElement>(null);
  const look = LOOKS[lookId];
  const view = VIEWS[kit];
  return (
    <div ref={surface} data-testid="terrain-lab" data-kit={kit} data-look={lookId} style={{ position: 'fixed', inset: 0 }}>
      <Canvas camera={{ fov: 50, position: [...view.camera] }} dpr={[1, 2]} shadows="percentage">
        <StyleRig look={look} lookId={lookId} control={view.control} surface={surface} />
        <Frame camera={view.camera} target={view.target} />
        {kit === 'islands' && <Islands look={look} spots={islands} base={PLATFORM_WATER} sea={{ half: 40, from: -30, to: 140 }} />}
        {kit === 'water' && <Islands look={look} spots={REEF} base={0} sea={{ half: 60, from: -20, to: 120 }} />}
        {kit === 'arena' && <Arena look={look} />}
        <Ready surface={surface} />
      </Canvas>
    </div>
  );
}
