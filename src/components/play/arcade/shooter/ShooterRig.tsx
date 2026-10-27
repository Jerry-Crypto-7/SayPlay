'use client';

import { renderHeld } from '../effects/render-feel';

/**
 * Scéna střelnice (P25G T6): kamera za hráčem a nad ním (na výšku strměji
 * shora, ať se vejde šířka střelnice), zaměřovač ve směru míření a vstup.
 *
 * Vstup: ťuk/klik na místo = zamíří tam a vystřelí (paprsek z kamery na
 * rovinu ve výšce hlavně), tah s prstem dole míří dál; šipky/A-D míří,
 * mezerník/šipka nahoru/W střílí. Míření jde do relace jako držená osa,
 * takže padne do tiku i do záznamu.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { type Group, type PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';

import { type ArcadeState, BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { SHOOTER, aimAt, aimVelocity } from '@/play/arcade/pieces/shooter';
import type { HeroAction } from '@/play/spec';

import { ShootThrowFx } from '../action-cue/ShootThrowFx';
import { type ArcadeGhost, GhostSlot } from '../GhostSlot';
import { isTyping } from '../input';
import { FieldDressing } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { TALL, WIDE } from './view';

const MUZZLE_Y = SHOOTER.muzzleY / UNIT;
const RETICLE_M = 20;
const FIRE_KEYS = new Set([' ', 'arrowup', 'w']);
/** Značka pro `ShadowFlags` rigu: síť stín nevrhá ani nepřijímá. */
const AID = { rigShadow: 'none' } as const;
const TALL_AXIS = Math.hypot(TALL.up, TALL.back + TALL.ahead);
/**
 * Na výšku je záběr úzký a nepřítel jde k hráči až pod 35° (`laneSpread`) – stál za bokem obrazu (P58A T4).
 * Kamera se kolem hráče natočí jen tolik, aby nejbližší terč či nepřítel zůstal do `TURN_EDGE` NDC;
 * dotáčí rychlostí `TURN_RATE` (1/s). Nový nejbližší za okrajem obrazu (padl ten předchozí, další jde
 * z druhé strany) kamera ukáže hned – dotáčení přes 30° by ho pár snímků nechalo mimo záběr.
 * Na šířku se vejde celý kužel míření a kamera se netočí.
 */
const TURN_EDGE = 0.7;
const TURN_RATE = 10;
const FOES: ReadonlySet<number> = new Set([ROLE.target, ROLE.enemy]);

/** Největší úhel od osy kamery na výšku, pod kterým bod `r` m před hráčem promítne do ±`edge` NDC (`tanX` = tangenta poloviny vodorovného zorného úhlu). */
function tallReach(r: number, tanX: number, edge: number): number {
  const fz = (TALL.back + TALL.ahead) / TALL_AXIS;
  const depth = (TALL.up * TALL.up + TALL.back * (TALL.back + TALL.ahead)) / TALL_AXIS;
  const k = edge * tanX;
  return Math.atan(k * fz) + Math.asin(Math.min(1, (k * depth) / (r * Math.hypot(1, k * fz))));
}

/**
 * Kam se má kamera na výšku natočit (rad, kladně k +x scény): co nejméně od `yaw`, aby nejbližší terč či nepřítel
 * před hráčem zůstal v záběru. `cut` = je teď celý mimo obraz.
 */
function tallYaw(state: ArcadeState, player: number, yaw: number, tanX: number): { readonly goal: number; readonly cut: boolean } {
  const p = bodyBase(player);
  let best: { readonly dx: number; readonly dz: number; readonly r: number } | null = null;
  for (let index = 0; index < (state[HEADER.bodyCount] as number); index += 1) {
    const at = bodyBase(index);
    if (index === player || !FOES.has(state[at + BODY.role] as number) || ((state[at + BODY.flags] as number) & FLAG.alive) === 0) continue;
    // Jádro má +x vlevo od kamery, scéna ho zrcadlí.
    const dx = ((state[p + BODY.x] as number) - (state[at + BODY.x] as number)) / UNIT;
    const dz = ((state[at + BODY.z] as number) - (state[p + BODY.z] as number)) / UNIT;
    const r = Math.hypot(dx, dz);
    if (dz > 0 && (best === null || r < best.r)) best = { dx, dz, r };
  }
  if (best === null) return { goal: 0, cut: false };
  const bearing = Math.atan2(best.dx, best.dz);
  const reach = tallReach(best.r, tanX, TURN_EDGE);
  return { goal: Math.max(bearing - reach, Math.min(bearing + reach, yaw)), cut: Math.abs(bearing - yaw) > tallReach(best.r, tanX, 1) };
}

