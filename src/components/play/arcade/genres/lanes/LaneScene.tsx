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
import { BODY, FLAG, ROLE, UNIT, bodyBase, nativeRule } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';

import { bodiesOf, bodiesStale, drawsNothing } from '../../bodies';
import { renderHeld } from '../../effects/render-feel';
import type { ArcadeSession } from '../../session';
import type { WorldProps } from '../../World';
import { CatchScene } from '../catch/CatchScene';
import { DefenseScene } from '../defense/DefenseScene';
import { SliceScene } from '../slice/SliceScene';
import { WhackScene } from '../whack/WhackScene';
import { LaneStrips } from './LaneStrips';

export { useLanesInput } from './lanes-input';

/**
 * Scéna žánru v pruzích podle pravidla světa (P54C T5): chytání kreslí `CatchScene`, bouchání
 * `WhackScene` (T6), obranu pruhů `DefenseScene` (T7), krájení `SliceScene` (T8), žánr bez vlastní
 * scény kostru pruhů. Další žánry pruhů přidají svou větev sem, ne do `ArcadeStage`.
 */
export function LaneStage(props: Omit<WorldProps, 'control' | 'backdrop'>) {
  if (nativeRule(props.session.world.rules, 'catch_fall') !== undefined) return <CatchScene {...props} />;
  if (nativeRule(props.session.world.rules, 'whack_hit') !== undefined) return <WhackScene {...props} />;
  if (nativeRule(props.session.world.rules, 'defense_hit') !== undefined) return <DefenseScene {...props} />;
  if (nativeRule(props.session.world.rules, 'slice_cut') !== undefined) return <SliceScene {...props} />;
  return <LaneScene session={props.session} look={props.scene} />;
}

const LANE_LENGTH = 40;
/** Kamera pruhů: kde stojí a kam kouká (m scény). */
export const LANE_CAMERA = { position: [0, 7.6, -9], look: [0, 0, 9.5] } as const;
const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

const bodyColor = (role: number): string =>
  role === ROLE.player ? color['sky-deep'] : role === ROLE.collectible ? color.sun : role === ROLE.hazard || role === ROLE.enemy ? color.tomato : color['ink-soft'];

export function LaneScene({ session, look }: { readonly session: ArcadeSession; readonly look: Look }) {
  const camera = useThree((three) => three.camera);
  const [views, setViews] = useState(() => bodiesOf(session));
  const meshes = useRef<(Mesh | null)[]>([]);

  useLayoutEffect(() => {
    // P73D T2: sklon 29° → 22° (`DIORAMA_FRAMING.lanes`), obzor zpátky pod horní hranu (NDC 0,98 → 0,71).
    camera.position.set(...LANE_CAMERA.position);
    camera.lookAt(...LANE_CAMERA.look);
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
      <LaneStrips look={look} z0={-4} z1={LANE_LENGTH - 4} />
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
