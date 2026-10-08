/**
 * Hejno (P45C): malá rychlá těla, každé zraní jednou a zmizí.
 *
 * Jeden spawn rozvrhu = `SWARM.size` těl (½ hráče) na jednom místě. `plane`:
 * těla drží pohromadě (soudržnost ke středu hejna) a od sebe (odstup
 * `spacing`), hejno se táhne k hráči; shluknuté a s hráčem do 12 m 30 tiků
 * stojí sevřené (varování), pak 2 s letí na hráče 0,8× jeho rychlosti –
 * hráč mu vždy uteče. Dotek = zásah s milostí a tělo zmizí. `track`: hejno
 * v řadě za sebou předjede hráče za krajem trati, zastaví a po varování
 * přeletí šikmo přes krajní a prostřední pruh; protější pruh zůstane volný.
 */

import { type ArcadeInput, type ArcadeState, BODY, BUTTON, FLAG, HEADER, HIT_GRACE, UNIT, bodyBase, graceOf } from '../../contract';
import { ARENA, arenaAxis } from '../arena';
import { RUNNER } from '../runner';
import { clampTo, length, overlaps, read, set, toward } from './flanker';
import type { Behaviour, BehaviourStep, BehaviourView } from './index';

type Point = { readonly x: number; readonly z: number };

export const SWARM = {
  /** Těl z jednoho spawnu, jejich odstup a jak silně se od bližších odtlačí (za tik). */
  size: 5,
  spacing: 700,
  push: 60,
  plane: {
    /** Útok 0,8× rychlosti hráče; shlukování pomaleji. */
    speed: (ARENA.speed * 4) / 5,
    gather: 90,
    /** Shluknuté = každé tělo do `tight` od středu; vyrazí, když je hráč do `reach` od středu (kam útok doletí). */
    tight: 1500,
    reach: 12 * UNIT,
    /** Hejno mimo dosah se k hráči táhne bodem o tolik před středem; mimo útok se k hráči nepřiblíží víc než na `keep`. */
    drift: 2 * UNIT,
    keep: 3 * UNIT,
    /** Robot utíká od těla blíž než `danger`, s tahem ke středu plochy. */
    danger: 6 * UNIT,
  },
  track: {
    /** Čeká za krajem trati `ahead` před hráčem; předjíždí o `overtake` rychleji. */
    edge: 2 * RUNNER.laneWidth,
    overtake: 120,
    ahead: 15 * UNIT,
    /** Přelet: boční rychlost a kam doletí (hranice prostředního a protějšího pruhu); hráč dojede `arrive` tiků po začátku. */
    cross: 100,
    end: RUNNER.laneWidth / 2,
    arrive: 40,
  },
} as const;

const TICKS = { plane: { telegraph: 30, act: 120, recover: 60 }, track: { telegraph: 30, act: 90, recover: 60 } } as const;

interface Flock {
  readonly state: ArcadeState;
  readonly tick: number;
  readonly kind: number;
  readonly w: number;
  /** Živá těla hejna (stejný model a šířka), vzestupně. */
  readonly bodies: readonly number[];
  readonly center: Point;
  /** Shluknuté: každé tělo do `SWARM.plane.tight` od středu. */
  readonly tight: boolean;
  /** Trať: hejno ještě předjíždí (rozhoduje celé, ať se řada neroztrhne). */
  readonly moving: boolean;
}

/**
 * Ovládání volá `ready` a `move` každého těla hejna v jednom tiku nad stejnými
 * polohami a stejnými živými těly (spawn i despawn dělají až pravidla) – hejno
 * se spočítá jednou za tik a stav. Bez toho 12 těl stojí 0,07 ms na tik.
 */
let last: Flock | null = null;