export function ShooterRig({
  session,
  surface,
  enabled,
  ghost,
  look: scene,
}: {
  readonly session: ArcadeSession;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
  /** Sada prostředí: kulisy uvnitř kuželu míření (P62 T4). */
  readonly look: Look;
}) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const reticle = useRef<Group | null>(null);
  const look = useMemo(() => new Vector3(), []);
  const yaw = useRef(0);

  useFrame((_, delta) => {
    if (renderHeld(session)) return;
    const state = session.state();
    const player = state[HEADER.player] as number;
    const p = bodyBase(player);
    const z = (state[p + BODY.z] as number) / UNIT;
    if (camera.aspect < 1) {
      const { goal, cut } = tallYaw(state, player, yaw.current, Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
      yaw.current += (goal - yaw.current) * (cut ? 1 : 1 - Math.exp(-delta * TURN_RATE));
      const x = -(state[p + BODY.x] as number) / UNIT;
      const sin = Math.sin(yaw.current);
      const cos = Math.cos(yaw.current);
      camera.position.set(x - TALL.back * sin, TALL.up, z - TALL.back * cos);
      look.set(x + TALL.ahead * sin, 0, z + TALL.ahead * cos);
    } else {
      camera.position.set(0, WIDE.up, z - WIDE.back);
      look.set(0, WIDE.aim, z + WIDE.ahead);
    }
    camera.lookAt(look);
    camera.updateMatrixWorld();
    const group = reticle.current;
    if (group !== null) {
      // Jádro má +x vlevo od kamery, scéna ho zrcadlí (x → −x).
      const { vx, vz } = aimVelocity(state[p + BODY.aux0] as number);
      group.position.set(-(state[p + BODY.x] as number) / UNIT, MUZZLE_Y, z + SHOOTER.playerD / 2 / UNIT);
      group.rotation.y = Math.atan2(-vx, vz);
    }
  });

  useEffect(() => {
    const element = surface.current;
    if (element === null || !enabled) return;
    const raycaster = new Raycaster();
    const ground = new Plane(new Vector3(0, 1, 0), -MUZZLE_Y);
    const hit = new Vector3();
    const ndc = new Vector2();
    let aiming: number | null = null;

    /** Míření na bod pod ukazatelem; nad obzorem podle směru paprsku. */
    const aimOf = (event: PointerEvent): number | null => {
      const box = element.getBoundingClientRect();
      ndc.set(((event.clientX - box.left) / Math.max(1, box.width)) * 2 - 1, -((event.clientY - box.top) / Math.max(1, box.height)) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const state = session.state();
      const p = bodyBase(state[HEADER.player] as number);
      const muzzleZ = (state[p + BODY.z] as number) + SHOOTER.playerD / 2;
      if (raycaster.ray.intersectPlane(ground, hit) !== null && hit.z * UNIT > muzzleZ) return aimAt(-hit.x * UNIT - (state[p + BODY.x] as number), hit.z * UNIT - muzzleZ);
      const dir = raycaster.ray.direction;
      return dir.z > 0 ? aimAt(-dir.x, dir.z) : null;
    };
    const onDown = (event: PointerEvent) => {
      aiming = event.pointerId;
      const aim = aimOf(event) ?? 0;
      session.hold(aim);
      // Osa jde i se stiskem: krátký klik se pustí dřív, než tik padne, a výstřel by letěl postaru.
      session.press(BUTTON.TAP, aim);
    };
    const onMove = (event: PointerEvent) => {
      if (aiming !== event.pointerId) return;
      const aim = aimOf(event);
      if (aim !== null) session.hold(aim);
    };
    const onUp = (event: PointerEvent) => {
      if (aiming !== event.pointerId) return;
      aiming = null;
      session.hold(0);
    };

    const keys = new Set<number>();
    const sideOf = (key: string): number => (key === 'arrowleft' || key === 'a' ? BUTTON.LEFT : key === 'arrowright' || key === 'd' ? BUTTON.RIGHT : 0);
    const sync = (): void => session.holdButtons([...keys].reduce((mask, bit) => mask | bit, 0));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const side = sideOf(key);
      if (side !== 0) {
        event.preventDefault();
        keys.add(side);
        sync();
      } else if (FIRE_KEYS.has(key) && !event.repeat) {
        event.preventDefault();
        session.press(BUTTON.TAP);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const side = sideOf(event.key.toLowerCase());
      if (side === 0) return;
      keys.delete(side);
      sync();
    };
    const release = (): void => {
      keys.clear();
      sync();
      aiming = null;
      session.hold(0);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [session, surface, camera, enabled]);

  // Zaměřovač: průsvitný paprsek z hlavně a kříž s kroužkem ve 20 m. Je to pomůcka, ne věc
  // ve scéně: mlha rigu ho nezakryje a stín nevrhá – kroužek na zemi by vypadal jako terč (P32A T10).
  return (
    <>
      {/* Slot ducha (P37-0 T3) vedle zaměřovače, ne v něm – skupina zaměřovače se hýbe s mířením. */}
      <GhostSlot ghost={ghost} session={session} />
      {/* Výstřel vidět (P43 T5): záblesk u hlavně a stopa střely. */}
      <ShootThrowFx session={session} verb="shoot" />
      {/* Kulisy sady v kuželu míření mimo dráhy nepřátel a terčů (P62 T4). */}
      <FieldDressing look={scene} world={session.world} />
      <group ref={reticle}>
        <mesh position={[0, 0, RETICLE_M / 2]} userData={AID}>
          <boxGeometry args={[0.03, 0.03, RETICLE_M]} />
          <meshBasicMaterial color="#ef4444" transparent opacity={0.45} fog={false} />
        </mesh>
        <group position={[0, 0, RETICLE_M]}>
          <mesh userData={AID}>
            <torusGeometry args={[0.6, 0.06, 8, 24]} />
            <meshBasicMaterial color="#ef4444" fog={false} />
          </mesh>
          <mesh userData={AID}>
            <boxGeometry args={[1.6, 0.06, 0.06]} />
            <meshBasicMaterial color="#ef4444" fog={false} />
          </mesh>
          <mesh userData={AID}>
            <boxGeometry args={[0.06, 1.6, 0.06]} />
            <meshBasicMaterial color="#ef4444" fog={false} />
          </mesh>
        </group>
      </group>
    </>
  );
}
