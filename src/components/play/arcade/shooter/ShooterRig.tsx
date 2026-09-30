'use client';

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

import { BODY, BUTTON, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { SHOOTER, aimAt, aimVelocity } from '@/play/arcade/pieces/shooter';

import { isTyping } from '../input';
import type { ArcadeSession } from '../session';

const MUZZLE_Y = SHOOTER.muzzleY / UNIT;
const RETICLE_M = 20;
const FIRE_KEYS = new Set([' ', 'arrowup', 'w']);
/** Značka pro `ShadowFlags` rigu: síť stín nevrhá ani nepřijímá. */
const AID = { rigShadow: 'none' } as const;

export function ShooterRig({ session, surface, enabled }: { readonly session: ArcadeSession; readonly surface: React.RefObject<HTMLDivElement | null>; readonly enabled: boolean }) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const reticle = useRef<Group | null>(null);
  const look = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const state = session.state();
    const p = bodyBase(state[HEADER.player] as number);
    const z = (state[p + BODY.z] as number) / UNIT;
    if (camera.aspect < 1) {
      camera.position.set(0, 20, z - 9);
      look.set(0, 0, z + 13);
    } else {
      camera.position.set(0, 3.6, z - 5.5);
      look.set(0, 1, z + 14);
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
  );
}
