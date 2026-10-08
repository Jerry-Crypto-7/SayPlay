/**
 * Boss (P45C): velké tělo s HP, střídá dva útoky po varování a po každém je
 * chvíli zranitelný.
 *
 * Rovina: drží se `stand` od hráče a do `reach` varuje 60 tiků (každý zásah o
 * 8 méně, nejméně `telegraphMin`). Pak buď **dupne** – zraní hráče do `stomp`
 * od sebe (varování `ring`) –, nebo vypálí **salvu** tří výstřelů ostřelovače
 * po zamčené přímce (`fireShot`, varování `line`); začíná dupnutím. Pak 90
 * tiků `recover`: stojí a první dotek hráče mu ubere 1 HP (pravidlo
 * `boss_beat`, `pieces/boss.ts`). Na trati neútočí – finále tratí je sprint.
 *
 * Paměť chování: bity 0–3 = HP na startu, 4–7 = HP na začátku tohoto
 * `recover` (zásah okno zavře), bit 8 = útok, který běží nebo běžel, je dupnutí.
 */

import { type ArcadeEffect, type BodyInit, HIT_GRACE, UNIT, bodyHp } from '../../contract';
import { arenaAxis } from '../arena';
import { flanker, headTo, inside, length, read, set } from './flanker';
import type { Behaviour, BehaviourPhase, BehaviourView } from './index';
import { SHOT, dodgeShot, fireShot } from './sniper';

export const BOSS = {
  /** Varování 60 tiků, každý zásah o `shorten` méně, nejméně `telegraphMin`. */
  telegraph: 60, shorten: 8, telegraphMin: 36,
  /** Odstup, kam se staví, a odkud varuje; přesun pomaleji než hráč (150). */
  stand: (5 * UNIT) / 2, reach: (7 * UNIT) / 2, speed: 80,
  /** Dupnutí zraní hráče, jehož střed je do `stomp` od bosse. */
  stomp: (7 * UNIT) / 2,
  /** Salva: `shots` výstřelů po `volley` tikách. */
  shots: 3, volley: 15,
  /** Robot: od kruhu dupnutí utíká do `margin`, o `UNIT` dál stojí. */
  margin: UNIT,
  /** Výchozí HP (3–6). */
  hp: 4,
} as const;

/** Boss žánru: 9/4 velikosti jeho nepřítele, model `boss`, `hp` životů. */
export const bossBody = (enemy: BodyInit, hp: number = BOSS.hp): BodyInit => ({ ...enemy, kind: 'boss', w: Math.trunc((enemy.w * 9) / 4), h: Math.trunc((enemy.h * 9) / 4), d: Math.trunc((enemy.d * 9) / 4), solid: false, hp });

/** Salva skončí `act` 10 tiků po posledním výstřelu; dupnutí trvá tik (`done`). */
const TICKS = { plane: { telegraph: BOSS.telegraph, act: 40, recover: 90 }, track: { telegraph: BOSS.telegraph, act: 40, recover: 90 } } as const;

const HP_BITS = 0xf;
const WINDOW_SHIFT = 4;
const STOMP = 1 << 8;

const stomping = (memo: number): boolean => (memo & STOMP) !== 0;
/** Paměť i před prvním zápisem: HP na startu = HP teď. */
const memoOf = (view: BehaviourView): number => (view.memo === 0 ? bodyHp(view.state, view.body) & HP_BITS : view.memo);

/** Zranitelný: v `recover`, a v tomto `recover` ho ještě nic nezasáhlo. */
export function bossOpen(state: Int32Array, body: number, phase: BehaviourPhase, memo: number): boolean {
  const hp = bodyHp(state, body);
  return phase === 'recover' && hp > 0 && hp === ((memo >> WINDOW_SHIFT) & HP_BITS);
}

/** Zásahy, které boss od startu dostal. */
export const bossHitsOf = (view: BehaviourView): number => (memoOf(view) & HP_BITS) - bodyHp(view.state, view.body);

/** Tiky od posledního výstřelu salvy (i se stisky `recent`); před ním 0 – výstřel stojí u bosse. */
function sinceLastShot(view: BehaviourView, recent: number): number {
  const last = (BOSS.shots - 1) * BOSS.volley;
  const { act, recover } = TICKS.plane;
  if (view.phase === 'act') return Math.max(0, act - view.ticksLeft - last + recent);
  return view.phase === 'recover' ? act - last + recover - view.ticksLeft + recent : 0;
}

