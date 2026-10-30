'use client';

/**
 * Diorama ve VR (P65 T4): svět hry zmenšený na desku před hráčem (`diorama-scale.ts`). Každý snímek najde
 * kresleného hrdinu, posune okno dioramy za ním a postaví obal světa na desku; co leží mimo prostor nad deskou,
 * se ořízne rovinami řezu, takže trať běžce nekončí v pokoji, ale na kraji stolu. Levý grip desku nese – posun
 * a otočení jsou jen pohled, do relace nic nejde (grip pravého ovladače dál drží použití, `XrInput`).
 *
 * Tratě (P67 T7, `STAGE_LAYOUT`) stojí stejně na velkém pódiu: deska je sokl až k podlaze, okolo podlaha okolí
 * (`XrSky`), vzdálená část trati mizí do mlhy v barvě obzoru (`stageFogOf`) a při pohybu světa se ztmaví okraj
 * obrazu (`XrVignette`).
 *
 * Výchozí poloha desky je v rámu hráče (P67 T9, `comfort.ts`): vsedě o 40 cm níž, po „Recenter“ před hlavou
 * a otočená k ní. Změna rámu vrátí desku na výchozí místo v novém rámu, i když ji hráč předtím posunul gripem.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { Fog, type Group, type Material, Matrix4, type Mesh, type Object3D, Plane, Quaternion, Vector3 } from 'three';

import { colorHex } from '@/brand/tokens';
import { LOOKS } from '@/play/arcade/look';
import { deskHome, usePlayerFrame } from '@/play/xr/comfort';
import { type DeskPose, type HandPose, type Layout, type Room, STAGE, carried, createDiorama, playAreaOf, stageFogOf } from '@/play/xr/diorama-scale';

import { runnerPathOf } from '../arcade/runner/path';
import type { ArcadeSession } from '../arcade/session';
import { MOTION_PRIORITY } from './XrAim';
import { XrSky, lookIdOf } from './XrSky';
import { XrVignette } from './XrVignette';

/** Co o desce čte sonda (`XrProbe`): poloha desky, měřítko světa na ní a prostor nad ní (stůl, nebo pódium). */
export interface DeskReport extends DeskPose {
  readonly scale: number;
  readonly room: Room;
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

/**
 * Deska pod světem: o 2 cm větší než prostor řezu, ať je vidět rám; plocha těsně pod zemí světa. Pod pódiem je
 * deska soklem až k podlaze (nejméně `thick`), aby velký svět nevisel ve vzduchu.
 */
const SLAB = { rim: 0.02, thick: 0.04, below: 0.002 } as const;

/** Roviny řezu v osách desky: prostor nad deskou (`room`), zespodu o kousek pod její plochou kvůli zemi světa. */
const planesOf = (room: Room): Plane[] => [
  new Plane(new Vector3(1, 0, 0), room.width / 2),
  new Plane(new Vector3(-1, 0, 0), room.width / 2),
  new Plane(new Vector3(0, 0, 1), room.depth / 2),
  new Plane(new Vector3(0, 0, -1), room.depth / 2),
  new Plane(new Vector3(0, 1, 0), SLAB.below + 0.01),
  new Plane(new Vector3(0, -1, 0), room.height),
];

type Clippable = Material & { clippingPlanes: Plane[] | null };

/** Otočení ruky kolem svislé osy: kam míří vpřed (−z) ve vodorovné rovině; míří-li ruka svisle, `null`. */
function yawOf(turn: Quaternion, forward: Vector3): number | null {
  forward.set(0, 0, -1).applyQuaternion(turn);
  return Math.hypot(forward.x, forward.z) < 0.3 ? null : Math.atan2(-forward.x, -forward.z);
}

/**
 * Prostor `layout` se za života komponenty nemění (`XrRig` ji při změně stolu za pódium postaví znovu): podle něj je
 * výchozí poloha desky, roviny řezu i sokl. Měřítko se měnit smí (velikost světa, P67 T9).
 */
export function Diorama({
  world,
  session,
  report,
  layout,
}: {
  readonly world: RefObject<Group | null>;
  readonly session: ArcadeSession;
  readonly report: RefObject<DeskReport | null>;
  readonly layout: Layout;
}) {
  const gl = useThree((three) => three.gl);
  const scene = useThree((three) => three.scene);
  const left = useXRInputSourceState('controller', 'left');
  const space = useXR((xr) => xr.originReferenceSpace);
  const { room } = layout;
  const stage = room === STAGE;
  const view = useMemo(() => {
    const path = runnerPathOf(session.world);
    return createDiorama(playAreaOf(session.world), layout, path === null ? undefined : (z) => path(z).y);
  }, [session, layout]);
  const player = usePlayerFrame();
  const home = useMemo(() => deskHome(room, player), [room, player]);
  const desk = useRef<DeskPose>(home);
  const grab = useRef<{ readonly desk: DeskPose; readonly hand: HandPose } | null>(null);
  useEffect(() => {
    desk.current = home;
    grab.current = null;
  }, [home]);
  const slab = useRef<Mesh>(null);
  // Rychlost světa (m/s skutečného prostoru) pro vinětaci pódia.
  const speed = useRef(0);
  const local = useMemo(() => planesOf(room), [room]);
  const at = useMemo(
    () => ({
      hero: null as Object3D | null,
      frames: 0,
      point: new Vector3(),
      turn: new Quaternion(),
      forward: new Vector3(),
      matrix: new Matrix4(),
      planes: local.map(() => new Plane()),
      last: null as { readonly view: unknown; readonly x: number; readonly y: number; readonly z: number } | null,
    }),
    [local],
  );
  // Původní roviny řezu každého oříznutého materiálu, ať se po odchodu z dioramy vrátí, jak byly.
  const clipped = useMemo(() => new Map<Clippable, Plane[] | null>(), []);
  // Barva obzoru sady prostředí scény, do které plátno kreslí (jako podlaha okolí `XrSky`); nová hra = jiná sada.
  const horizon = useMemo(() => LOOKS[lookIdOf(gl.domElement)].horizon, [gl, session]);

  // Mlha pódia ve skutečném prostoru (m od očí). Scéna nese svou mlhu v metrech scény a ve VR ji three nepoužije
  // (`<fog>` scény visí na obalu světa, ne na kořeni); po odchodu z pódia se vrátí, co kořen měl.
  useEffect(() => {
    if (!stage) return undefined;
    const before = scene.fog;
    const { near, far } = stageFogOf();
    scene.fog = new Fog(horizon, near, far);
    return () => {
      scene.fog = before;
    };
  }, [scene, stage, horizon]);

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

  useFrame((_, delta, frame: XRFrame | undefined) => {
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
    // Jak rychle jede svět (okno přes scénu); nová hra okno přeskočí, to pohyb není.
    const last = at.last;
    speed.current = last === null || last.view !== view ? 0 : (scale * Math.hypot(center.x - last.x, center.y - last.y, center.z - last.z)) / Math.max(delta, 1e-3);
    at.last = { view, ...center };

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
    local.forEach((plane, index) => at.planes[index]!.copy(plane).applyMatrix4(at.matrix));
    if (slab.current !== null) {
      // Sokl pódia sahá k podlaze světa (vsedě níž než skutečná podlaha).
      const thick = stage ? Math.max(SLAB.thick, top - player.top - SLAB.below) : SLAB.thick;
      slab.current.position.set(x, top - SLAB.below - thick / 2, z);
      slab.current.rotation.set(0, yaw, 0);
      slab.current.scale.set(1, thick, 1);
    }
    report.current = { ...desk.current, scale, room };
  }, MOTION_PRIORITY - 1);

  return (
    <>
      <mesh ref={slab}>
        <boxGeometry args={[room.width + 2 * SLAB.rim, 1, room.depth + 2 * SLAB.rim]} />
        <meshStandardMaterial color={colorHex['ink-soft']} roughness={0.9} />
      </mesh>
      {stage && <XrSky game={session} floor={player.top} />}
      {stage && <XrVignette speed={speed} />}
    </>
  );
}
