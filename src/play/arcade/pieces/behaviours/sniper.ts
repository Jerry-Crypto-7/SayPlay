/**
 * Ostřelovač (P45C): stojí v odstupu, zamkne směr na hráče, po varování
 * vystřelí pomalý výstřel po zamčené přímce.
 *
 * `plane`: drží se 10 m od hráče (varuje do 12 m), zamkne místo, kde hráč
 * stojí, a po 48 tikách varování pustí výstřel pomaleji, než hráč běží – kdo
 * z přímky vystoupí, tomu výstřel proletí kolem. `track`: jede 8–12 m před
 * hráčem v jeho pruhu a střílí dozadu po pruhu; uhnout = změnit pruh.
 * Výstřel je vlastní předloha (`shot`); zásah i úklid dělá pravidlo `pacing`.
 */

import { type ArcadeEffect, type ArcadeInput, type BodyInit, UNIT } from '../../contract';
import { ARENA, DIRECTIONS, arenaAxis, directionOfAxis } from '../arena';
import { RUNNER } from '../runner';
import { clampTo, headTo, inside, laneOf, length, read, set, toward } from './flanker';
import type { Behaviour, BehaviourRef, BehaviourSpace, BehaviourView } from './index';

export const SNIPER = {
  plane: {
    /** Kam se staví a odkud už varuje. */
    stand: 10 * UNIT, reach: 12 * UNIT,
    /** Přesun × intenzita, v mezích; hráč (150) mu vždy uteče. */
    speed: 90, minSpeed: 60, maxSpeed: 120,
    /** Výstřel letí pomaleji než hráč (150). */
    shot: 120,
    /**
     * Robot: blíž přímce než zásahový dosah napříč šikmou přímkou (polovina
     * šířek hráče a výstřelu × √2) + `margin` vystoupí, o `hold` dál stojí,
     * dokud výstřel nepřeletí – proletí kolem do 1,5 m. Hráč v aréně roste,
     * proto dosah z jeho šířky. `brake` = tiky brzdné dráhy v předpovědi.
     */
    margin: 200, hold: 600, brake: 3,
  },
  track: {
    /** Odstup před hráčem, kam se staví, a pásmo, odkud varuje. */
    stand: 10 * UNIT, near: 8 * UNIT, far: 12 * UNIT,
    /** Dorovnání odstupu za tik. */
    catchUp: 60,
    /** Do pruhu hráče přejede až tolik před ním, ne skrz něj. */
    clear: 2 * UNIT,
    /** Výstřel letí proti hráči pomaleji, než hráč běží. */
    shot: 40,
  },
  /** Spodní hrana výstřelu nad zemí: zasáhne běžícího i skrčeného hráče. */
  shotY: 500,
} as const;

export const SHOT: BodyInit = { role: 'hazard', kind: 'sniper_shot', x: 0, y: SNIPER.shotY, z: 0, w: 400, h: 400, d: 400, solid: false };

/** Výstřel je ve vzduchu celý `act` – ostřelovač zatím stojí a přímka platí. */
const TICKS = { plane: { telegraph: 48, act: 120, recover: 60 }, track: { telegraph: 48, act: 90, recover: 60 } } as const;

/** Rychlost výstřelu po zamčené přímce: v rovině od ostřelovače k zamčenému cíli, na trati dozadu po pruhu. */
function shotVelocity(view: BehaviourView): { readonly vx: number; readonly vz: number } {
  if (view.space === 'track') return { vx: 0, vz: -SNIPER.track.shot };
  const dx = view.aim.x - read(view.state, view.body, 'x');
  const dz = view.aim.z - read(view.state, view.body, 'z');
  const gap = length(dx, dz);
  const speed = SNIPER.plane.shot;
  return gap === 0 ? { vx: 0, vz: speed } : { vx: Math.trunc((dx * speed) / gap), vz: Math.trunc((dz * speed) / gap) };
}

/** Tiky od výstřelu (výstřel vznikne v prvním tiku `act`); před ním 0. */
function flown(view: BehaviourView, space: BehaviourSpace): number {
  const ticks = TICKS[space];
  if (view.phase === 'act') return ticks.act - view.ticksLeft;
  return view.phase === 'recover' ? ticks.act + ticks.recover - view.ticksLeft : 0;
}

/** Výstřel po zamčené přímce jako `spawn` předlohy `ref.shot` (sdílí salva bosse). */
export function fireShot(view: BehaviourView, ref: BehaviourRef): readonly ArcadeEffect[] {
  if (ref.shot === undefined) return [];
  const { vx, vz } = shotVelocity(view);
  const x = view.space === 'track' ? view.aim.x : read(view.state, view.body, 'x');
  return [{ kind: 'spawn', template: ref.shot, x, y: SNIPER.shotY, z: read(view.state, view.body, 'z'), vx, vy: 0, vz }];
}

/**
 * Robot v rovině: kde hráč je teď (zpožděný pohled + stisky `recent`, které
 * ve stavu ještě nejsou, pohybem `move_free`) a kam ho donese brzdná dráha,
 * vůči dráze výstřelu, který letí `k` tiků (i se stisky `recent`) – v pásmu
 * `clear` vystoupit kolmo na svou stranu, do `hold` stát, dokud výstřel nepřeletí.
 */
