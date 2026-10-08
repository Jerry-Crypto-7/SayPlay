/**
 * Flanker (P45C): nejde po hráči, ale vedle jeho dráhy.
 *
 * `plane`: míří na bod 3 m vedle předpovězené dráhy hráče; od 4 m se zastaví,
 * zamkne místo, kde hráč za půl vteřiny bude, a po varování k němu vyrazí
 * dvojnásobnou rychlostí hráče. `track`: předjede hráče ve vedlejším pruhu,
 * po varování přejede do jeho pruhu a zpomalí – hráč na něj najede, když
 * neuhne.
 */

import { type ArcadeInput, type ArcadeState, BODY, BUTTON, UNIT, bodyBase } from '../../contract';
import { arenaAxis } from '../arena';
import { RUNNER } from '../runner';
import type { Behaviour, BehaviourStep, BehaviourView } from './index';

type Point = { readonly x: number; readonly z: number };

export const FLANKER = {
  plane: {
    /** Přiblížení × intenzita, v mezích; hráč (150) mu vždy uteče. */
    speed: 110, minSpeed: 80, maxSpeed: 140,
    /** Odstup bodu vedle dráhy a předpověď dráhy v ticích. */
    side: 3 * UNIT, lead: 30,
    /** Od této vzdálenosti varuje. */
    reach: 4 * UNIT,
    /** Výpad: dvojnásobek rychlosti hráče. */
    dash: 300,
    /** Robot uhýbá, když je blíž čáře výpadu. */
    clearance: 2 * UNIT,
  },
  track: {
    /** Předjíždí o tolik rychleji než hráč, než je `ahead` před ním. */
    overtake: 60, ahead: 8 * UNIT,
    /** Ve výpadu jede třetinou rychlosti hráče – hráč ho dojede. */
    brake: 3,
  },
} as const;

