/**
 * Robot střelce (P25G, T3). Svět vidí 8 tiků starý; stav zbraně a míření
 * „teď“ si dopočítá z vlastních stisků od té doby (ví, kdy zmáčkl spoušť).
 * Míří na nejbližší terč nebo nepřítele s předsazením: polohu cíle v čase
 * zásahu spočítá stejně jako jádro (přímka, kyvadlo). Cíl, na který už
 * letí jeho střela, vynechá – jinak by na terč, jehož zásah ještě nevidí,
 * pálil znovu a znovu.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { type GunParams, type GunState, SHOOTER, aimAt, aimVelocity, gunOf, gunTick } from './shooter';

const S = BODY;

interface Foe {
  readonly index: number;
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
  /** Kyvadlo: uběhlé tiky úseku a délka úseku (0 = rovně). */
  readonly leg: number;
  readonly period: number;
  readonly w: number;
}

/** Poloha cíle za `n` tiků – stejná integrace jako v jádře (posun, pak otočka kyvadla). */
function foeAt(foe: Foe, n: number): { x: number; z: number } {
  if (foe.period === 0) return { x: foe.x + foe.vx * n, z: foe.z + foe.vz * n };
  let { x, z, vx, vz, leg } = foe;
  for (let i = 0; i < n; i += 1) {
    x += vx;
    z += vz;
    leg += 1;
    if (leg >= foe.period) {
      leg = 0;
      vx = -vx;
      vz = -vz;
    }
  }
  return { x, z };
}

function foesOf(state: Int32Array): Foe[] {
  const foes: Foe[] = [];
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    const b = bodyBase(i);
    const role = state[b + S.role];
    if (((state[b + S.flags] as number) & FLAG.alive) === 0 || (role !== ROLE.target && role !== ROLE.enemy)) continue;
    const kinematic = ((state[b + S.flags] as number) & FLAG.kinematic) !== 0;
    foes.push({
      index: i,
      x: state[b + S.x] as number,
      z: state[b + S.z] as number,
      vx: state[b + S.vx] as number,
      vz: state[b + S.vz] as number,
      leg: kinematic ? (state[b + S.aux0] as number) : 0,
      period: kinematic ? (state[b + S.aux1] as number) : 0,
      w: state[b + S.w] as number,
    });
  }
  return foes;
}

/** Střela: poloha v tiku `at` (vůči pozorovanému stavu) a rychlost. */
interface Shot {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
  readonly at: number;
}

/** Který cíl střela trefí jako první (index do `foes`), nebo −1. */
function struckBy(shot: Shot, foes: readonly Foe[]): number {
  let best = -1;
  let bestT = Number.POSITIVE_INFINITY;
  foes.forEach((foe, index) => {
    // Dva kroky: čas, kdy střela dojde do hloubky cíle, pak znovu pro jeho novou polohu.
    let t = 0;
    for (let k = 0; k < 2; k += 1) {
      const at = foeAt(foe, Math.max(0, shot.at + t));
      t = Math.max(0, Math.round((at.z - shot.z) / Math.max(1, shot.vz)));
    }
    const at = foeAt(foe, Math.max(0, shot.at + t));
    if (Math.abs(shot.x + shot.vx * t - at.x) * 2 < foe.w + SHOOTER.bulletSize && t < bestT) {
      best = index;
      bestT = t;
    }
  });
  return best;
}

/** Zásobník a přebití zbraně světa (stejné jako v pravidle `gun`) – robot podle nich ví, kdy vystřelí. */
const botParams = z.object({ magazine: z.int().min(1).max(50), reloadTicks: z.int().min(1).max(600) }).strict();

export const shooterBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'shooter_bot',
  params: botParams,
  roles: ['player', 'target', 'enemy', 'projectile'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }, params): ArcadeInput => {
    const p = bodyBase(player);
    const gunParams: GunParams = { template: 1, ...params };
    const foes = foesOf(state);
    if (foes.length === 0) return NO_INPUT;

    // Zbraň a míření „teď“ + střely vystřelené od pozorovaného stavu.
    const shots: Shot[] = [];
    let gun: GunState = gunOf(state);
    let aim = state[p + S.aux0] as number;
    const muzzleZ = (state[p + S.z] as number) + SHOOTER.playerD / 2;
    recent.forEach((input, i) => {
      if (input.axis !== 0) aim = input.axis;
      const next = gunTick(gun, (input.buttons & BUTTON.TAP) !== 0, gunParams);
      // Výstřel v tiku i: spawn na konci tiku, první posun v tiku i + 1.
      if (next.fired) shots.push({ x: state[p + S.x] as number, z: muzzleZ, ...aimVelocity(aim), at: i + 1 });
      gun = next.next;
    });
    const count = state[HEADER.bodyCount] as number;
    for (let i = 0; i < count; i += 1) {
      const b = bodyBase(i);
      if (state[b + S.role] !== ROLE.projectile || ((state[b + S.flags] as number) & FLAG.alive) === 0) continue;
      shots.push({ x: state[b + S.x] as number, z: state[b + S.z] as number, vx: state[b + S.vx] as number, vz: state[b + S.vz] as number, at: 0 });
    }
    const claimed = new Set(shots.map((shot) => struckBy(shot, foes)));

    const now = recent.length;
    let best: { x: number; z: number; distance: number } | null = null;
    foes.forEach((foe, index) => {
      if (claimed.has(index)) return;
      // Předsazení: čas letu k poloze cíle v okamžiku zásahu, dvakrát zpřesněný.
      let flight = 0;
      let at = foeAt(foe, now);
      for (let k = 0; k < 3; k += 1) {
        at = foeAt(foe, now + 1 + flight);
        flight = Math.ceil(Math.max(0, Math.hypot(at.x, at.z - muzzleZ) - SHOOTER.bulletSize) / SHOOTER.bulletSpeed);
      }
      const distance = Math.hypot(at.x, at.z);
      if (distance + SHOOTER.targetW > SHOOTER.range || at.z <= muzzleZ || Math.abs(at.x) > SHOOTER.tanMax * at.z) return;
      if (best === null || distance < best.distance) best = { x: at.x, z: at.z - muzzleZ, distance };
    });
    // Míří a mačká jen v tiku, kdy zbraň vystřelí: záznam zůstane řídký.
    if (best === null || !gunTick(gun, true, gunParams).fired) return NO_INPUT;
    const target: { x: number; z: number } = best;
    return { buttons: BUTTON.TAP, axis: aimAt(target.x, target.z) };
  },
};