export function dodgeShot(view: BehaviourView, input: ArcadeInput, recent: readonly ArcadeInput[], k: number): ArcadeInput {
  const { state, body, player } = view;
  let px = read(state, player, 'x');
  let pz = read(state, player, 'z');
  let pvx = read(state, player, 'vx');
  let pvz = read(state, player, 'vz');
  for (const pressed of recent) {
    const direction = directionOfAxis(pressed.axis);
    const dir = direction < 0 ? null : DIRECTIONS[direction];
    const rate = dir === undefined || dir === null ? ARENA.friction : ARENA.accel;
    pvx += clampTo((dir ? Math.trunc((dir.dx * ARENA.speed) / 1000) : 0) - pvx, rate);
    pvz += clampTo((dir ? Math.trunc((dir.dz * ARENA.speed) / 1000) : 0) - pvz, rate);
    px += pvx;
    pz += pvz;
  }
  const { vx, vz } = shotVelocity(view);
  const speed = Math.max(1, length(vx, vz));
  const { brake, margin } = SNIPER.plane;
  const clear = Math.floor(((read(state, player, 'w') + SHOT.w) * 707) / 1000) + margin;
  const hold = clear + SNIPER.plane.hold;
  const rx = px + pvx * brake - (read(state, body, 'x') + vx * k);
  const rz = pz + pvz * brake - (read(state, body, 'z') + vz * k);
  // Výstřel už hráče minul.
  if (rx * vx + rz * vz < -clear * speed) return input;
  const side = vx * rz - vz * rx;
  const gap = Math.abs(side) / speed;
  if (gap >= hold) return input;
  if (gap >= clear) return { buttons: input.buttons, axis: 0 };
  const flip = side < 0 ? -1 : 1;
  return { buttons: input.buttons, axis: arenaAxis(-vz * flip, vx * flip) };
}

export const sniper: Behaviour = {
  id: 'sniper',
  telegraph: { plane: 'line', track: 'line' },
  ticks: TICKS,
  body: { role: 'hazard', kind: 'sniper', x: 0, y: 0, z: 0, w: 900, h: 1700, d: 900, solid: false },
  shot: SHOT,

  ready(view) {
    const { state, body, player } = view;
    if (view.space === 'plane') return length(read(state, body, 'x') - read(state, player, 'x'), read(state, body, 'z') - read(state, player, 'z')) <= SNIPER.plane.reach;
    const ahead = read(state, body, 'z') - read(state, player, 'z');
    return ahead >= SNIPER.track.near && ahead <= SNIPER.track.far && read(state, body, 'x') === laneOf(read(state, player, 'x')) * RUNNER.laneWidth;
  },

  aim(view) {
    const { state, body, player } = view;
    // Rovina: kde hráč stojí teď – zamčeno, výstřel ho nesleduje. Trať: pruh hráče.
    if (view.space === 'plane') return { x: read(state, player, 'x'), z: read(state, player, 'z') };
    return { x: laneOf(read(state, player, 'x')) * RUNNER.laneWidth, z: read(state, body, 'z') };
  },

  done: () => false,

  move(view) {
    const { state, body, player, phase } = view;
    if (view.space === 'plane') {
      if (phase !== 'idle') {
        set(state, body, 0, 0);
        return;
      }
      // Bod `stand` od hráče na straně, kde ostřelovač je.
      const px = read(state, player, 'x');
      const pz = read(state, player, 'z');
      const rx = read(state, body, 'x') - px;
      const rz = read(state, body, 'z') - pz;
      const gap = Math.max(1, length(rx, rz));
      const point = inside(view, px + Math.trunc((rx * SNIPER.plane.stand) / gap), pz + Math.trunc((rz * SNIPER.plane.stand) / gap));
      const plane = SNIPER.plane;
      headTo(view, point.x, point.z, Math.max(plane.minSpeed, Math.min(plane.maxSpeed, Math.floor((plane.speed * view.intensity) / 1000))));
      return;
    }
    const pvz = read(state, player, 'vz');
    if (phase !== 'idle') {
      set(state, body, 0, pvz);
      return;
    }
    const z = read(state, body, 'z');
    const pz = read(state, player, 'z');
    const lane = z >= pz + SNIPER.track.clear ? toward(read(state, body, 'x'), laneOf(read(state, player, 'x')) * RUNNER.laneWidth, RUNNER.laneSpeed) : 0;
    set(state, body, lane, pvz + clampTo(pz + SNIPER.track.stand - z, SNIPER.track.catchUp));
  },

  effects(view, ref): readonly ArcadeEffect[] {
    return view.phase === 'act' && view.ticksLeft === TICKS[view.space].act ? fireShot(view, ref) : [];
  },

  // Trať: uhýbá plánovač pruhů běžce (výstřel ve vzduchu sám, ten, který teprve vyletí, `hazard`).
  botStep(view, input, _control, recent) {
    // Výstřel je o `recent` tiků dál; během varování vyletí až po jeho konci.
    if (view.space !== 'plane' || view.phase === 'idle') return input;
    return dodgeShot(view, input, recent, view.phase === 'telegraph' ? Math.max(0, recent.length - view.ticksLeft) : flown(view, 'plane') + recent.length);
  },

  hazard(view) {
    // Výstřel vznikne v kroku, kdy varování přejde do výpadu, v pruhu zamčeném na začátku varování, a letí dozadu.
    if (view.space !== 'track' || view.phase !== 'telegraph') return null;
    const { state, body, player, ticksLeft } = view;
    const fired = read(state, body, 'z') + read(state, player, 'vz') * ticksLeft;
    const x = view.aim.x;
    return (ticks) => (ticks < ticksLeft ? null : { x, y: SHOT.y, z: fired - SNIPER.track.shot * (ticks - ticksLeft), w: SHOT.w, h: SHOT.h, d: SHOT.d });
  },
};