export const read = (state: ArcadeState, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
export const set = (state: ArcadeState, body: number, vx: number, vz: number): void => {
  const base = bodyBase(body);
  state[base + BODY.vx] = vx;
  state[base + BODY.vy] = 0;
  state[base + BODY.vz] = vz;
};
/** Celočíselná délka vektoru (`Math.sqrt` je v IEEE 754 přesně zaokrouhlená). */
export const length = (dx: number, dz: number): number => Math.floor(Math.sqrt(dx * dx + dz * dz));
export const clampTo = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/** Překrývají se kvádry těl `a` a `b` (střed spodní stěny, celé rozměry)? */
export function overlaps(state: ArcadeState, a: number, b: number): boolean {
  const p = bodyBase(a);
  const q = bodyBase(b);
  const apart = (slot: 'x' | 'z', size: 'w' | 'd'): boolean => Math.abs((state[p + BODY[slot]] as number) - (state[q + BODY[slot]] as number)) * 2 >= (state[p + BODY[size]] as number) + (state[q + BODY[size]] as number);
  if (apart('x', 'w') || apart('z', 'd')) return false;
  const py = state[p + BODY.y] as number;
  const qy = state[q + BODY.y] as number;
  return py < qy + (state[q + BODY.h] as number) && qy < py + (state[p + BODY.h] as number);
}

/** Bod uvnitř plochy, když ji ovládání zná. */
export function inside(view: BehaviourStep, x: number, z: number): { x: number; z: number } {
  if (view.half === undefined) return { x, z };
  const limit = view.half - Math.ceil(read(view.state, view.body, 'w') / 2);
  return { x: clampTo(x, limit), z: clampTo(z, limit) };
}

/** Rychlost `speed` k bodu; blíž než krok = dojet přesně. */
export function headTo(view: BehaviourStep, x: number, z: number, speed: number): void {
  const dx = x - read(view.state, view.body, 'x');
  const dz = z - read(view.state, view.body, 'z');
  const gap = length(dx, dz);
  if (gap <= speed) set(view.state, view.body, dx, dz);
  else set(view.state, view.body, Math.trunc((dx * speed) / gap), Math.trunc((dz * speed) / gap));
}

/** Bod `side` vedle předpovězené dráhy hráče, na straně, kde flanker je; stojící hráč = odstup ze své strany. */
function flankPoint(view: BehaviourStep): { x: number; z: number } {
  const { state, body, player } = view;
  const { side, lead } = FLANKER.plane;
  const pvx = read(state, player, 'vx');
  const pvz = read(state, player, 'vz');
  const ax = read(state, player, 'x') + pvx * lead;
  const az = read(state, player, 'z') + pvz * lead;
  const rx = read(state, body, 'x') - ax;
  const rz = read(state, body, 'z') - az;
  const speed = length(pvx, pvz);
  if (speed === 0) {
    const gap = Math.max(1, length(rx, rz));
    return inside(view, ax + Math.trunc((rx * side) / gap), az + Math.trunc((rz * side) / gap));
  }
  const flip = -pvz * rx + pvx * rz < 0 ? -1 : 1;
  return inside(view, ax + Math.trunc((-pvz * flip * side) / speed), az + Math.trunc((pvx * flip * side) / speed));
}

export const laneOf = (x: number): number => Math.max(-1, Math.min(1, Math.round(x / RUNNER.laneWidth)));

/** Vedlejší pruh hráče na straně, kde flanker je (u kraje ten druhý). */
function sideLaneX(view: BehaviourView): number {
  const lane = laneOf(read(view.state, view.player, 'x'));
  const side = read(view.state, view.body, 'x') >= read(view.state, view.player, 'x') ? 1 : -1;
  return (Math.abs(lane + side) <= 1 ? lane + side : lane - side) * RUNNER.laneWidth;
}

export const toward = (from: number, to: number, step: number): number => clampTo(to - from, step);

/** Varování = `TELEGRAPH_MIN`; na trati výpad trvá, než ho hráč dojede (nejvýš 2 s – varování zůstane v posledních 3 s). */
const TICKS = { plane: { telegraph: 30, act: 30, recover: 60 }, track: { telegraph: 30, act: 120, recover: 90 } } as const;

export const flanker: Behaviour = {
  id: 'flanker',
  telegraph: { plane: 'dash', track: 'lane' },
  ticks: TICKS,
  body: { role: 'hazard', kind: 'flanker', x: 0, y: 0, z: 0, w: 900, h: 1500, d: 900, solid: false },

  ready(view) {
    const { state, body, player } = view;
    if (view.space === 'plane') return length(read(state, body, 'x') - read(state, player, 'x'), read(state, body, 'z') - read(state, player, 'z')) <= FLANKER.plane.reach;
    return read(state, body, 'z') >= read(state, player, 'z') + FLANKER.track.ahead && read(state, body, 'x') === sideLaneX(view);
  },

  aim(view) {
    const { state, body, player } = view;
    if (view.space === 'track') return { x: laneOf(read(state, player, 'x')) * RUNNER.laneWidth, z: read(state, body, 'z') };
    // Kde hráč bude na konci varování, když nezmění směr.
    const ticks = TICKS.plane.telegraph;
    return inside(view, read(state, player, 'x') + read(state, player, 'vx') * ticks, read(state, player, 'z') + read(state, player, 'vz') * ticks);
  },

  done(view) {
    const { state, body, player, aim } = view;
    if (view.space === 'plane') return length(aim.x - read(state, body, 'x'), aim.z - read(state, body, 'z')) === 0;
    // Hráč ho minul: celé tělo je za ním.
    return read(state, body, 'z') + read(state, body, 'd') < read(state, player, 'z') - read(state, player, 'd');
  },

  move(view) {
    const { state, body, player, phase } = view;
    if (view.space === 'plane') {
      if (phase === 'idle') {
        const point = flankPoint(view);
        const plane = FLANKER.plane;
        headTo(view, point.x, point.z, Math.max(plane.minSpeed, Math.min(plane.maxSpeed, Math.floor((plane.speed * view.intensity) / 1000))));
      } else if (phase === 'act') headTo(view, view.aim.x, view.aim.z, FLANKER.plane.dash);
      else set(state, body, 0, 0);
      return;
    }
    const pvz = read(state, player, 'vz');
    const x = read(state, body, 'x');
    if (phase === 'idle') {
      const behind = read(state, body, 'z') < read(state, player, 'z') + FLANKER.track.ahead;
      set(state, body, toward(x, sideLaneX(view), RUNNER.laneSpeed), behind ? pvz + FLANKER.track.overtake : pvz);
    } else if (phase === 'telegraph') set(state, body, 0, pvz);
    else if (phase === 'act') set(state, body, toward(x, view.aim.x, RUNNER.laneSpeed), Math.trunc(pvz / FLANKER.track.brake));
    else set(state, body, 0, Math.trunc(pvz / 2));
  },

  botStep(view, input, control, recent) {
    if (view.phase !== 'telegraph' && view.phase !== 'act') return input;
    const { state, body, player, aim } = view;
    const from = { x: read(state, body, 'x'), z: read(state, body, 'z') };
    if (view.space === 'plane') return dodgeLine(view, input, from, aim, FLANKER.plane.clearance, (view.phase === 'telegraph' ? view.ticksLeft : 0) + 20);
    if (control !== 'runner' || from.z + read(state, body, 'd') < read(state, player, 'z') - read(state, player, 'd')) return input;
    return dodgeLane(view, input, recent, laneOf(aim.x));
  },
};

/**
 * Robot v rovině: hráč, kterého jeho rychlost během `horizon` tiků přiblíží
 * k úsečce `from → to` na `clearance`, ustoupí kolmo na svou stranu (sdílí
 * flanker a ostřelovač).
 */
export function dodgeLine(view: BehaviourView, input: ArcadeInput, from: Point, to: Point, clearance: number, horizon: number): ArcadeInput {
  const { state, player } = view;
  const px = read(state, player, 'x');
  const pz = read(state, player, 'z');
  const ux = to.x - from.x;
  const uz = to.z - from.z;
  const rx = px - from.x;
  const rz = pz - from.z;
  const span = ux * ux + uz * uz;
  const gap = (x: number, z: number): number => {
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((x - from.x) * ux + (z - from.z) * uz) / span));
    return length(x - Math.round(from.x + ux * t), z - Math.round(from.z + uz * t));
  };
  const pvx = read(state, player, 'vx');
  const pvz = read(state, player, 'vz');
  let near = false;
  for (let k = 0; k <= horizon && !near; k += 5) near = gap(px + pvx * k, pz + pvz * k) <= clearance;
  if (!near) return input;
  if (span === 0) return { buttons: input.buttons, axis: arenaAxis(rx, rz) };
  const flip = -uz * rx + ux * rz < 0 ? -1 : 1;
  return { buttons: input.buttons, axis: arenaAxis(-uz * flip, ux * flip) };
}

