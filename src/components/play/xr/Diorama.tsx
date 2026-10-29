'use client';

/**
 * Diorama ve VR (P65 T4): svět hry zmenšený na desku před hráčem (`diorama-scale.ts`). Každý snímek najde
 * kresleného hrdinu, posune okno dioramy za ním a postaví obal světa na desku; co leží mimo prostor nad deskou,
 * se ořízne rovinami řezu, takže trať běžce nekončí v pokoji, ale na kraji stolu. Levý grip desku nese – posun
 * a otočení jsou jen pohled, do relace nic nejde (grip pravého ovladače dál drží použití, `XrInput`).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { type Group, type Material, Matrix4, type Mesh, type Object3D, Plane, Quaternion, Vector3 } from 'three';

import { colorHex } from '@/brand/tokens';
import { DESK, type DeskPose, type HandPose, TABLE, carried, createDiorama, playAreaOf } from '@/play/xr/diorama-scale';

import { runnerPathOf } from '../arcade/runner/path';
import type { ArcadeSession } from '../arcade/session';
import { MOTION_PRIORITY } from './XrAim';

/** Co o desce čte sonda (`XrProbe`): poloha desky a měřítko světa na ní. */
export interface DeskReport extends DeskPose {
  readonly scale: number;
}

const shown = (node: Object3D): boolean => {
  for (let at: Object3D | null = node; at !== null; at = at.parent) if (!at.visible) return false;
  return true;
};

/** Hrdina, jak ho značí scény pro sondu záběru (`userData.frame = 'hero'`); poslední viditelný, jako `FrameProbe`. */
export function heroNodeOf(root: Object3D): Object3D | null {
  let hero: Object3D | null = null;
  root.traverse((node) => {
    if (node.userData.frame === 'hero' && shown(node)) hero = node;
  });
  return hero;
}

/**
 * Jak často (snímky) se svět prochází: najít hrdinu znovu a dát řez materiálům, které mezitím přibyly (nové tělo,
 * dotažený model). simplified: nový kus je až 10 snímků vidět i mimo desku; kdyby to v T8 rušilo, procházet
 * při změně seznamu těl (`bodiesStale`) místo po snímcích.
 */
const SWEEP_EVERY = 10;

/** Deska pod světem: o 2 cm větší než prostor řezu, ať je vidět rám; plocha těsně pod zemí světa. */
const SLAB = { rim: 0.02, thick: 0.04, below: 0.002 } as const;

/** Roviny řezu v osách desky: prostor nad deskou (`TABLE`), zespodu o kousek pod její plochou kvůli zemi světa. */
const LOCAL_PLANES = [
  new Plane(new Vector3(1, 0, 0), TABLE.width / 2),
  new Plane(new Vector3(-1, 0, 0), TABLE.width / 2),
  new Plane(new Vector3(0, 0, 1), TABLE.depth / 2),
  new Plane(new Vector3(0, 0, -1), TABLE.depth / 2),
  new Plane(new Vector3(0, 1, 0), SLAB.below + 0.01),
  new Plane(new Vector3(0, -1, 0), TABLE.height),
] as const;

type Clippable = Material & { clippingPlanes: Plane[] | null };

/** Otočení ruky kolem svislé osy: kam míří vpřed (−z) ve vodorovné rovině; míří-li ruka svisle, `null`. */
function yawOf(turn: Quaternion, forward: Vector3): number | null {
  forward.set(0, 0, -1).applyQuaternion(turn);
  return Math.hypot(forward.x, forward.z) < 0.3 ? null : Math.atan2(-forward.x, -forward.z);
}

