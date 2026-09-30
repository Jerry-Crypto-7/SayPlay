'use client';

/**
 * Místo pro vrstvu cílů úkolu (P32E T7, naplní P32G T5). Scéna arény sem dá
 * seznam těl a vrstva (`targets`) dostane jen živá těla s rolí cíle: rozměry
 * a polohu v metrech scény (x jádra zrcadlené jako u ostatních těl, poloha ze
 * stavu po posledním tiku, bez prolnutí) a stav 0..`TARGET_STATE_MAX`.
 * Vrstva se překreslí, jen když se některý cíl pohne nebo změní stav.
 *
 * Bez stopy G kreslí pahýl jen obrys cíle: kroužek na zemi v barvě stavu.
 * Mount stojí ve scéně za podlahou a těly, obrys je neprůhledný těsně nad
 * podlahou – průhledné efekty (`effects/Effects.tsx`) se kreslí až po něm, přes něj.
 */

import { useFrame } from '@react-three/fiber';
import { type ReactNode, useState } from 'react';

import { color as brand } from '@/brand/tokens';
import { BODY, FLAG, ROLE, UNIT, bodyBase, targetStateOf } from '@/play/arcade/contract';

import type { BodyView } from '../bodies';
import type { ArcadeSession } from '../session';

/** Cíl úkolu, jak ho dostane vrstva: metry scény, `state` 0..`TARGET_STATE_MAX`. */
export interface TargetBody {
  readonly index: number;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly state: number;
}

/** Vrstva cílů (prop `targets` scény arény). */
export type TargetLayer = (targets: readonly TargetBody[]) => ReactNode;

/** Živá těla s rolí cíle ze seznamu scény, poloha a stav ze `state`. */
export function targetsOf(views: readonly BodyView[], state: Int32Array): readonly TargetBody[] {
  const targets: TargetBody[] = [];
  for (const view of views) {
    if (view.role !== ROLE.target) continue;
    const base = bodyBase(view.index);
    if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    targets.push({
      index: view.index,
      kind: view.kind,
      x: -(state[base + BODY.x] as number) / UNIT,
      y: (state[base + BODY.y] as number) / UNIT,
      z: (state[base + BODY.z] as number) / UNIT,
      w: view.w,
      h: view.h,
      d: view.d,
      state: targetStateOf(state, view.index),
    });
  }
  return targets;
}

const sameTarget = (a: TargetBody, b: TargetBody): boolean =>
  a.index === b.index && a.kind === b.kind && a.state === b.state && a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w && a.h === b.h && a.d === b.d;

/** Obrys podle stavu: čeká, rozdělaný, hotový. */
const OUTLINE = [brand.sky, brand.sun, brand['mint-deep']] as const;
const OUTLINE_M = 0.1;

/** Pahýl bez stopy G: kroužek na zemi kolem půdorysu každého cíle. */
export const targetOutlines: TargetLayer = (targets) =>
  targets.map((target) => {
    const r = Math.max(target.w, target.d) / 2;
    return (
      <mesh key={target.index} position={[target.x, 0.02, target.z]} rotation={[-Math.PI / 2, 0, 0]} userData={{ rigShadow: 'receive' }}>
        <ringGeometry args={[r, r + OUTLINE_M, 32]} />
        <meshBasicMaterial color={OUTLINE[target.state]} />
      </mesh>
    );
  });

export function TargetsMount({ session, views, layer = targetOutlines }: { readonly session: Pick<ArcadeSession, 'state'>; readonly views: readonly BodyView[]; readonly layer?: TargetLayer | undefined }) {
  const [targets, setTargets] = useState(() => targetsOf(views, session.state()));
  useFrame(() => {
    const next = targetsOf(views, session.state());
    if (next.length !== targets.length || next.some((target, i) => !sameTarget(target, targets[i]!))) setTargets(next);
  });
  return <>{layer(targets)}</>;
}
