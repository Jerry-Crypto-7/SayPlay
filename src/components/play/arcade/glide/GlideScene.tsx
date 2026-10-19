'use client';

import { renderHeld } from '../effects/render-feel';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group } from 'three';
import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { GLIDE } from '@/play/arcade/pieces/glide';
import { HorizonBackdrop } from '../look/Backdrop';
import { FieldGround } from '../look/FieldGround';
import { type Box, boxEdge } from '../look/ground';
import { Landmark } from '../look/Landmark';
import { Scenery } from '../look/Scenery';
import { Vegetation } from '../look/Vegetation';
import type { RoadAt } from '../look/vegetation-places';
import type { ArcadeSession } from '../session';
import { FittedModel } from '../World';

export { placeGlide } from './camera';
export { useGlideInput } from './glide-input';

/** Hranice letu do strany (m): za ní jádro hru ukončí. */
const BOUND = GLIDE.bound / UNIT;
/** Koridor letu jako „cesta“ vegetace: rovný v ose, půl šířky po hranici. */
const COURSE = (): RoadAt => ({ center: 0, half: BOUND });
const COURSE_BOX: Box = { x0: -BOUND, x1: BOUND, z0: -Infinity, z1: Infinity };
const COURSE_EDGE = boxEdge(COURSE_BOX);
/** Orientační bod stojí za hranicí letu a jede s kamerou (P54B T8). */
const COURSE_AREA: readonly Box[] = [COURSE_BOX];
const LAND_Y = (): number => -0.06;
/** Volný pás vegetace za hranicí letu (m). */
const VEGETATION_CLEAR = 1.5;
/** Kam zem sahá do strany za hranici (m). */
const LAND_M = 50;

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
    if (renderHeld(session)) return;
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
  const length = session.world.length / UNIT;
  const seed = session.world.seed;
  const far = length + look.fog[1] + 10;
  const land = useMemo(() => ({ x0: -BOUND - LAND_M, x1: BOUND + LAND_M, z0: -40, z1: far }), [far]);
  return <>
    {/* Vegetace sady za hranicí letu: koruny nikdy nevrostou do koridoru, kudy hrdina smí letět. */}
    {look.flora !== undefined && <Vegetation flora={look.flora} seed={seed} from={-10} to={far} road={COURSE} clear={VEGETATION_CLEAR} />}
    <Scenery look={look} layout="sides" inner={BOUND + 2.5} from={-10} to={length + 20} vegetation />
    {/* Zem s odstíny, skvrnami, krajnicí u hranice letu a tmavnutím do strany (P46G T7); dřív jedna barva sady. */}
    <FieldGround look={look} area={land} edge={COURSE_EDGE} y={-0.06} />
    <HorizonBackdrop look={look} seed={seed} length={length} clear={BOUND + VEGETATION_CLEAR} />
    <Landmark look={look} seed={seed} area={COURSE_AREA} ground={LAND_Y} follow="track" />
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
