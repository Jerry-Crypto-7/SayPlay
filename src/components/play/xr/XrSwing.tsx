'use client';

/**
 * Pohyb ruky (P65 T3): rychlost pravého ovladače a pruh pod ním pro hod, krájení a bouchání. Rychlost dává
 * runtime brýlí (`XRPose.linearVelocity`); kde ji nedá, spočte se z poloh dvou snímků. Do hry jde otočená do os
 * světa hry, ale ve skutečných m/s – prahy švihu (`SWING`) jsou o ruce, ne o měřítku dioramy. Zásah (body nebo
 * sebraný kus přibyly) krátce zavibruje ovladačem; vibrace jsou mimo hashovaný stav.
 */

import { useFrame } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useMemo } from 'react';
import { type Group, Matrix4, Quaternion, Vector3 } from 'three';

import { UNIT } from '@/play/arcade/contract';
import { axisOfLane, laneOfX } from '@/play/arcade/pieces/lanes';
import type { XrMotion } from '@/play/xr/input-map';

import type { ArcadeSession } from '../arcade/session';
import { MOTION_PRIORITY } from './XrAim';

/** Vibrace zásahu: síla 0–1 a délka v ms. */
const HIT_PULSE = { intensity: 0.6, ms: 40 } as const;

type Pulsing = { pulse?: (intensity: number, ms: number) => Promise<boolean> };

export function XrSwing({ session, world, motion }: { readonly session: ArcadeSession; readonly world: RefObject<Group | null>; readonly motion: RefObject<XrMotion> }) {
  const right = useXRInputSourceState('controller', 'right');
  const space = useXR((xr) => xr.originReferenceSpace);
  const hand = useMemo(() => ({ at: new Vector3(), last: null as Vector3 | null, velocity: new Vector3(), inGame: new Vector3(), local: new Vector3(), turn: new Quaternion(), toGame: new Matrix4(), hits: -1 }), []);

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
    motion.current.laneAxis = axisOfLane(laneOfX(-hand.local.x * UNIT));

    const now = session.snapshot();
    const hits = now.score + now.items;
    if (hand.hits >= 0 && hits > hand.hits) void (right!.inputSource.gamepad?.hapticActuators?.[0] as Pulsing | undefined)?.pulse?.(HIT_PULSE.intensity, HIT_PULSE.ms);
    hand.hits = hits;
  }, MOTION_PRIORITY);

  return null;
}
