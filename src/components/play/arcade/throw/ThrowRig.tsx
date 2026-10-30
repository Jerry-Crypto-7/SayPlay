'use client';

/**
 * Scéna hodu (P25G T6): boční kamera (hráč vlevo, cíle vpravo; na výšku
 * šikmo zezadu), náznak
 * dráhy během nabíjení a vstup tah-pusť.
 *
 * Vstup: stisk kdekoli = nabíjení (držené tlačítko `HOLD`), tah dolů zvedá
 * úhel, nahoru ho sklápí (jako prak), puštění = hod. Klávesnice: mezerník
 * držet a pustit, šipky nahoru/dolů (W/S) úhel. Náznak dráhy je prvních
 * ~0,8 s letu stejnou integrací jako jádro – kam míček doletí, hráč odhaduje sám.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, type Mesh, type PerspectiveCamera, Vector3 } from 'three';

import { AXIS_MAX, AXIS_MIN, BODY, BUTTON, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { GRAVITY } from '@/play/arcade/kernel';
import { THROW, launchVelocity } from '@/play/arcade/pieces/throw';
import type { HeroAction } from '@/play/spec';

import { ShootThrowFx } from '../action-cue/ShootThrowFx';
import { type ArcadeGhost, GhostSlot } from '../GhostSlot';
import { isTyping } from '../input';
import { usePlayRectRef } from '../portrait-frame';
import type { ArcadeSession } from '../session';
import { fitChase } from '../track-camera';

const DOTS = 12;
const DOT_EVERY = 4;
/** Osa za pixel tahu: 80 px = celý rozsah úhlu od 45°. */
const AXIS_PER_PX = 12;
/** Co musí být vidět: hřiště do ~26 m a výška ~9 m. */
const VIEW = { from: -3, to: 27, tall: 10, y: 4 } as const;
/**
 * Hřiště na výšku (P64 T5): kamera šikmo zezadu a z boku (`side`, `up`, `back`), míří na `lookY` m nad středem hřiště
 * posunutým o `lead`. Do `playRect` se vejde osa hřiště od hráče (`VIEW.from` + `near`) po nejvzdálenější cíl
 * (`VIEW.to` − `far`, těžká hra 22 m), `half` m napříč (cíle stojí na ose) a do výšky `top` m (věž čtyř bloků).
 * Celá šíře zdi a oblouk hodu se vejít nemusí – kamera by odjela a cíle zmenšila.
 */
const COURT_TALL = { side: -3.5, up: 7, back: -8, lookY: 2, lead: -3, near: 2, far: 7, half: 0.35, top: 3 } as const;
const court = new Box3();

export function ThrowRig({
  session,
  surface,
  enabled,
  ghost,
}: {
  readonly session: ArcadeSession;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
}) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const playRect = usePlayRectRef();
  const dots = useRef<(Mesh | null)[]>([]);
  const look = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const mid = (VIEW.from + VIEW.to) / 2;
    if (camera.aspect < 1) {
      // Na výšku by boční kamera ustoupila do mlhy: šikmo zezadu a z boku se hloubka hřiště vejde na výšku obrazu.
      // P64 T5: celé hřiště (`COURT_TALL`) do `playRect` mezi HUD a ovládáním, vzdálenost a posun dává `fitChase`.
      const view = COURT_TALL;
      camera.position.set(view.side, view.up, view.back);
      look.set(0, view.lookY, mid + view.lead);
      camera.lookAt(look);
      court.min.set(-view.half, 0, VIEW.from + view.near);
      court.max.set(view.half, view.top, VIEW.to - view.far);
      fitChase(camera, look, court, playRect.current);
    } else {
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const dist = Math.max((VIEW.to - VIEW.from) / (2 * tan * camera.aspect), VIEW.tall / (2 * tan));
      camera.position.set(-dist, VIEW.y, mid);
      look.set(0, VIEW.y, mid);
    }
    camera.lookAt(look);
    camera.updateMatrixWorld();

    const state = session.state();
    const p = bodyBase(state[HEADER.player] as number);
    const charge = state[p + BODY.aux1] as number;
    let { vy } = launchVelocity(state[p + BODY.aux0] as number, Math.max(1, charge));
    const { vz } = launchVelocity(state[p + BODY.aux0] as number, Math.max(1, charge));
    let y = THROW.launchY;
    let z = (state[p + BODY.z] as number) + THROW.launchZ;
    for (let i = 0; i < DOTS; i += 1) {
      for (let k = 0; k < DOT_EVERY; k += 1) {
        vy -= GRAVITY;
        y += vy;
        z += vz;
      }
      const dot = dots.current[i];
      if (dot === null || dot === undefined) continue;
      // Náznak jen během nabíjení a jen nad zemí.
      dot.visible = charge > 0 && y > 0;
      dot.position.set(0, (y + THROW.ballSize / 2) / UNIT, z / UNIT);
    }
  });

  useEffect(() => {
    const element = surface.current;
    if (element === null || !enabled) return;
    let drag: { id: number; y: number } | null = null;
    const aimKeys = new Set<number>();
    let charging = false;
    let axis = 0;
    const sync = (): void => session.holdButtons([...aimKeys].reduce((mask, bit) => mask | bit, charging ? BUTTON.HOLD : 0));
    const release = (): void => {
      if (!charging) return;
      charging = false;
      sync();
      session.hold(0);
      // Úhel jde i s puštěním: rychlý tah se může vejít mezi dva tiky.
      session.press(BUTTON.TAP, axis);
      axis = 0;
    };

    const onDown = (event: PointerEvent) => {
      if (drag !== null) return;
      drag = { id: event.pointerId, y: event.clientY };
      charging = true;
      sync();
    };
    const onMove = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      axis = Math.max(AXIS_MIN, Math.min(AXIS_MAX, Math.round((event.clientY - drag.y) * AXIS_PER_PX)));
      // Osa 0 = „beze změny“: tah zpět na start nechá poslední úhel.
      session.hold(axis);
    };
    const onUp = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      release();
    };

    const aimOf = (key: string): number => (key === 'arrowup' || key === 'w' ? BUTTON.UP : key === 'arrowdown' || key === 's' ? BUTTON.DOWN : 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const aim = aimOf(key);
      if (aim !== 0) {
        event.preventDefault();
        aimKeys.add(aim);
        sync();
      } else if (key === ' ' && !event.repeat) {
        event.preventDefault();
        charging = true;
        sync();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const aim = aimOf(key);
      if (aim !== 0) {
        aimKeys.delete(aim);
        sync();
      } else if (key === ' ') release();
    };
    const onBlur = (): void => {
      // Ztracené okno nehází: nabíjení se zahodí bez puštění.
      aimKeys.clear();
      charging = false;
      drag = null;
      sync();
      session.hold(0);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [session, surface, enabled]);

  // Náznak dráhy je pomůcka: mlha rigu ho nezakryje a stín nevrhá (P32A T10).
  return (
    <>
      {Array.from({ length: DOTS }, (_, i) => (
        <mesh key={i} ref={(mesh) => { dots.current[i] = mesh; }} visible={false} userData={{ rigShadow: 'none' }}>
          <sphereGeometry args={[0.09, 8, 6]} />
          <meshBasicMaterial color="#f8fafc" transparent opacity={0.9 - i * 0.05} fog={false} />
        </mesh>
      ))}
      {/* Slot ducha (P37-0 T3). */}
      <GhostSlot ghost={ghost} session={session} />
      {/* Hod vidět (P43 T5): záblesk u ruky a stopa míčku. */}
      <ShootThrowFx session={session} verb="throw" />
    </>
  );
}
