/**
 * Přepadník (P45C): čeká skrytý, hráče nechá přijít blízko, po chvění vyrazí.
 *
 * `plane`: stojí, kde ho generátor postavil (u kulisy, kolem které vede
 * cesta); do 4 m od hráče se 36 tiků chvěje, pak 30 tiků vyrazí rychlostí
 * 1,5× hráče po směru zamčeném na začátku chvění a 90 tiků se vzpamatovává.
 * `track`: čeká za krajem trati před hráčem a vyskočí z boku do jeho pruhu
 * tak, aby na něj hráč najel, když neuhne; pak se vrátí za kraj a znovu
 * předběhne hráče.
 */

import { UNIT } from '../../contract';
import { ARENA } from '../arena';
import { RUNNER } from '../runner';
import { dodgeLane, dodgeLine, headTo, inside, laneOf, length, read, set, toward } from './flanker';
import type { Behaviour } from './index';

export const AMBUSHER = {
  plane: {
    /** Od této vzdálenosti se chvěje. */
    reach: 4 * UNIT,
    /** Výpad: 1,5× rychlosti hráče. */
    dash: (ARENA.speed * 3) / 2,
    /** Robot uhýbá, když je blíž čáře výpadu. */
    clearance: 2 * UNIT,
  },
  track: {
    /** Čeká tak daleko za středem trati – za krajem vnějšího pruhu. */
    edge: 2 * RUNNER.laneWidth,
    /** Předjíždí o tolik rychleji než hráč, než je `ahead` před ním. */
    overtake: 120, ahead: 15 * UNIT,
    /** Skok do pruhu: 1,5× boční rychlosti hráče. */
    jump: (RUNNER.laneSpeed * 3) / 2,
    /** Hráč k němu dojede tolik tiků po začátku výpadu (skok přes dva pruhy trvá 11). */
    arrive: 20,
  },
} as const;

const TICKS = { plane: { telegraph: 36, act: 30, recover: 90 }, track: { telegraph: 36, act: 30, recover: 90 } } as const;

/** Kraj trati na straně, kde přepadník je. */
const edgeOf = (x: number): number => (x < 0 ? -1 : 1) * AMBUSHER.track.edge;

export const ambusher: Behaviour = {
  id: 'ambusher',
  telegraph: { plane: 'shake', track: 'shake' },
  ticks: TICKS,
  body: { role: 'hazard', kind: 'ambusher', x: 0, y: 0, z: 0, w: 1000, h: 1400, d: 1000, solid: false },

  ready(view) {
    const { state, body, player } = view;
    if (view.space === 'plane') return length(read(state, body, 'x') - read(state, player, 'x'), read(state, body, 'z') - read(state, player, 'z')) <= AMBUSHER.plane.reach;
    // Čeká (stojí) za krajem a hráč dojede během varování a `arrive` tiků výpadu.
    const ahead = read(state, body, 'z') - read(state, player, 'z');
    const x = read(state, body, 'x');
    return read(state, body, 'vz') === 0 && x === edgeOf(x) && ahead > 0 && ahead <= read(state, player, 'vz') * (TICKS.track.telegraph + AMBUSHER.track.arrive);
  },

  aim(view) {
    const { state, body, player } = view;
    if (view.space === 'track') return { x: laneOf(read(state, player, 'x')) * RUNNER.laneWidth, z: read(state, body, 'z') };
    // Směr na hráče, kam ho výpad za `act` tiků donese.
    const bx = read(state, body, 'x');
    const bz = read(state, body, 'z');
    const dx = read(state, player, 'x') - bx;
    const dz = read(state, player, 'z') - bz;
    const gap = Math.max(1, length(dx, dz));
    const run = AMBUSHER.plane.dash * TICKS.plane.act;
    return inside(view, bx + Math.trunc((dx * run) / gap), bz + Math.trunc((dz * run) / gap));
  },

  done(view) {
    const { state, body, player, aim } = view;
    if (view.space === 'plane') return length(aim.x - read(state, body, 'x'), aim.z - read(state, body, 'z')) === 0;
    return read(state, body, 'z') + read(state, body, 'd') < read(state, player, 'z') - read(state, player, 'd');
  },

  move(view) {
    const { state, body, player, phase } = view;
    if (view.space === 'plane') {
      if (phase === 'act') headTo(view, view.aim.x, view.aim.z, AMBUSHER.plane.dash);
      else set(state, body, 0, 0);
      return;
    }
    const x = read(state, body, 'x');
    if (phase === 'telegraph') set(state, body, 0, 0);
    else if (phase === 'act') set(state, body, toward(x, view.aim.x, AMBUSHER.track.jump), 0);
    else if (phase === 'recover') set(state, body, toward(x, edgeOf(x), RUNNER.laneSpeed), 0);
    else {
      // Za hráčem, nebo ještě předjíždí: za krajem dopředu, `ahead` před hráčem se zastaví a čeká.
      const ahead = read(state, body, 'z') - read(state, player, 'z');
      const overtaking = ahead < 0 || (read(state, body, 'vz') > 0 && ahead < AMBUSHER.track.ahead);
      set(state, body, toward(x, edgeOf(x), RUNNER.laneSpeed), overtaking ? read(state, player, 'vz') + AMBUSHER.track.overtake : 0);
    }
  },

  botStep(view, input, control, recent) {
    if (view.phase !== 'telegraph' && view.phase !== 'act') return input;
    const { state, body, player, aim } = view;
    const from = { x: read(state, body, 'x'), z: read(state, body, 'z') };
    if (view.space === 'plane') return dodgeLine(view, input, from, aim, AMBUSHER.plane.clearance, (view.phase === 'telegraph' ? view.ticksLeft : 0) + 20);
    if (control !== 'runner' || from.z + read(state, body, 'd') < read(state, player, 'z') - read(state, player, 'd')) return input;
    return dodgeLane(view, input, recent, laneOf(aim.x));
  },
};
