'use client';

/**
 * Pohyb ruky (P65 T3): rychlost pravého ovladače a pruh pod ním pro hod, krájení a bouchání. Rychlost dává
 * runtime brýlí (`XRPose.linearVelocity`); kde ji nedá, spočte se z poloh dvou snímků. Do hry jde otočená do os
 * světa hry, ale ve skutečných m/s – prahy švihu (`SWING`) jsou o ruce, ne o měřítku dioramy. Vibraci zásahu
 * pošle od P67 T8 tabulka událostí (`xr/haptics.ts`, `XrHaptics`).
 */

import { useFrame } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useMemo } from 'react';
import { type Group, Matrix4, Quaternion, Vector3 } from 'three';

import { UNIT } from '@/play/arcade/contract';
import { type XrMotion, laneAxisOfX } from '@/play/xr/input-map';

import { MOTION_PRIORITY } from './XrAim';

export function XrSwing({ world, motion }: { readonly world: RefObject<Group | null>; readonly motion: RefObject<XrMotion> }) {
  const right = useXRInputSourceState('controller', 'right');
  const space = useXR((xr) => xr.originReferenceSpace);
  const hand = useMemo(() => ({ at: new Vector3(), last: null as Vector3 | null, velocity: new Vector3(), inGame: new Vector3(), local: new Vector3(), turn: new Quaternion(), toGame: new Matrix4() }), []);

  useFrame((_, delta, frame: XRFrame | undefined) => {
    const group = world.current;
    const pose = right !== undefined && space !== undefined && frame !== undefined ? frame.getPose(right.inputSource.targetRaySpace, space) : undefined;
    if (pose == null || group === null) {
      motion.current.velocity = null;
      motion.current.laneAxis = null;
      hand.last = null;
      return;
    }
    const { position } = pose.transform;
    hand.at.set(position.x, position.y, position.z);
    const runtime = pose.linearVelocity;
    if (runtime !== undefined) hand.velocity.set(runtime.x, runtime.y, runtime.z);
    // simplified: rozdíl dvou snímků bez vyhlazení; kdyby runtime rychlost nedával a švih se chvěl, průměrovat přes 3–4 snímky.
    else if (hand.last !== null && delta > 0) hand.velocity.subVectors(hand.at, hand.last).divideScalar(delta);
    else hand.velocity.set(0, 0, 0);
    hand.last = (hand.last ?? new Vector3()).copy(hand.at);

    group.updateMatrixWorld();
    group.getWorldQuaternion(hand.turn).invert();
    motion.current.velocity = hand.inGame.copy(hand.velocity).applyQuaternion(hand.turn);
    hand.local.copy(hand.at).applyMatrix4(hand.toGame.copy(group.matrixWorld).invert());
    // Scéna zrcadlí osu x jádra (x → −x), stejně jako těla.
    motion.current.laneAxis = laneAxisOfX(-hand.local.x * UNIT);
  }, MOTION_PRIORITY);

  return null;
}