export const boss: Behaviour = {
  id: 'boss',
  telegraph: { plane: 'ring', track: 'ring' },
  ticks: TICKS,
  body: bossBody(flanker.body),
  shot: { ...SHOT, kind: 'boss_shot' },

  warnTicks: (view) => Math.max(BOSS.telegraphMin, BOSS.telegraph - BOSS.shorten * bossHitsOf(view)),
  kindOf: (view) => (stomping(view.memo) ? 'ring' : 'line'),

  ready(view) {
    const { state, body, player } = view;
    return view.space === 'plane' && length(read(state, body, 'x') - read(state, player, 'x'), read(state, body, 'z') - read(state, player, 'z')) <= BOSS.reach;
  },

  aim(view) {
    // Útoky se střídají; dupnutí míří na bosse samého, salva tam, kde hráč stojí.
    const memo = memoOf(view) ^ STOMP;
    view.remember(memo);
    const target = stomping(memo) ? view.body : view.player;
    return { x: read(view.state, target, 'x'), z: read(view.state, target, 'z') };
  },

  done: (view) => stomping(view.memo),

  move(view) {
    const { state, body, player, phase } = view;
    // `aim` v témže tiku už paměť zapsal; v `idle` ji založí tady.
    if (view.memo === 0 && phase === 'idle') view.remember(memoOf(view));
    if (phase === 'recover' && view.ticksLeft === TICKS[view.space].recover) view.remember((view.memo & ~(HP_BITS << WINDOW_SHIFT)) | (bodyHp(state, body) << WINDOW_SHIFT));
    if (view.space === 'track') set(state, body, 0, read(state, player, 'vz'));
    else if (phase !== 'idle') set(state, body, 0, 0);
    else {
      // Bod `stand` od hráče na straně, kde boss je.
      const px = read(state, player, 'x');
      const pz = read(state, player, 'z');
      const rx = read(state, body, 'x') - px;
      const rz = read(state, body, 'z') - pz;
      const gap = Math.max(1, length(rx, rz));
      const point = inside(view, px + Math.trunc((rx * BOSS.stand) / gap), pz + Math.trunc((rz * BOSS.stand) / gap));
      headTo(view, point.x, point.z, BOSS.speed);
    }
  },

  effects(view, ref): readonly ArcadeEffect[] {
    if (view.phase !== 'act') return [];
    const elapsed = TICKS[view.space].act - view.ticksLeft;
    if (!stomping(view.memo)) return elapsed % BOSS.volley === 0 && elapsed < BOSS.shots * BOSS.volley ? fireShot(view, ref) : [];
    const { state, body, player } = view;
    const near = length(read(state, player, 'x') - read(state, body, 'x'), read(state, player, 'z') - read(state, body, 'z')) <= BOSS.stomp;
    return elapsed === 0 && near ? [{ kind: 'damage', amount: 1, grace: HIT_GRACE }] : [];
  },

  botStep(view, input, _control, recent) {
    if (view.space !== 'plane' || view.phase === 'idle') return input;
    const { state, body, player } = view;
    const rx = read(state, player, 'x') - read(state, body, 'x');
    const rz = read(state, player, 'z') - read(state, body, 'z');
    if (view.phase !== 'recover' && stomping(view.memo)) {
      // Z kruhu ven, kousek za ním stát.
      const gap = length(rx, rz);
      const safe = BOSS.stomp + BOSS.margin;
      if (gap <= safe) return { buttons: input.buttons, axis: gap === 0 ? arenaAxis(1, 0) : arenaAxis(rx, rz) };
      return gap <= safe + UNIT ? { buttons: input.buttons, axis: 0 } : input;
    }
    if (!stomping(view.memo)) {
      const dodged = dodgeShot(view, input, recent, sinceLastShot(view, recent.length));
      if (dodged !== input || view.phase !== 'recover') return dodged;
    }
    // Okno: k bossovi a dotknout se ho.
    return bossOpen(state, body, view.phase, view.memo) ? { buttons: input.buttons, axis: arenaAxis(-rx, -rz) } : input;
  },
};
