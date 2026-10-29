'use client';

/**
 * Svět kolem hráče (P67 T6, režim `room`): aréna, obrana a chytání stojí na podlaze pokoje v měřítku 1:1 až 1:3
 * (`roomOf` v `xr/modes.ts`). Obal světa je otočený o půl kruhu jako u ostatních režimů, takže hráč kouká tam,
 * kam ve 2D kouká kamera. Poloha se spočte jednou ze startu úrovně: hrdina se hýbe, hráč a svět ne.
 *
 * Chytání: koš drží pravá ruka. Poloha ruky se převede do os hry a do `XrMotion.handX`; na osu pruhu ji převede
 * `input-map` (`laneAxisOfX`), stejně jako ruku krájení a bouchání. Do hashovaného stavu jde jen ta osa.
 */

import { useFrame } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useEffect, useMemo } from 'react';
import { type Group, Matrix4, Vector3 } from 'three';

import { UNIT } from '@/play/arcade/contract';
import type { XrMotion } from '@/play/xr/input-map';
import { type RoomPlacement, type XrPose, roomOf } from '@/play/xr/modes';

import type { ArcadeSession } from '../arcade/session';
import { MOTION_PRIORITY } from './XrAim';
import { XrSky } from './XrSky';

/** Co o světě `room` čte sonda (`XrProbe`). */
export interface RoomReport extends RoomPlacement {
  readonly pose: XrPose;
}

export function XrRoom({
  world,
  session,
  pose,
  hand,
  motion,
  report,
}: {
  readonly world: RefObject<Group | null>;
  readonly session: ArcadeSession;
  readonly pose: XrPose;
  /** Pruh drží pravá ruka (chytání). */
  readonly hand: boolean;
  readonly motion: RefObject<XrMotion>;
  readonly report: RefObject<RoomReport | null>;
}) {
  const right = useXRInputSourceState('controller', 'right');
  const space = useXR((xr) => xr.originReferenceSpace);
  const placement = useMemo(() => roomOf(pose, session.world), [pose, session]);
  const at = useMemo(() => ({ hand: new Vector3(), toGame: new Matrix4() }), []);

  useEffect(() => {
    report.current = { ...placement, pose };
    return () => {
      report.current = null;
    };
  }, [report, placement, pose]);
  useEffect(
    () => () => {
      motion.current.handX = null;
      world.current?.position.set(0, 0, 0);
      world.current?.rotation.set(0, 0, 0);
      world.current?.scale.setScalar(1);
    },
    [world, motion],
  );

  // Před míření paprskem (`XrAim`) a vstupem (`XrInput`): oba čtou matici obalu z tohoto snímku.
  useFrame((_, __, frame: XRFrame | undefined) => {
    const group = world.current;
    if (group === null) return;
    const { scale, anchor } = placement;
    // Obal otočený o půl kruhu postaví bod scény (x, 0, z) k nohám hráče, když sám stojí v (x, 0, z) · měřítko.
    group.position.set(scale * anchor.x, 0, scale * anchor.z);
    group.rotation.set(0, Math.PI, 0);
    group.scale.setScalar(scale);
    if (!hand) return;
    const source = right?.inputSource;
    const grip = source !== undefined && space !== undefined && frame !== undefined ? frame.getPose(source.gripSpace ?? source.targetRaySpace, space) : undefined;
    if (grip == null) {
      motion.current.handX = null;
      return;
    }
    group.updateMatrixWorld();
    const { position } = grip.transform;
    at.hand.set(position.x, position.y, position.z).applyMatrix4(at.toGame.copy(group.matrixWorld).invert());
    // Scéna zrcadlí osu x jádra (x → −x), stejně jako těla.
    motion.current.handX = -at.hand.x * UNIT;
  }, MOTION_PRIORITY - 1);

  return <XrSky game={session} />;
}
