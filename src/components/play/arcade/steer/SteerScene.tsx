'use client';

/**
 * Scéna závodu (P25F T6): kamera za vozidlem a nad ním, asfalt po úsecích
 * trati mezi mantinely, tráva okolo. Vstup: šipky/A-D a tah prstem do strany
 * drží osu (zatáčení), šipka dolů/S nebo druhý prst drží brzdu.
 *
 * Kreslí se s `x` jádra zrcadleným (jako běžec): kamera kouká po +z, takže
 * +x jádra by jinak vyšlo vlevo a „vpravo“ by točilo doleva.
 */

import { useEffect } from 'react';
import type { PerspectiveCamera, Vector3 } from 'three';

import { AXIS_MAX, BUTTON, UNIT } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import type { SteerCourse } from '@/play/arcade/pieces/steer';

import { isTyping } from '../input';
import { UNDER_PANORAMA } from '../look/under-panorama';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';

/**
 * Kamera za autem: dojíždí za ním do strany, kouká kus před něj. Na výšku
 * (mobil) je nízká kamera tak úzká, že soupeř nebo turbo vedle auta (~6 m
 * do strany) leží mimo obraz – stoupne a ustoupí do strmého pohledu shora,
 * auto zůstává přes 24 px (P27A T6, `e2e/play-frame`).
 */
export function placeChase(camera: PerspectiveCamera, look: Vector3, x: number, z: number): void {
  if (camera.aspect < 1) {
    camera.position.set(x * 0.8, 18, z - 18);
    look.set(x * 0.6, 0, z + 8);
  } else {
    camera.position.set(x * 0.8, 4.2, z - 8.5);
    look.set(x * 0.6, 0.8, z + 12);
  }
  camera.lookAt(look);
}

/** Jak daleko za okrajem dráhy stojí první řada kulis (m) – mimo mantinely, na tělesa jádra nedosáhne. */
const SCENERY_MARGIN = 2.5;

/**
 * Asfalt úsek po úseku (střed a šířka z osy trati) + bílé okraje, zem a
 * kulisy sady prostředí (P27A T3) podél každého úseku. Kulisy jsou jen vzhled:
 * jádro o nich neví, hash světa se nehne.
 */
export function SteerBackdrop({ course, length, look }: { readonly course: SteerCourse | undefined; readonly length: number; readonly look: Look }) {
  const span = length + 80;
  const half = (course?.halfWidth ?? 5 * UNIT) / UNIT;
  const segments = (course?.ends ?? []).map((end, i) => {
    const near = i === 0 ? -20 * UNIT : (course!.ends[i - 1] as number);
    return { near: near / UNIT, far: end / UNIT, center: -(course!.centers[i] as number) / UNIT };
  });
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, span / 2 - 30]} renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[160, span + 60]} />
        <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
      </mesh>
      {segments.map((segment, i) => (
        <group key={i} position={[segment.center, 0, (segment.near + segment.far) / 2]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
            <planeGeometry args={[half * 2, segment.far - segment.near + 0.05]} />
            <meshStandardMaterial color={look.track} roughness={0.9} />
          </mesh>
          <Scenery look={look} layout="sides" inner={half + SCENERY_MARGIN} from={-(segment.far - segment.near) / 2} to={(segment.far - segment.near) / 2 - 2} />
          {[-1, 1].map((side) => (
            <mesh key={side} rotation={[-Math.PI / 2, 0, 0]} position={[side * (half - 0.15), 0, 0]}>
              <planeGeometry args={[0.12, segment.far - segment.near]} />
              <meshBasicMaterial color="#e2e8f0" />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

const BRAKE_KEYS = new Set(['arrowdown', 's']);

/**
 * Šipky/A-D = zatáčení (osa), šipka dolů/S = brzda. Dotyk: první prst táhne
 * do strany (osa podle vzdálenosti od místa stisku, plná po `DRAG_PX`),
 * druhý prst kdekoli brzdí. Brzda je držené tlačítko relace – padne do
 * každého tiku, ať snímků za sekundu je kolik chce (P28B T5).
 */
const DRAG_PX = 90;

export function useSteerInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const keys = new Set<'left' | 'right' | 'brake'>();
    const pointers = new Map<number, { readonly x: number; axis: number }>();
    const sync = (): void => {
      const drag = [...pointers.values()][0]?.axis ?? 0;
      const key = ((keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0)) * AXIS_MAX;
      session.hold(key !== 0 ? key : drag);
      session.holdButtons(keys.has('brake') || pointers.size > 1 ? BUTTON.DOWN : 0);
    };
    const keyOf = (key: string): 'left' | 'right' | 'brake' | null =>
      key === 'arrowleft' || key === 'a' ? 'left' : key === 'arrowright' || key === 'd' ? 'right' : BRAKE_KEYS.has(key) ? 'brake' : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const key = keyOf(event.key.toLowerCase());
      if (key === null) return;
      event.preventDefault();
      keys.add(key);
      sync();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyOf(event.key.toLowerCase());
      if (key === null) return;
      keys.delete(key);
      sync();
    };
    const onDown = (event: PointerEvent) => {
      // Tah, který vyjede z plátna, se musí pustit i venku – jinak řízení zůstane vytočené.
      element.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, axis: 0 });
      sync();
    };
    const onMove = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      if (pointer === undefined) return;
      pointer.axis = Math.round(Math.max(-1, Math.min(1, (event.clientX - pointer.x) / DRAG_PX)) * AXIS_MAX);
      sync();
    };
    const onUp = (event: PointerEvent) => {
      if (pointers.delete(event.pointerId)) sync();
    };
    const release = (): void => {
      keys.clear();
      pointers.clear();
      sync();
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
  }, [session, target, active]);
}
