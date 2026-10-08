'use client';

/**
 * Sebrání a doručení vidět (P43 T6): sebraná věc se před zmizením přitáhne
 * k hrdinovi, doručená věc letí obloukem nad hlavou hrdiny do cíle.
 *
 * Montuje ji `effects/Effects.tsx`, takže ji má každá scéna. Události se čtou
 * ze stavu (zmizelá sběratelná věc, cíl v jiném stavu) – ukázka robota, kterou
 * nahrává klip porotce, posluchače událostí nevolá. Životnost v ticích
 * simulace; do relace ani hashe nic nepíše.
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Mesh } from 'three';

import { colorHex } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, targetStateOf } from '@/play/arcade/contract';

import type { VisualEvent } from '../effects/bus';
import type { ArcadeSession } from '../session';
import { type ActionCue, cuesOf } from './cues';

/** Jak dlouho věc letí k hrdinovi nebo do cíle: 18 tiků = 0,3 s. */
export const CUE_TICKS = 18;
const SLOTS = 4;
/** Výška oblouku nad hlavou hrdiny (m). */
const ARC = 0.8;

type Point = readonly [x: number, y: number, z: number];
export interface HeroCueFrame {
  readonly pulls: readonly { readonly at: Point; readonly scale: number }[];
  readonly carries: readonly { readonly at: Point }[];
}
export interface CueMemory {
  /** Sběratelné věci živé při posledním pohledu, s polohou. */
  readonly alive: Map<number, VisualEvent>;
  readonly states: Map<number, number>;
}

const aliveIn = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const metres = (state: Int32Array, body: number, axis: number): number => (state[bodyBase(body) + axis] as number) / UNIT;

/** Sebrání (`pickup`) a změny cíle (`stateChange`) od minulého pohledu; `memory` se tím posune. */
export function stateCues(state: Int32Array, memory: CueMemory): VisualEvent[] {
  const tick = state[HEADER.tick] as number;
  const events: VisualEvent[] = [];
  const first = memory.alive.size === 0 && memory.states.size === 0;
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const role = state[bodyBase(body) + BODY.role] as number;
    const at = { body, role, x: metres(state, body, BODY.x), y: metres(state, body, BODY.y), z: metres(state, body, BODY.z), tick };
    if (role === ROLE.collectible) {
      if (aliveIn(state, body)) memory.alive.set(body, { kind: 'pickup', ...at });
      else if (memory.alive.has(body)) {
        events.push({ ...memory.alive.get(body)!, tick });
        memory.alive.delete(body);
      }
    } else if (role === ROLE.target || role === ROLE.goal) {
      const now = targetStateOf(state, body);
      if (!first && memory.states.has(body) && memory.states.get(body) !== now) events.push({ kind: 'stateChange', ...at, state: now });
      memory.states.set(body, now);
    }
  }
  return events;
}

/** Co nakreslit v tiku stavu (x zrcadlí scéna jako u těl). */
export function heroCueFrame(cues: readonly ActionCue[], state: Int32Array): HeroCueFrame {
  const tick = state[HEADER.tick] as number;
  const player = state[HEADER.player] as number;
  const hero: Point = [-metres(state, player, BODY.x), metres(state, player, BODY.y), metres(state, player, BODY.z)];
  const head = metres(state, player, BODY.h);
  const pulls: { at: Point; scale: number }[] = [];
  const carries: { at: Point }[] = [];
  for (const cue of cues) {
    const age = tick - cue.at;
    if (age < 0 || age >= CUE_TICKS) continue;
    const u = age / CUE_TICKS;
    const spot: Point = [-cue.x, cue.y, cue.z];
    if (cue.verb === 'collect' || cue.verb === 'catch') {
      // Ke hrdinovi do prsou, s doběhem (ease-in): věc se „vcucne“.
      const k = u * u;
      pulls.push({ at: [spot[0] + (hero[0] - spot[0]) * k, spot[1] + 0.5 + (hero[1] + head * 0.6 - spot[1] - 0.5) * k, spot[2] + (hero[2] - spot[2]) * k], scale: 1 - 0.7 * u });
    } else if (cue.verb === 'deliver' || cue.verb === 'interact') {
      // Z hlavy hrdiny obloukem do cíle.
      const top = hero[1] + head + 0.4;
      carries.push({ at: [hero[0] + (spot[0] - hero[0]) * u, top + (spot[1] + 0.5 - top) * u + ARC * Math.sin(Math.PI * u), hero[2] + (spot[2] - hero[2]) * u] });
    }
  }
  return { pulls, carries };
}

export function HeroCueFx({ session }: { readonly session: Pick<ArcadeSession, 'state'> }) {
  const memory = useMemo<CueMemory>(() => ({ alive: new Map(), states: new Map() }), []);
  const cues = useRef<ActionCue[]>([]);
  const last = useRef(-1);
  const pulls = useRef<(Mesh | null)[]>([]);
  const carries = useRef<(Mesh | null)[]>([]);

  useFrame(() => {
    const state = session.state();
    const tick = state[HEADER.tick] as number;
    // Tik zpět = nový běh: paměť i rozletěné věci patří starému.
    if (tick < last.current) {
      memory.alive.clear();
      memory.states.clear();
      cues.current = [];
    }
    last.current = tick;
    const fresh = cuesOf(['collect', 'deliver'], stateCues(state, memory), state[HEADER.player] as number);
    cues.current = [...cues.current.filter((cue) => tick - cue.at < CUE_TICKS), ...fresh];
    const frame = heroCueFrame(cues.current, state);
    pulls.current.forEach((mesh, index) => {
      if (mesh === null) return;
      const pull = frame.pulls[index];
      mesh.visible = pull !== undefined;
      if (pull === undefined) return;
      mesh.position.set(...pull.at);
      mesh.scale.setScalar(0.35 * pull.scale);
    });
    carries.current.forEach((mesh, index) => {
      if (mesh === null) return;
      const carry = frame.carries[index];
      mesh.visible = carry !== undefined;
      if (carry !== undefined) mesh.position.set(...carry.at);
    });
  });

  return (
    <>
      {Array.from({ length: SLOTS }, (_, index) => (
        <mesh key={`pull-${index}`} ref={(mesh) => { pulls.current[index] = mesh; }} visible={false} userData={{ rigShadow: 'none', actionCue: 'collect' }}>
          <sphereGeometry args={[1, 12, 8]} />
          <meshBasicMaterial color={colorHex.sun} fog={false} />
        </mesh>
      ))}
      {Array.from({ length: SLOTS }, (_, index) => (
        <mesh key={`carry-${index}`} ref={(mesh) => { carries.current[index] = mesh; }} visible={false} userData={{ rigShadow: 'none', actionCue: 'deliver' }}>
          <boxGeometry args={[0.45, 0.45, 0.45]} />
          <meshBasicMaterial color={colorHex.tomato} fog={false} />
        </mesh>
      ))}
    </>
  );
}
