/**
 * Hračková póza (`toyPoseOf`, P45D T4) na kreslený model (P45D T5): skupině
 * poskok, výpad, náklon, otočku a zmáčknutí, dílům otočení kolem pivotu,
 * deformaci její uniformy. Jen obraz – do stavu jádra nic nepíše. Skupina je
 * vnitřní skupina pózy (v klidu na nule, měřítko 1), díly a deformaci připraví
 * `look/load.ts` (T6).
 */

import type { Object3D } from 'three';

import { ARCADE_HZ, HEADER } from '@/play/arcade/contract';
import type { ToyPose } from '@/play/arcade/toy-motion';

import { squashPose, tiltTo } from '../characterMotion';
import { reducedMotion } from '../effects/feel';
import type { ArcadeSession } from '../session';

/** Pohyblivý díl modelu: skupina v pivotu, role z `catalog-motion.json`, strana podle x pivotu (−1, 1). */
export interface ToyPart {
  readonly pivot: Object3D;
  readonly role: string;
  readonly side: number;
}

/** Uniformy deformace vrcholů (křídla, ocas, nohy) – sdílí je klon materiálu těla a jeho obrys. */
export interface ToyDeform {
  readonly toyFlap: { value: number };
  readonly toySway: { value: number };
  readonly toyStride: { value: number };
}

export interface ToyTarget {
  readonly group: Object3D;
  readonly parts?: readonly ToyPart[];
  readonly deform?: ToyDeform;
}

/** Oslava zvedne tělo o tolik výšek na vrcholu poskoku. */
const CHEER_HOP = 0.25;
/** Úhly dílů (rad) při plné hodnotě pózy; křídla, nohy a ocas stejně i deformace (`look/toy-deform.ts`). */
const DOOR_OPEN = 0.45 * Math.PI;
const LID_OPEN = 0.4 * Math.PI;
export const WING = 0.6;
export const LEG = 0.5;
export const TAIL = 0.5;

/** Měřidlo a srovnání vypnou hračkový pohyb adresou `?toy=off` (P45D T3, T15). */
const toyOff = (): boolean => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('toy') === 'off';

/** Jediný vypínač hračkového pohybu: bez `prefers-reduced-motion` a bez `?toy=off`. */
export const toyMotionOn = (): boolean => typeof window !== 'undefined' && !toyOff() && !reducedMotion();

/**
 * Tik hračkové pózy z relace: za běhu tik s podílem, po konci běhu dál časem kresby –
 * relace po výhře netiká a oslava i pád by zamrzly v prvním snímku (P45D T22).
 */
export const toyTickOf = (session: Pick<ArcadeSession, 'state' | 'alpha' | 'endedFor'>): number =>
  (session.state()[HEADER.tick] as number) + session.alpha() + (session.endedFor() * ARCADE_HZ) / 1000;

/** Cíl poslední pózy podle skupiny – sonda záběru (`heroToy`, P45D T14) z něj čte díly a deformaci. */
const applied = new WeakMap<Object3D, ToyTarget>();
export const appliedToyOf = (group: Object3D): ToyTarget | undefined => applied.get(group);

function posePart({ pivot, role, side }: ToyPart, pose: ToyPose): void {
  pivot.rotation.set(0, 0, 0);
  if (role === 'door') pivot.rotation.y = -side * DOOR_OPEN * pose.open;
  else if (role === 'lid') pivot.rotation.x = -LID_OPEN * pose.open;
  else if (role === 'wheel') pivot.rotation.x = pose.wheel;
  else if (role === 'wing') pivot.rotation.z = side * WING * pose.flap;
  else if (role === 'leg') pivot.rotation.x = side * LEG * pose.stride;
  else if (role === 'tail' || role === 'fin') pivot.rotation.y = TAIL * (pose.sway + pose.stride);
}

/**
 * Póza na model výšky `h` (m) natočený o `heading` (rad kolem y, směr chůze ze scény);
 * natočení platí vždy, s `?toy=off` nic dalšího. Pořadí YXZ: předklon a úklon jsou
 * v těle otočeném po směru, výpad jde po jeho lokálním +z.
 */
export function applyToy(target: ToyTarget, pose: ToyPose, h: number, heading = 0): void {
  const { group } = target;
  applied.set(group, target);
  group.rotation.order = 'YXZ';
  group.rotation.y = heading;
  if (toyOff()) return;
  group.position.set(Math.sin(heading) * pose.lunge * h, (pose.hop + CHEER_HOP * pose.cheer) * h, Math.cos(heading) * pose.lunge * h);
  tiltTo(group, pose.pitch, pose.recoil, pose.wobble, pose.fall, pose.roll);
  group.rotation.y = heading + pose.yaw;
  squashPose(group, pose.squash);
  group.visible = pose.flash === 0 || Math.floor(pose.flash * 6) % 2 === 0;
  for (const part of target.parts ?? []) posePart(part, pose);
  if (target.deform !== undefined) {
    target.deform.toyFlap.value = pose.flap;
    target.deform.toySway.value = pose.sway;
    target.deform.toyStride.value = pose.stride;
  }
}
