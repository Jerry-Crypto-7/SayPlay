'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group } from 'three';
import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { GLIDE } from '@/play/arcade/pieces/glide';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { FittedModel } from '../World';

export { placeGlide } from './camera';
export { useGlideInput } from './glide-input';

/** These native course bodies are drawn here; named actors remain in World. */
export const GLIDE_SCENE_KINDS: ReadonlySet<string> = new Set(['glide-ring', 'glide-current', 'glide-reef']);

export function GlideBackdrop({ session, look, collectibleModel }: { readonly session: ArcadeSession; readonly look: Look; readonly collectibleModel?: string }) {
  const groups = useRef(new Map<number, Group>());
  const bodies = useMemo(() => {
    const initial = session.world.initial;
    return Array.from({ length: initial[HEADER.bodyCount]! }, (_, body) => {
      const base = bodyBase(body);
      return { body, kind: session.world.kinds[initial[base + BODY.kind]!]!, w: initial[base + BODY.w]! / UNIT, h: initial[base + BODY.h]! / UNIT, d: initial[base + BODY.d]! / UNIT };
    }).filter(body => GLIDE_SCENE_KINDS.has(body.kind));
  }, [session]);
  useFrame(() => {
    const state = session.state(), previous = session.prev(), alpha = session.alpha();
    for (const body of bodies) {
      const group = groups.current.get(body.body);
      if (group === undefined) continue;
      const base = bodyBase(body.body);
      group.visible = (state[base + BODY.flags]! & FLAG.alive) !== 0;
      const at = (offset: number) => (previous[base + offset]! + (state[base + offset]! - previous[base + offset]!) * alpha) / UNIT;
      group.position.set(-at(BODY.x), at(BODY.y) + body.h / 2, at(BODY.z));
    }
  });
  return <>
    <Scenery look={look} layout="sides" inner={GLIDE.bound / UNIT + 2.5} from={-10} to={session.world.length / UNIT + 20} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, session.world.length / UNIT / 2]} receiveShadow>
      <planeGeometry args={[80, session.world.length / UNIT + 80]} />
      <meshStandardMaterial color={look.ground} roughness={1} />
    </mesh>
    {bodies.map(body => <group key={body.body} ref={group => { if (group === null) groups.current.delete(body.body); else groups.current.set(body.body, group); }}>
      {body.kind === 'glide-ring' ? <group>
        {collectibleModel !== undefined && <group position={[0, -0.3, 0]}>
          <FittedModel id={collectibleModel} w={0.6} h={0.6} d={0.6} fallback={color.sun} />
        </group>}
        <mesh>
        <torusGeometry args={[Math.min(body.w, body.h) / 2, 0.12, 8, 24]} />
        <meshBasicMaterial color={color.sun} />
        </mesh>
      </group> : body.kind === 'glide-current' ? <group>
        {[-0.6, 0, 0.6].map(offset => <mesh key={offset} position={[offset, 0, 0]}>
          <boxGeometry args={[0.04, 0.04, body.d * 0.7]} />
          <meshBasicMaterial color={color.cream} transparent opacity={0.35} depthWrite={false} />
        </mesh>)}
      </group> : <mesh castShadow receiveShadow>
        <boxGeometry args={[body.w, body.h, body.d]} />
        <meshStandardMaterial color={look.terrain?.rock ?? look.tint[1]} roughness={1} />
      </mesh>}
    </group>)}
  </>;
}
