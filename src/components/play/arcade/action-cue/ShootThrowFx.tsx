'use client';

/**
 * Střelba a hod vidět (P43 T5): záblesk u hrdiny v tiku, kdy jádro vypustilo
 * střelu nebo míček, a světlá stopa za každou letící střelou.
 *
 * Vypuštění se pozná ze stavu (nové živé tělo `ROLE.projectile`), ne ze
 * sběrnice: ukázka robota posluchače událostí nevolá a klip, který soudí
 * porotce, hraje právě robot. Životnost záblesku je v ticích simulace, takže
 * ho vidí i ručně krokovaný klip. Jen obraz – do relace ani hashe nic nepíše.
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Mesh } from 'three';

import { colorHex } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';

import type { VisualEvent } from '../effects/bus';
import type { ArcadeSession } from '../session';
import { type ActionCue, cuesOf } from './cues';

/** Jak dlouho svítí záblesk: 9 tiků = 0,15 s. */
export const FLASH_TICKS = 9;
/** Délka stopy: kudy střela letěla posledních 6 tiků. */
const TRAIL_TICKS = 6;
const FLASHES = 4;
const TRAILS = 8;

type Point = readonly [x: number, y: number, z: number];
export interface ShootThrowFrame {
  readonly flashes: readonly { readonly at: Point; readonly life: number }[];
  readonly trails: readonly { readonly from: Point; readonly to: Point }[];
}

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Ústí: záblesk kousek před hrdinou po směru střely, ať ho nezakryje (kamera střelce stojí za zády). */
export const MUZZLE = 0.6;
/** Největší poloměr záblesku v metrech – hrdina je kolem 1 m, větší koule ho schová. */
export const FLASH_RADIUS = 0.45;

/**
 * Střely, které od minula nově žijí, jako události `spawn` v tiku a na místě vypuštění;
 * `known` si drží živé střely mezi snímky. Klip robota se krokuje po 30 ticích, takže
 * střelu poprvé uvidí v půli letu: stáří se dopočte ze vzdálenosti od hrdiny a rychlosti,
 * a střela starší než záblesk vypuštěním není (jinak by záblesk visel ve vzduchu).
 */
export function projectileSpawns(state: Int32Array, known: Set<number>): VisualEvent[] {
  const events: VisualEvent[] = [];
  const tick = state[HEADER.tick] as number;
  const hero = bodyBase(state[HEADER.player] as number);
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] !== ROLE.projectile || !alive(state, body)) {
      known.delete(body);
      continue;
    }
    if (known.has(body)) continue;
    known.add(body);
    const at = (axis: number) => (state[base + axis] as number) / UNIT;
    const v = [at(BODY.vx), at(BODY.vy), at(BODY.vz)] as const;
    const speed = Math.hypot(...v);
    const flown = Math.hypot(at(BODY.x) - (state[hero + BODY.x] as number) / UNIT, at(BODY.y) - (state[hero + BODY.y] as number) / UNIT, at(BODY.z) - (state[hero + BODY.z] as number) / UNIT);
    const age = speed > 0 ? Math.round(flown / speed) : 0;
    if (age >= FLASH_TICKS) continue;
    // Místo vypuštění (poloha minus let) posunuté o ústí po směru střely.
    const step = speed > 0 ? MUZZLE / speed - age : 0;
    events.push({ kind: 'spawn', body, role: ROLE.projectile, x: at(BODY.x) + v[0] * step, y: at(BODY.y) + v[1] * step, z: at(BODY.z) + v[2] * step, tick: tick - age });
  }
  return events;
}

