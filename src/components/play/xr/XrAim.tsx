'use client';

/**
 * Míření paprskem pravého ovladače (P65 T3). Paprsek se převede do prostoru hry (obal světa v `XrRig` ho
 * zmenšuje a otáčí) a protne rovinu, na kterou míří prst: střílečka rovinu hlavně, pruhy zem. Z průsečíku vzejde
 * táž osa jako z dotyku (`aimOfPoint` → `aimAt` / pruh) a jde do relace přes `XrInput`. Zaměřovač sedí
 * na průsečíku; soubory `shooter/**` (P62) se nemění.
 */

import { useFrame } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useMemo, useRef } from 'react';
import { type Group, Matrix4, type Mesh, Plane, Quaternion, Ray, Vector3 } from 'three';

import { colorHex } from '@/brand/tokens';
import { UNIT } from '@/play/arcade/contract';
import { SHOOTER, aimAt } from '@/play/arcade/pieces/shooter';
import { type XrControl, type XrMotion, aimOfPoint } from '@/play/xr/input-map';

import type { ArcadeSession } from '../arcade/session';

/** Paprsek bez průsečíku (nad obzorem) je dlouhý tolik metrů. */
const RAY_M = 12;
/** Zaměřovač roste se vzdáleností, ať je z dálky vidět stejně velký. */
const RETICLE_PER_M = 0.008;

/** Před `XrInput` (priorita 0): osa míření musí být hotová dřív, než ji ovladače pošlou do relace. */
export const MOTION_PRIORITY = -1;

export function XrAim({
  session,
  control,
  world,
  motion,
}: {
  readonly session: ArcadeSession;
  readonly control: XrControl;
  readonly world: RefObject<Group | null>;
  readonly motion: RefObject<XrMotion>;
}) {
  const right = useXRInputSourceState('controller', 'right');
  const space = useXR((xr) => xr.originReferenceSpace);
  const ray = useRef<Mesh>(null);
  const reticle = useRef<Mesh>(null);
  const at = useMemo(() => ({ origin: new Vector3(), dir: new Vector3(), hit: new Vector3(), turn: new Quaternion(), toGame: new Matrix4(), local: new Ray(), plane: new Plane(new Vector3(0, 1, 0)) }), []);

  useFrame((_, __, frame: XRFrame | undefined) => {
    motion.current.aim = null;
    const group = world.current;
    const pose = right !== undefined && space !== undefined && frame !== undefined ? frame.getPose(right.inputSource.targetRaySpace, space) : undefined;
    if (ray.current !== null) ray.current.visible = pose != null;
    if (reticle.current !== null) reticle.current.visible = false;
    if (pose == null || group === null) return;
    const { position, orientation } = pose.transform;
    at.origin.set(position.x, position.y, position.z);
    at.turn.set(orientation.x, orientation.y, orientation.z, orientation.w);
    at.dir.set(0, 0, -1).applyQuaternion(at.turn);

    group.updateMatrixWorld();
    at.toGame.copy(group.matrixWorld).invert();
    at.local.origin.copy(at.origin).applyMatrix4(at.toGame);
    at.local.direction.copy(at.dir).transformDirection(at.toGame);
    at.plane.constant = control.input === 'shooter-rig' ? -SHOOTER.muzzleY / UNIT : 0;

    let length = RAY_M;
    // Scéna zrcadlí osu x jádra (x → −x), stejně jako těla.
    if (at.local.intersectPlane(at.plane, at.hit) !== null) {
      motion.current.aim = aimOfPoint(control.input, -at.hit.x * UNIT, at.hit.z * UNIT, session.state());
      if (motion.current.aim !== null) {
        at.hit.applyMatrix4(group.matrixWorld);
        length = at.origin.distanceTo(at.hit);
        if (reticle.current !== null) {
          reticle.current.position.copy(at.hit);
          reticle.current.scale.setScalar(Math.max(0.01, length * RETICLE_PER_M));
          reticle.current.visible = true;
        }
      }
    }
    // Nad obzorem míří střílečka podle směru paprsku, jako prst nad obzorem (`ShooterRig`). Směr v jednotkách
    // jádra: `aimAt` bere hloubku nejméně 1 jednotku, jednotkový vektor by míření srazil k nule.
    if (motion.current.aim === null && control.input === 'shooter-rig' && at.local.direction.z > 0) motion.current.aim = aimAt(-at.local.direction.x * UNIT, at.local.direction.z * UNIT);

    if (ray.current !== null) {
      ray.current.position.copy(at.origin).addScaledVector(at.dir, length / 2);
      ray.current.quaternion.copy(at.turn);
      ray.current.scale.set(1, 1, length);
    }
  }, MOTION_PRIORITY);

  return (
    <>
      <mesh ref={ray} visible={false}>
        <boxGeometry args={[0.004, 0.004, 1]} />
        <meshBasicMaterial color={colorHex.paper} transparent opacity={0.55} toneMapped={false} />
      </mesh>
      <mesh ref={reticle} visible={false}>
        <sphereGeometry args={[1, 16, 12]} />
        <meshBasicMaterial color={colorHex.tomato} toneMapped={false} />
      </mesh>
    </>
  );
}
