'use client';

import { renderHeld } from '../effects/render-feel';

import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, type InstancedMesh } from 'three';
import { color } from '@/brand/tokens';
import { type ArcadeWorld, BODY, FLAG, HEADER, UNIT, bodyBase, nativeRules } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { walkerMapSchema, WALKER_CELL } from '@/play/arcade/pieces/walker';
import { baseControlOf } from '@/play/arcade/addons';
import { FieldGround } from '../look/FieldGround';
import { boxEdge } from '../look/ground';
import { Landmark } from '../look/Landmark';
import { Scenery } from '../look/Scenery';
import { VegetationAround } from '../look/Vegetation';
import { NONE_TOWARD_CAMERA } from '../look/vegetation-places';
import type { ArcadeSession } from '../session';
import { walkerCone } from './view';

/** Kam zem sahá za bludiště (m): za vegetaci do mlhy. */
const LAND_M = 50;
/** Volný pás vegetace za krajem bludiště (m): tam, kde dřív stála řada kulis. */
const VEGETATION_CLEAR = 3;

export { placeWalker } from './view';
export { useWalkerInput } from './walker-input';
export const WALKER_SCENE_KINDS: ReadonlySet<string> = new Set(['wall']);

function GuardCone({ session, body, range }: { readonly session: ArcadeSession; readonly body: number; readonly range: number }) {
  const control = baseControlOf(session.world.control);
  const map = useMemo(() => walkerMapSchema.parse({ size: control.params.size, open: control.params.open }), [control]);
  const geometry = useMemo(() => new BufferGeometry(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(() => {
    if (renderHeld(session)) return;
    const state = session.state();
    const vertices = (state[bodyBase(body) + BODY.flags]! & FLAG.alive) === 0 ? new Float32Array() : walkerCone(state, body, map, range);
    const current = geometry.getAttribute('position');
    if (current !== undefined && current.array.length === vertices.length) { (current.array as Float32Array).set(vertices); current.needsUpdate = true; }
    else geometry.setAttribute('position', new BufferAttribute(vertices, 3));
    geometry.computeBoundingSphere();
  });
  return <mesh geometry={geometry} renderOrder={2} frustumCulled={false}>
    <meshBasicMaterial color={color.alarm} transparent opacity={0.2} depthWrite={false} side={DoubleSide} />
  </mesh>;
}

/** Kužely strážných z pravidel `walker_caught` (i pod obalem složené hry): tělo strážného a dosah. */
export const walkerCones = (world: Pick<ArcadeWorld, 'rules'>): { body: number; range: number }[] =>
  nativeRules(world.rules, 'walker_caught').map(rule => ({ body: Number(rule.params.body), range: Number(rule.params.range ?? 5000) }));

export function WalkerBackdrop({ session, look }: { readonly session: ArcadeSession; readonly look: Look }) {
  const mesh = useRef<InstancedMesh>(null);
  const data = useMemo(() => {
    const state = session.world.initial, control = baseControlOf(session.world.control);
    const walls = Array.from({ length: state[HEADER.bodyCount]! }, (_, body) => body).filter(body => session.world.kinds[state[bodyBase(body) + BODY.kind]!] === 'wall');
    return { walls, cones: walkerCones(session.world), size: Number(control.params.size) };
  }, [session]);
  useLayoutEffect(() => {
    if (mesh.current === null) return;
    const matrix = new Matrix4(), state = session.world.initial;
    data.walls.forEach((body, index) => {
      const base = bodyBase(body);
      matrix.makeScale(state[base + BODY.w]! / UNIT, state[base + BODY.h]! / UNIT, state[base + BODY.d]! / UNIT);
      matrix.setPosition(-state[base + BODY.x]! / UNIT, (state[base + BODY.y]! + state[base + BODY.h]! / 2) / UNIT, state[base + BODY.z]! / UNIT);
      mesh.current!.setMatrixAt(index, matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [data, session]);
  const extent = data.size * WALKER_CELL / UNIT, centre = (data.size - 1) * WALKER_CELL / UNIT / 2;
  // Bludiště ve scéně (x zrcadlené): buňky od 0 do (size − 1) · 4 m, každá ±2 m kolem středu.
  const { box, land, edge, area } = useMemo(() => {
    const maze = { x0: -centre - extent / 2, x1: -centre + extent / 2, z0: centre - extent / 2, z1: centre + extent / 2 };
    return { box: maze, land: { x0: maze.x0 - LAND_M, x1: maze.x1 + LAND_M, z0: maze.z0 - LAND_M, z1: maze.z1 + LAND_M }, edge: boxEdge(maze), area: [maze] };
  }, [centre, extent]);
  return <>
    {/* Zem s odstíny a skvrnami, kolem bludiště krajnice a do dálky tmavne (P46G T7); dřív jedna barva sady. */}
    <FieldGround look={look} area={land} edge={edge} y={-0.02} />
    {/* Vegetace sady kolem bludiště, z −z hrdina vchází a stojí kamera – tam nic. Kulisa za mlhou chybí schválně: kamera kouká 63–70° dolů a obzor nevidí. */}
    {look.flora !== undefined && <VegetationAround flora={look.flora} seed={session.world.seed} box={box} clear={VEGETATION_CLEAR} layers={NONE_TOWARD_CAMERA} />}
    <group position={[-centre, 0, 0]}>
      <Scenery look={look} layout="sides" inner={extent / 2 + 3} from={-4} to={extent + 4} vegetation />
    </group>
    {/* Orientační bod mimo bludiště jede s kamerou za hrdinou (P54B T8): strmá kamera vidí zem jen kousek za bludištěm. */}
    <Landmark look={look} seed={session.world.seed} area={area} follow="camera" />
    <instancedMesh ref={mesh} args={[undefined, undefined, data.walls.length]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={look.block?.[0] ?? look.tint[1]} roughness={1} />
    </instancedMesh>
    {data.cones.map(cone => <GuardCone key={cone.body} session={session} {...cone} />)}
  </>;
}