/** Co nakreslit v tiku stavu: záblesky z čerstvých podnětů, stopy za živými střelami (x zrcadlí scéna). */
export function shootThrowFrame(cues: readonly ActionCue[], state: Int32Array): ShootThrowFrame {
  const tick = state[HEADER.tick] as number;
  const flashes = cues
    .filter((cue) => cue.target !== undefined && tick - cue.at >= 0 && tick - cue.at < FLASH_TICKS)
    .map((cue) => ({ at: [-cue.x, cue.y, cue.z] as Point, life: 1 - (tick - cue.at) / FLASH_TICKS }));
  const trails: { from: Point; to: Point }[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] !== ROLE.projectile || !alive(state, body)) continue;
    const at = (axis: number) => (state[base + axis] as number) / UNIT;
    const y = at(BODY.y) + at(BODY.h) / 2;
    const to: Point = [-at(BODY.x), y, at(BODY.z)];
    trails.push({ from: [to[0] + at(BODY.vx) * TRAIL_TICKS, y - at(BODY.vy) * TRAIL_TICKS, to[2] - at(BODY.vz) * TRAIL_TICKS], to });
  }
  return { flashes, trails };
}

export function ShootThrowFx({ session, verb }: { readonly session: Pick<ArcadeSession, 'state'>; readonly verb: 'shoot' | 'throw' }) {
  const known = useMemo(() => new Set<number>(), []);
  const cues = useRef<ActionCue[]>([]);
  const last = useRef(-1);
  const flashes = useRef<(Mesh | null)[]>([]);
  const trails = useRef<(Mesh | null)[]>([]);

  useFrame(() => {
    const state = session.state();
    const tick = state[HEADER.tick] as number;
    // Tik zpět = nový běh: staré střely ani záblesky do něj nepatří.
    if (tick < last.current) {
      known.clear();
      cues.current = [];
    }
    last.current = tick;
    const fresh = cuesOf([verb], projectileSpawns(state, known), state[HEADER.player] as number);
    cues.current = [...cues.current.filter((cue) => tick - cue.at < FLASH_TICKS), ...fresh];
    const frame = shootThrowFrame(cues.current, state);
    flashes.current.forEach((mesh, index) => {
      if (mesh === null) return;
      const flash = frame.flashes[index];
      mesh.visible = flash !== undefined;
      if (flash === undefined) return;
      mesh.position.set(flash.at[0], flash.at[1], flash.at[2]);
      mesh.scale.setScalar(FLASH_RADIUS * (0.4 + 0.6 * flash.life));
    });
    trails.current.forEach((mesh, index) => {
      if (mesh === null) return;
      const trail = frame.trails[index];
      mesh.visible = trail !== undefined;
      if (trail === undefined) return;
      const length = Math.hypot(trail.to[0] - trail.from[0], trail.to[1] - trail.from[1], trail.to[2] - trail.from[2]);
      mesh.position.set((trail.from[0] + trail.to[0]) / 2, (trail.from[1] + trail.to[1]) / 2, (trail.from[2] + trail.to[2]) / 2);
      mesh.lookAt(trail.to[0], trail.to[1], trail.to[2]);
      mesh.scale.set(1, 1, Math.max(0.01, length));
    });
  });

  // Pomůcka obrazu jako náznak dráhy hodu: mlha ji nezakryje a stín nevrhá.
  return (
    <>
      {Array.from({ length: FLASHES }, (_, index) => (
        <mesh key={`flash-${index}`} ref={(mesh) => { flashes.current[index] = mesh; }} visible={false} userData={{ rigShadow: 'none', actionCue: verb }}>
          <sphereGeometry args={[1, 12, 8]} />
          <meshBasicMaterial color={colorHex.sun} transparent opacity={0.9} fog={false} depthWrite={false} />
        </mesh>
      ))}
      {Array.from({ length: TRAILS }, (_, index) => (
        <mesh key={`trail-${index}`} ref={(mesh) => { trails.current[index] = mesh; }} visible={false} userData={{ rigShadow: 'none', actionCue: verb }}>
          <boxGeometry args={[0.12, 0.12, 1]} />
          <meshBasicMaterial color={colorHex['sun-soft']} transparent opacity={0.7} fog={false} depthWrite={false} />
        </mesh>
      ))}
    </>
  );
}