export function Diorama({ world, session, report }: { readonly world: RefObject<Group | null>; readonly session: ArcadeSession; readonly report: RefObject<DeskReport | null> }) {
  const gl = useThree((three) => three.gl);
  const left = useXRInputSourceState('controller', 'left');
  const space = useXR((xr) => xr.originReferenceSpace);
  const view = useMemo(() => {
    const path = runnerPathOf(session.world);
    return createDiorama(playAreaOf(session.world), path === null ? undefined : (z) => path(z).y);
  }, [session]);
  const desk = useRef<DeskPose>(DESK);
  const grab = useRef<{ readonly desk: DeskPose; readonly hand: HandPose } | null>(null);
  const slab = useRef<Mesh>(null);
  const at = useMemo(
    () => ({ hero: null as Object3D | null, frames: 0, point: new Vector3(), turn: new Quaternion(), forward: new Vector3(), matrix: new Matrix4(), planes: LOCAL_PLANES.map(() => new Plane()) }),
    [],
  );
  // Původní roviny řezu každého oříznutého materiálu, ať se po odchodu z dioramy vrátí, jak byly.
  const clipped = useMemo(() => new Map<Clippable, Plane[] | null>(), []);

  useEffect(() => {
    const before = gl.localClippingEnabled;
    gl.localClippingEnabled = true;
    return () => {
      gl.localClippingEnabled = before;
      for (const [material, planes] of clipped) material.clippingPlanes = planes;
      clipped.clear();
      report.current = null;
      world.current?.position.set(0, 0, 0);
      world.current?.rotation.set(0, 0, 0);
      world.current?.scale.setScalar(1);
    };
  }, [gl, clipped, report, world]);

  useFrame((_, __, frame: XRFrame | undefined) => {
    const group = world.current;
    if (group === null) return;

    // Levý grip nese desku: poloha ruky ve chvíli stisku je kotva, deska se drží ruky, dokud grip drží.
    const pose = left !== undefined && space !== undefined && frame !== undefined ? frame.getPose(left.inputSource.gripSpace ?? left.inputSource.targetRaySpace, space) : undefined;
    const squeezed = left?.gamepad['xr-standard-squeeze']?.state === 'pressed';
    if (squeezed && pose != null) {
      const { position, orientation } = pose.transform;
      const start = grab.current;
      // Ruka svisle otočení neurčí: deska se pak jen posouvá.
      const yaw = yawOf(at.turn.set(orientation.x, orientation.y, orientation.z, orientation.w), at.forward) ?? start?.hand.yaw ?? 0;
      const hand = { x: position.x, y: position.y, z: position.z, yaw };
      if (start === null) grab.current = { desk: desk.current, hand };
      else desk.current = carried(start.desk, start.hand, hand);
    } else {
      grab.current = null;
    }

    at.frames += 1;
    if ((at.hero !== null && at.hero.parent === null) || at.frames % SWEEP_EVERY === 1) {
      at.hero = heroNodeOf(group);
      group.traverse((node) => {
        const own = (node as Mesh).material as Clippable | Clippable[] | undefined;
        if (own === undefined) return;
        for (const material of Array.isArray(own) ? own : [own]) {
          if (material.clippingPlanes === at.planes) continue;
          if (!clipped.has(material)) clipped.set(material, material.clippingPlanes);
          material.clippingPlanes = at.planes;
        }
      });
    }
    // Hrdina v metrech scény: světová poloha zpět přes obal (jeho matice je ze snímku, kdy hrdinu kreslil).
    const hero = at.hero === null ? null : group.worldToLocal(at.hero.getWorldPosition(at.point));
    const { scale, center } = view.frame(hero === null ? null : { x: hero.x, y: hero.y, z: hero.z });

    // Obal = deska ∘ otočení o půl kruhu ∘ měřítko: bod `center` scény sedí na středu plochy desky.
    const { x, top, z, yaw } = desk.current;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const ox = scale * center.x;
    const oz = scale * center.z;
    group.position.set(x + ox * cos + oz * sin, top - scale * center.y, z - ox * sin + oz * cos);
    group.rotation.set(0, yaw + Math.PI, 0);
    group.scale.setScalar(scale);

    at.matrix.makeRotationY(yaw).setPosition(x, top, z);
    LOCAL_PLANES.forEach((plane, index) => at.planes[index]!.copy(plane).applyMatrix4(at.matrix));
    if (slab.current !== null) {
      slab.current.position.set(x, top - SLAB.below - SLAB.thick / 2, z);
      slab.current.rotation.set(0, yaw, 0);
    }
    report.current = { ...desk.current, scale };
  }, MOTION_PRIORITY - 1);

  return (
    <mesh ref={slab}>
      <boxGeometry args={[TABLE.width + 2 * SLAB.rim, SLAB.thick, TABLE.depth + 2 * SLAB.rim]} />
      <meshStandardMaterial color={colorHex['ink-soft']} roughness={0.9} />
    </mesh>
  );
}
