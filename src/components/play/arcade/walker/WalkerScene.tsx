'use client';

import { renderHeld } from '../effects/render-feel';

import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, type InstancedMesh } from 'three';
import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { walkerMapSchema, WALKER_CELL } from '@/play/arcade/pieces/walker';
import { baseControlOf } from '@/play/arcade/addons';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { walkerCone } from './view';

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

export function WalkerBackdrop({ session, look }: { readonly session: ArcadeSession; readonly look: Look }) {
  const mesh = useRef<InstancedMesh>(null);
  const data = useMemo(() => {
    const state = session.world.initial, control = baseControlOf(session.world.control);
    const walls = Array.from({ length: state[HEADER.bodyCount]! }, (_, body) => body).filter(body => session.world.kinds[state[bodyBase(body) + BODY.kind]!] === 'wall');
    const cones = session.world.rules.filter(rule => rule.id === 'walker_caught').map(rule => ({ body: Number(rule.params.body), range: Number(rule.params.range ?? 5000) }));
    return { walls, cones, size: Number(control.params.size) };
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
  return <>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-centre, -0.02, centre]} receiveShadow>
      <planeGeometry args={[extent + 12, extent + 12]} />
      <meshStandardMaterial color={look.ground} roughness={1} />
    </mesh>
    <group position={[-centre, 0, 0]}>
      <Scenery look={look} layout="sides" inner={extent / 2 + 3} from={-4} to={extent + 4} />
    </group>
    <instancedMesh ref={mesh} args={[undefined, undefined, data.walls.length]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={look.block?.[0] ?? look.tint[1]} roughness={1} />
    </instancedMesh>
    {data.cones.map(cone => <GuardCone key={cone.body} session={session} {...cone} />)}
  </>;
}
