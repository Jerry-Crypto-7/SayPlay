/**
 * Strážce (P45C): krouží kolem věci, hráče u ní odežene výpadem a vrátí se.
 *
 * Hlídá nejbližší živou věc (`collectible` nebo `goal`) – její index + 1 drží
 * v paměti chování, sebranou vymění za nejbližší další. Obíhá ji na kruhu
 * 3 m; do 3,5 m od hráče 30 tiků varuje (kruh dosahu), pak vyrazí 1,5×
 * rychlostí hráče tam, kde hráč na konci varování bude – nejvýš 5 m od věci –
 * a 90 tiků se vrací na kruh. Věc jde sebrat vždy: hráč, který se jí dotkne
 * z opačné strany kruhu, je od strážce dál než 3,5 m, a po výpadu má 2 s
 * (návrat + varování), než přijde další.
 */

import { type ArcadeState, BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, targetStateOf } from '../../contract';
import { ARENA } from '../arena';
import { dodgeLane, dodgeLine, headTo, inside, laneOf, length, read, set } from './flanker';
import type { Behaviour, BehaviourStep, BehaviourView } from './index';

export const GUARDIAN = {
  /** Kruh kolem věci a rychlost na něm (oběh ≈ 4,2 s); na kruh se vrací rychleji. */
  radius: 3 * UNIT,
  orbit: 75,
  back: 120,
  /** Od této vzdálenosti od hráče varuje. */
  reach: (7 * UNIT) / 2,
  /** Výpad: 1,5× rychlosti hráče, nejvýš `leash` od věci. */
  dash: (ARENA.speed * 3) / 2,
  leash: 5 * UNIT,
  /** Robot uhýbá, když je blíž čáře výpadu; strážce na blízké straně věci čeká `wait` za dosahem. */
  clearance: 2 * UNIT,
  wait: UNIT,
} as const;

const TICKS = { plane: { telegraph: 30, act: 30, recover: 90 }, track: { telegraph: 30, act: 30, recover: 90 } } as const;

const GUARDED: ReadonlySet<number> = new Set([ROLE.collectible, ROLE.goal]);

/**
 * Věc ke hlídání: živá věc ke sběru nebo cíl, a v úkolu (P45C T12) cíl, na kterém hráč ještě nezačal
 * (stav 0) – hotový cíl zůstává živý, strážce pak přejde k dalšímu. Kolik stavů cíl má, strážce neví:
 * u cíle se třemi stavy hlídá jen první krok.
 */
const isItem = (state: ArcadeState, body: number): boolean => {
  if (((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) === 0) return false;
  const role = state[bodyBase(body) + BODY.role] as number;
  return GUARDED.has(role) || (role === ROLE.target && targetStateOf(state, body) === 0);
};

/** Hlídaná věc z paměti, nebo -1 (sebraná, ještě nepřidělená). */
const guardedOf = (view: BehaviourView): number => (view.memo > 0 && isItem(view.state, view.memo - 1) ? view.memo - 1 : -1);

const gapTo = (state: ArcadeState, a: number, b: number): number => length(read(state, a, 'x') - read(state, b, 'x'), read(state, a, 'z') - read(state, b, 'z'));

/** Nejbližší živá věc ke strážci, nebo -1. */
function nearestItem(view: BehaviourView): number {
  const { state, body } = view;
  let found = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let item = 0; item < (state[HEADER.bodyCount] as number); item += 1) {
    if (item === body || !isItem(state, item)) continue;
    const gap = gapTo(state, body, item);
    if (gap < best) [found, best] = [item, gap];
  }
  return found;
}

/** Krok po kruhu kolem věci (proti směru hodin); mimo kruh rychlostí `back` zpátky na něj. */
function circle(view: BehaviourStep, item: number): void {
  const { state, body } = view;
  const ix = read(state, item, 'x');
  const iz = read(state, item, 'z');
  const rx = read(state, body, 'x') - ix;
  const rz = read(state, body, 'z') - iz;
  const gap = length(rx, rz);
  const [ux, uz, unit] = gap === 0 ? [1, 0, 1] : [rx, rz, gap];
  const { radius, orbit } = GUARDIAN;
  const to = inside(view, ix + Math.trunc((ux * radius - uz * orbit) / unit), iz + Math.trunc((uz * radius + ux * orbit) / unit));
  headTo(view, to.x, to.z, GUARDIAN.back);
}

export const guardian: Behaviour = {
  id: 'guardian',
  telegraph: { plane: 'ring', track: 'ring' },
  ticks: TICKS,
  body: { role: 'hazard', kind: 'guardian', x: 0, y: 0, z: 0, w: 1100, h: 1600, d: 1100, solid: false },

  ready(view) {
    const item = guardedOf(view);
    return item >= 0 && gapTo(view.state, view.body, item) <= GUARDIAN.radius + UNIT / 2 && gapTo(view.state, view.body, view.player) <= GUARDIAN.reach;
  },

  aim(view) {
    const { state, player } = view;
    // Kde hráč bude na konci varování, nejvýš `leash` od věci (`ready` ji zaručí).
    const item = guardedOf(view);
    const ix = read(state, item, 'x');
    const iz = read(state, item, 'z');
    const dx = read(state, player, 'x') + read(state, player, 'vx') * TICKS.plane.telegraph - ix;
    const dz = read(state, player, 'z') + read(state, player, 'vz') * TICKS.plane.telegraph - iz;
    const gap = length(dx, dz);
    const scale = Math.min(gap, GUARDIAN.leash);
    return inside(view, gap === 0 ? ix : ix + Math.trunc((dx * scale) / gap), gap === 0 ? iz : iz + Math.trunc((dz * scale) / gap));
  },

  done(view) {
    return length(view.aim.x - read(view.state, view.body, 'x'), view.aim.z - read(view.state, view.body, 'z')) === 0;
  },

  move(view) {
    let item = guardedOf(view);
    if (item < 0) {
      item = nearestItem(view);
      if (item >= 0) view.remember(item + 1);
    }
    if (view.phase === 'act') headTo(view, view.aim.x, view.aim.z, GUARDIAN.dash);
    else if (view.phase === 'telegraph' || item < 0) set(view.state, view.body, 0, 0);
    else circle(view, item);
  },

  botStep(view, input, control, recent) {
    const { state, body, player, aim } = view;
    const from = { x: read(state, body, 'x'), z: read(state, body, 'z') };
    if (view.phase === 'telegraph' || view.phase === 'act') {
      if (view.space === 'plane') return dodgeLine(view, input, from, aim, GUARDIAN.clearance, (view.phase === 'telegraph' ? view.ticksLeft : 0) + 20);
      return control === 'runner' ? dodgeLane(view, input, recent, laneOf(aim.x)) : input;
    }
    // Okno: strážce se vrací, nebo je na druhé straně věci. Jinak kousek za dosahem počkat.
    const item = guardedOf(view);
    if (view.phase !== 'idle' || view.space !== 'plane' || item < 0) return input;
    const ix = read(state, item, 'x');
    const iz = read(state, item, 'z');
    const px = read(state, player, 'x');
    const pz = read(state, player, 'z');
    const farSide = (px - ix) * (from.x - ix) + (pz - iz) * (from.z - iz) < 0;
    return !farSide && length(px - from.x, pz - from.z) <= GUARDIAN.reach + GUARDIAN.wait ? { buttons: input.buttons, axis: 0 } : input;
  },
};