/** Robot běžce: z pruhu `aimLane` pryč (ke kraji, nebo na stranu, odkud tělo přijelo), mimo něj do něj nevjet. */
export function dodgeLane(view: BehaviourView, input: ArcadeInput, recent: readonly ArcadeInput[], aimLane: number): ArcadeInput {
  const { state, body, player } = view;
  // Pruh, kam hráč míří, i se stisky, které robot ještě nevidí.
  const shift = (lane: number, buttons: number): number => Math.max(-1, Math.min(1, lane - ((buttons & BUTTON.LEFT) !== 0 ? 1 : 0) + ((buttons & BUTTON.RIGHT) !== 0 ? 1 : 0)));
  const lane = recent.reduce((at, pressed) => shift(at, pressed.buttons), read(state, player, 'aux0'));
  if (shift(lane, input.buttons) !== aimLane) return input;
  const steer = input.buttons & ~(BUTTON.LEFT | BUTTON.RIGHT);
  if (lane !== aimLane) return { buttons: steer, axis: input.axis };
  const away = aimLane !== 0 ? -aimLane : read(state, body, 'x') >= read(state, player, 'x') ? 1 : -1;
  return { buttons: steer | (away < 0 ? BUTTON.LEFT : BUTTON.RIGHT), axis: input.axis };
}
