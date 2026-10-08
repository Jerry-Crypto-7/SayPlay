'use client';

import { renderHeld } from '../effects/render-feel';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group, Mesh } from 'three';
import { color } from '@/brand/tokens';
import { underlyingRule } from '@/play/arcade/addons';
import { BODY, BODY_STRIDE, COUNTER, FLAG, HEADER, HEADER_SIZE, PHYSICS_SUBSTEPS, UNIT, bodyBase, unpackRotation, type PieceRef } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import type { ArcadeSession } from '../session';

export { placeBall } from './camera';
export { useBallInput } from './ball-input';
/** Named player/goalkeeper actors stay in World; these are native sports props. */
export const BALL_SCENE_KINDS: ReadonlySet<string> = new Set(['physics-ball', 'opponent-ball', 'goal', 'home-goal', 'hoop', 'hole', 'pin']);

/** Assembly gates preserve the native launch recipe used by the aiming preview. */
export function ballLaunchRule(rules: readonly PieceRef[]): PieceRef | undefined {
  return rules.map(underlyingRule).find(rule => rule.id === 'ball_launch');
}

export function BallScene({ session, look }: { readonly session: ArcadeSession; readonly look: Look }) {
  const groups = useRef(new Map<number, Group>());
  const spheres = useRef(new Map<number, Mesh>());
  const dots = useRef<(Mesh | null)[]>([]);
  const ready = useRef<Mesh>(null);
  const { props, slots, launch, goal } = useMemo(() => {
    const state = session.world.initial;
    const launch = ballLaunchRule(session.world.rules);
    const template = bodyBase(Number(launch?.params.template ?? 1));
    return {
      launch: { y: state[template + BODY.y]!, z: state[template + BODY.z]!, size: state[template + BODY.w]! },
      goal: String(launch?.params.goal ?? 'goal'),
      slots: Array.from({ length: (state.length - HEADER_SIZE) / BODY_STRIDE }, (_, index) => index),
      props: Array.from({ length: state[HEADER.bodyCount]! }, (_, index) => {
        const b = bodyBase(index);
        return { index, kind: session.world.kinds[state[b + BODY.kind]!]!, w: state[b + BODY.w]! / UNIT, h: state[b + BODY.h]! / UNIT, d: state[b + BODY.d]! / UNIT };
      }).filter(body => ['goal', 'home-goal', 'hoop', 'hole', 'pin'].includes(body.kind)),
    };
  }, [session]);
  useFrame(() => {
    if (renderHeld(session)) return;
    const state = session.state(), previous = session.prev(), alpha = session.alpha();
    const at = (b: number, field: number) => (previous[b + field]! + (state[b + field]! - previous[b + field]!) * alpha) / UNIT;
    for (const body of props) {
      const group = groups.current.get(body.index), b = bodyBase(body.index);
      if (group === undefined) continue;
      group.visible = Boolean(state[b + BODY.flags]! & FLAG.alive);
      group.position.set(-at(b, BODY.x), at(b, BODY.y) + body.h / 2, at(b, BODY.z));
      if (body.kind === 'pin') { const q = unpackRotation(state[b + BODY.aux0]!, state[b + BODY.aux1]!); group.quaternion.set(q[0]!, -q[1]!, -q[2]!, q[3]!); }
    }
    for (const index of slots) {
      const sphere = spheres.current.get(index), b = bodyBase(index);
      if (sphere === undefined) continue;
      const flags = state[b + BODY.flags]!;
      sphere.visible = (flags & (FLAG.alive | FLAG.physics | FLAG.ball)) === (FLAG.alive | FLAG.physics | FLAG.ball);
      if (!sphere.visible) continue;
      sphere.position.set(-at(b, BODY.x), at(b, BODY.y) + state[b + BODY.h]! / (2 * UNIT), at(b, BODY.z));
      sphere.scale.setScalar(state[b + BODY.w]! / (2 * UNIT));
      const q = unpackRotation(state[b + BODY.aux0]!, state[b + BODY.aux1]!);
      sphere.quaternion.set(q[0]!, -q[1]!, -q[2]!, q[3]!);
    }
    const p = bodyBase(state[HEADER.player]!), charge = Math.max(0, state[p + BODY.aux1]!);
    const cooldown = state[HEADER.counters + COUNTER.cooldown]!;
    // A visible recovery dial reads the simulation counter, never changes it.
    if (ready.current) ready.current.scale.setScalar(cooldown === 0 ? 1 : Math.max(0.05, 1 - cooldown / 288));
    // This is a free-flight hint, not a solver: it deliberately stops at ground
    // and does not promise to pass a moving keeper. No schema/runtime imports.
    const vz = 100 + 4 * Math.max(1, Math.min(60, charge));
    const vx = Math.trunc(vz * state[p + BODY.aux0]! / 1000);
    const vy = goal === 'hoop' ? 300 : goal === 'hole' ? 150 : 80;
    const lag = 8 * (PHYSICS_SUBSTEPS - 1) / (2 * PHYSICS_SUBSTEPS);
    for (let index = 0; index < dots.current.length; index++) {
      const dot = dots.current[index];
      if (dot == null) continue;
      const t = (index + 1) * 3, y = launch.y + vy * t - 4 * t * (t + 1) + t * lag;
      dot.visible = cooldown === 0 && charge > 0 && y > 0;
      dot.position.set(-vx * t / UNIT, (y + launch.size / 2) / UNIT, (launch.z + vz * t) / UNIT);
    }
  });
  return <>
    <group position={[-1.2, 1, 1.5]}>
      <mesh><ringGeometry args={[0.27, 0.3, 24]} /><meshBasicMaterial color={color.cream} side={2} /></mesh>
      <mesh ref={ready}><circleGeometry args={[0.24, 24]} /><meshBasicMaterial color={color.sun} side={2} /></mesh>
    </group>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 10]} receiveShadow>
      <planeGeometry args={[40, 50]} /><meshStandardMaterial color={look.ground} roughness={1} />
    </mesh>
    {props.map(body => <group key={body.index} ref={group => { if (group === null) groups.current.delete(body.index); else groups.current.set(body.index, group); }}>
      {body.kind === 'pin' ? <mesh><boxGeometry args={[body.w, body.h, body.d]} /><meshStandardMaterial color={color.cream} roughness={0.5} /></mesh> : body.kind === 'hoop' ? <group>
        <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[body.w / 2, 0.07, 8, 24]} /><meshStandardMaterial color={color.tomato} /></mesh>
        <mesh position={[0, 0.8, body.d / 2]}><boxGeometry args={[body.w + 0.5, 1.2, 0.12]} /><meshStandardMaterial color={color.cream} /></mesh>
      </group> : body.kind === 'hole' ? <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -body.h / 2 + 0.025, 0]}>
        <circleGeometry args={[body.w / 2, 24]} /><meshBasicMaterial color={color.ink} />
      </mesh> : <group>
        {[-1, 1].map(side => <mesh key={side} position={[side * body.w / 2, 0, 0]}><boxGeometry args={[0.1, body.h, 0.1]} /><meshStandardMaterial color={color.cream} /></mesh>)}
        <mesh position={[0, body.h / 2, 0]}><boxGeometry args={[body.w + 0.1, 0.1, 0.1]} /><meshStandardMaterial color={color.cream} /></mesh>
        <mesh position={[0, 0, body.d / 2]}><boxGeometry args={[body.w, body.h, 0.025]} /><meshBasicMaterial color={color.cream} wireframe transparent opacity={0.35} /></mesh>
      </group>}
    </group>)}
    {slots.map(index => <mesh key={index} visible={false} ref={mesh => { if (mesh === null) spheres.current.delete(index); else spheres.current.set(index, mesh); }} castShadow>
      <sphereGeometry args={[1, 16, 12]} /><meshStandardMaterial color={color.cream} roughness={0.6} />
    </mesh>)}
    {Array.from({ length: 28 }, (_, index) => <mesh key={index} visible={false} ref={mesh => { dots.current[index] = mesh; }} userData={{ rigShadow: 'none' }}>
      <sphereGeometry args={[0.045, 6, 4]} /><meshBasicMaterial color={color.sun} transparent opacity={0.85 - index * 0.02} fog={false} />
    </mesh>)}
  </>;
}

export const BallBackdrop = BallScene;
