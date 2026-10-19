'use client';

/**
 * Scéna-kostra pruhů (P54C T4): pět pásů před kamerou a kvádry těl ze stavu.
 * Sdílí ji chytání, bouchání, obrana pruhů a krájení; modely a efekty doplní
 * úlohy jednotlivých žánrů, světlo dává `StyleRig`. Kamera kouká po +z, takže x jádra se zrcadlí
 * jako u běžce – pruh 0 (osa −1000, levý pás plátna) leží vlevo.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Mesh } from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { LANES, laneX } from '@/play/arcade/pieces/lanes';

import { bodiesOf, bodiesStale, drawsNothing } from '../../bodies';
import { renderHeld } from '../../effects/render-feel';
import type { ArcadeSession } from '../../session';

export { useLanesInput } from './lanes-input';

const LANE_LENGTH = 40;
const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

const bodyColor = (role: number): string =>
  role === ROLE.player ? color['sky-deep'] : role === ROLE.collectible ? color.sun : role === ROLE.hazard || role === ROLE.enemy ? color.tomato : color['ink-soft'];

export function LaneScene({ session }: { readonly session: ArcadeSession }) {
  const camera = useThree((three) => three.camera);
  const [views, setViews] = useState(() => bodiesOf(session));
  const meshes = useRef<(Mesh | null)[]>([]);

  useLayoutEffect(() => {
    camera.position.set(0, 9, -8);
    camera.lookAt(0, 0, 8);
  }, [camera]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (bodiesStale(views, session)) setViews(bodiesOf(session));
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    for (const view of views) {
      const mesh = meshes.current[view.index];
      if (mesh === undefined || mesh === null) continue;
      const base = bodyBase(view.index);
      mesh.visible = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      const at = (slot: number): number => lerp(prev[base + slot] as number, state[base + slot] as number, alpha) / UNIT;
      mesh.position.set(-at(BODY.x), at(BODY.y) + view.h / 2, at(BODY.z));
    }
  });

  return (
    <>
      {Array.from({ length: LANES.count }, (_, lane) => (
        <mesh key={lane} position={[-laneX(lane) / UNIT, -0.05, LANE_LENGTH / 2 - 4]} receiveShadow>
          <boxGeometry args={[(LANES.width / UNIT) * 0.9, 0.1, LANE_LENGTH]} />
          <meshStandardMaterial color={lane % 2 === 0 ? color.mint : color['mint-deep']} />
        </mesh>
      ))}
      {views.map((view) =>
        drawsNothing(view) ? null : (
          <mesh
            key={`${view.index}-${view.kind}-${view.role}`}
            ref={(mesh) => {
              meshes.current[view.index] = mesh;
            }}
            castShadow
          >
            <boxGeometry args={[view.w, view.h, view.d]} />
            <meshStandardMaterial color={bodyColor(view.role)} />
          </mesh>
        ),
      )}
    </>
  );
}