function flockOf(view: BehaviourView): Flock {
  const { state, body, player } = view;
  const tick = state[HEADER.tick] as number;
  const kind = read(state, body, 'kind');
  const w = read(state, body, 'w');
  if (last !== null && last.state === state && last.tick === tick && last.kind === kind && last.w === w) return last;
  const bodies: number[] = [];
  let x = 0;
  let z = 0;
  for (let other = 0; other < (state[HEADER.bodyCount] as number); other += 1) {
    const base = bodyBase(other);
    if (other === player || ((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.kind] !== kind || state[base + BODY.w] !== w) continue;
    bodies.push(other);
    x += state[base + BODY.x] as number;
    z += state[base + BODY.z] as number;
  }
  const center = { x: Math.trunc(x / bodies.length), z: Math.trunc(z / bodies.length) };
  const tight = bodies.every((other) => length(read(state, other, 'x') - center.x, read(state, other, 'z') - center.z) <= SWARM.plane.tight);
  last = { state, tick, kind, w, bodies, center, tight, moving: bodies.some((other) => read(state, other, 'vz') > 0) };
  return last;
}

/** Rychlost k bodu (nejvýš `speed`, blíž = dojet přesně) plus odstup od bližších těl hejna, celé nejvýš `speed`. */
function steer(view: BehaviourStep, to: Point, speed: number, flock: readonly number[]): void {
  const { state, body } = view;
  const bx = read(state, body, 'x');
  const bz = read(state, body, 'z');
  const dx = to.x - bx;
  const dz = to.z - bz;
  const gap = length(dx, dz);
  let vx = gap <= speed ? dx : Math.trunc((dx * speed) / gap);
  let vz = gap <= speed ? dz : Math.trunc((dz * speed) / gap);
  for (const other of flock) {
    if (other === body) continue;
    const base = bodyBase(other);
    const rx = bx - (state[base + BODY.x] as number);
    const rz = bz - (state[base + BODY.z] as number);
    if (rx * rx + rz * rz >= SWARM.spacing * SWARM.spacing) continue;
    const near = length(rx, rz);
    const push = Math.trunc(((SWARM.spacing - near) * SWARM.push) / SWARM.spacing);
    // Na stejném místě rozhodne pořadí těl.
    if (near === 0) vx += body < other ? -push : push;
    else {
      vx += Math.trunc((rx * push) / near);
      vz += Math.trunc((rz * push) / near);
    }
  }
  const total = length(vx, vz);
  if (total > speed) set(state, body, Math.trunc((vx * speed) / total), Math.trunc((vz * speed) / total));
  else set(state, body, vx, vz);
}

/** Strana trati, kde hejno čeká: po přeletu ta, odkud vyrazilo. */
const sideOf = (view: BehaviourView): number => (view.phase === 'recover' ? (view.aim.x < 0 ? 1 : -1) : read(view.state, view.body, 'x') < 0 ? -1 : 1);

const passed = (view: BehaviourView): boolean => read(view.state, view.body, 'z') + read(view.state, view.body, 'd') < read(view.state, view.player, 'z') - read(view.state, view.player, 'd');

/** Robot běžce: do pruhu `target`, i se stisky, které ve stavu ještě nejsou. */
function toLane(view: BehaviourView, input: ArcadeInput, recent: readonly ArcadeInput[], target: number): ArcadeInput {
  const shift = (lane: number, buttons: number): number => Math.max(-1, Math.min(1, lane - ((buttons & BUTTON.LEFT) !== 0 ? 1 : 0) + ((buttons & BUTTON.RIGHT) !== 0 ? 1 : 0)));
  const lane = recent.reduce((at, pressed) => shift(at, pressed.buttons), read(view.state, view.player, 'aux0'));
  const steady = input.buttons & ~(BUTTON.LEFT | BUTTON.RIGHT);
  return { buttons: lane === target ? steady : steady | (target < lane ? BUTTON.LEFT : BUTTON.RIGHT), axis: input.axis };
}

export const swarm: Behaviour = {
  id: 'swarm',
  telegraph: { plane: 'cluster', track: 'cluster' },
  ticks: TICKS,
  body: { role: 'hazard', kind: 'swarm', x: 0, y: 0, z: 0, w: 500, h: 500, d: 500, solid: false },
  group: { size: SWARM.size, spacing: SWARM.spacing },

  ready(view) {
    const { state, player } = view;
    const { bodies, center, tight, moving } = flockOf(view);
    if (view.space === 'plane') return tight && length(read(state, player, 'x') - center.x, read(state, player, 'z') - center.z) <= SWARM.plane.reach;
    // Celé hejno stojí za krajem a hráč dojede během varování a `arrive` tiků přeletu.
    const edge = sideOf(view) * SWARM.track.edge;
    const ahead = center.z - read(state, player, 'z');
    return !moving && bodies.every((body) => read(state, body, 'x') === edge) && ahead > 0 && ahead <= read(state, player, 'vz') * (TICKS.track.telegraph + SWARM.track.arrive);
  },

  aim(view) {
    const { state, body, player } = view;
    if (view.space === 'plane') return { x: read(state, player, 'x'), z: read(state, player, 'z') };
    return { x: -sideOf(view) * SWARM.track.end, z: read(state, body, 'z') };
  },

  done(view) {
    return view.space === 'track' && passed(view);
  },

  move(view) {
    const { state, body, player, phase } = view;
    // Hejno napřed: ještě před první změnou rychlosti v tomto tiku.
    const flock = flockOf(view);
    if (phase === 'telegraph') {
      set(state, body, 0, 0);
      return;
    }
    if (view.space === 'plane') {
      const target = { x: read(state, player, 'x'), z: read(state, player, 'z') };
      if (phase === 'act') {
        steer(view, target, SWARM.plane.speed, flock.bodies);
        return;
      }
      // Shlukovat se; mimo dosah se středem táhnout k hráči, blíž než `keep` od něj couvnout.
      const { center } = flock;
      const { reach, drift, keep } = SWARM.plane;
      const gap = Math.max(1, length(center.x - target.x, center.z - target.z));
      const from = gap > reach ? gap - drift : Math.max(gap, keep);
      steer(view, { x: target.x + Math.trunc(((center.x - target.x) * from) / gap), z: target.z + Math.trunc(((center.z - target.z) * from) / gap) }, SWARM.plane.gather, flock.bodies);
      return;
    }
    const x = read(state, body, 'x');
    if (phase === 'act') {
      set(state, body, toward(x, view.aim.x, SWARM.track.cross), 0);
      return;
    }
    // Za krajem dopředu; střed hejna `ahead` před hráčem zastaví – celé hejno stejně, řada drží.
    const ahead = flock.center.z - read(state, player, 'z');
    const overtaking = ahead < 0 || (flock.moving && ahead < SWARM.track.ahead);
    set(state, body, toward(x, sideOf(view) * SWARM.track.edge, RUNNER.laneSpeed), overtaking ? read(state, player, 'vz') + SWARM.track.overtake : 0);
  },

  effects(view) {
    // Dotek během milosti hráče nic nebere – tělo proletí a zůstane pro další nálet.
    const lands = view.phase === 'act' && graceOf(view.state, view.player) === 0 && overlaps(view.state, view.body, view.player);
    return lands ? [{ kind: 'damage', amount: 1, grace: HIT_GRACE }, { kind: 'despawn', body: view.body }] : [];
  },

  botStep(view, input, control, recent) {
    if (view.phase !== 'telegraph' && view.phase !== 'act') return input;
    const { state, body, player } = view;
    if (view.space === 'track') return control === 'runner' && !passed(view) ? toLane(view, input, recent, view.aim.x < 0 ? -1 : 1) : input;
    // Utéct od blízkého těla, s tahem ke středu plochy (hráč je rychlejší, jen nesmí do rohu).
    const px = read(state, player, 'x');
    const pz = read(state, player, 'z');
    const rx = px - read(state, body, 'x');
    const rz = pz - read(state, body, 'z');
    const gap = length(rx, rz);
    if (gap > SWARM.plane.danger) return input;
    const unit = Math.max(1, gap);
    const pull = (value: number): number => clampTo(Math.trunc((-value * 1000) / ARENA.half), 1000);
    return { buttons: input.buttons, axis: arenaAxis(Math.trunc((rx * 1000) / unit) + pull(px), Math.trunc((rz * 1000) / unit) + pull(pz)) };
  },
};
