/**
 * Boss skákačky (P46B T6): na konci úrovně v aréně – poslední desce, na které stojí cíl (`PLATFORM_SEGMENTS.arena`).
 *
 * Pevné tělo role `hazard`: dotek z boku zraní jako hrot (pravidlo `hit` plošinovky, s milostí a návratem na
 * checkpoint arény), doskok na hlavu ne – jádro hráče na pevné tělo shora postaví. Každý doskok na hlavu mu ubere
 * 1 HP (jednou za doskok, stání na hlavě se nepočítá) a omráčí ho na `stun` tiků; poslední HP = zmizí. Výhru nedá:
 * úroveň se vyhrává cílem.
 *
 * Arénu najde podle cíle (role `goal`). Než na ni hráč doskočí, čeká `home` za její bližší hranou; v aréně drží
 * odstup `stand` od hráče na své straně – k hráči sám nikdy nejde –, do `reach` varuje (`dash`, `telegraph` tiků,
 * každý zásah o `shorten` méně) a pak se rozběhne na místo hráče zamčené na začátku varování (`act`, s každým
 * zásahem rychleji); po náběhu stojí (`recover`). Arénu neopustí a k cíli nechá `goal` volna.
 *
 * Paměť: bit 0 = boss je v aréně (první tik ho tam přenese z místa vstupu), bit 1 = hráč mu stál na hlavě
 * na začátku tiku (doskok = stojí na ní teď a předtím ne), bity 2–7 = zbývající tiky omráčení.
 *
 * Obtížnost (8 semínek × 4 buňky `platformer.default*`, robot intermediate 32/32, boss padl v každé výhře): bez
 * omráčení prohrál útěk s jedním životem 2/16 na doskoku z hlavy, když boss zrovna nabíhal.
 */

import { type ArcadeEffect, type ArcadeInput, type ArcadeState, AXIS_MAX, BODY, BUTTON, type BodyInit, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp } from '../../contract';
import { PLATFORM, riseTicks } from '../platform';
import { ticksToLand } from '../platform-bot';
import { clampTo, read } from './flanker';
import type { Behaviour, BehaviourStep, BehaviourView } from './index';

export const BRUTE = {
  /** Čeká tak daleko za bližší hranou arény; od jejích krajů drží `edge`, od cíle `goal`. */
  home: 11 * UNIT,
  edge: 2 * UNIT,
  goal: 3 * UNIT,
  /** Odstup od hráče v aréně a odkud varuje. */
  stand: 6 * UNIT,
  reach: 8 * UNIT,
  /** Chůze (hráč běží 99–127) a náběh; náběh s každým zásahem o `chargeStep` rychlejší. */
  walk: 40,
  charge: 110,
  chargeStep: 15,
  telegraph: 40,
  shorten: 4,
  /** Po doskoku na hlavu tolik tiků stojí (omráčený) – odraz z hlavy na ni dopadne znovu, i když boss zrovna nabíhal. */
  stun: 45,
  hp: 3,
} as const;

const TICKS = { plane: { telegraph: BRUTE.telegraph, act: 90, recover: 45 }, track: { telegraph: BRUTE.telegraph, act: 90, recover: 45 } } as const;

const IN_ARENA = 1;
const ON_HEAD = 2;
/** Zbývající tiky omráčení v bitech 2–7. */
const STUN_SHIFT = 2;
const STUN_MASK = 0x3f;

interface Arena {
  /** Bližší hrana arény a výška její horní stěny. */
  readonly near: number;
  readonly top: number;
  /** Kam smí střed bosse. */
  readonly lo: number;
  readonly hi: number;
  readonly home: number;
}

/** Aréna podle cíle: deska, na které cíl stojí; `d` = délka bosse. Bez cíle na desce `null`. */
function arenaOf(state: ArcadeState, d: number): Arena | null {
  const count = state[HEADER.bodyCount] as number;
  const alive = (body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
  let goal = -1;
  for (let body = 0; body < count && goal < 0; body += 1) if (alive(body) && read(state, body, 'role') === ROLE.goal) goal = body;
  if (goal < 0) return null;
  const gz = read(state, goal, 'z');
  const top = read(state, goal, 'y');
  for (let body = 0; body < count; body += 1) {
    if (!alive(body) || read(state, body, 'role') !== ROLE.platform || (read(state, body, 'flags') & FLAG.kinematic) !== 0) continue;
    const z = read(state, body, 'z');
    const length = read(state, body, 'd');
    if (Math.abs(gz - z) * 2 >= length || read(state, body, 'y') + read(state, body, 'h') !== top) continue;
    const near = z - Math.trunc(length / 2);
    const lo = near + BRUTE.edge + Math.trunc(d / 2);
    const hi = Math.max(lo, gz - BRUTE.goal - Math.trunc(d / 2));
    return { near, top, lo, hi, home: Math.min(hi, near + BRUTE.home) };
  }
  return null;
}

/** Stojí hráč bossovi na hlavě (na zemi, spodní stěnou na jeho horní, překryv napříč i podél)? */
function onHead(state: ArcadeState, body: number, player: number): boolean {
  return (
    (read(state, player, 'flags') & FLAG.grounded) !== 0 &&
    read(state, player, 'y') === read(state, body, 'y') + read(state, body, 'h') &&
    Math.abs(read(state, player, 'z') - read(state, body, 'z')) * 2 < read(state, player, 'd') + read(state, body, 'd') &&
    Math.abs(read(state, player, 'x') - read(state, body, 'x')) * 2 < read(state, player, 'w') + read(state, body, 'w')
  );
}

const hitsOf = (view: BehaviourView): number => Math.max(0, BRUTE.hp - bodyHp(view.state, view.body));
const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));
const sign = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0);

/** Robot: rezerva dopadu od kraje hlavy bosse a od jeho boku. */
const PAD = 200;

/**
 * Robot: kde bude boss `ticks` tiků po viděném stavu – varování doběhne a náběh jede na zamčené místo jako `move`
 * (varování je tu proto, aby hráč náběh předvídal); jinak jede dál svou rychlostí. Ne déle než do kraje arény.
 */
function bossAfter(view: BehaviourView, arena: Arena, ticks: number): number {
  let z = read(view.state, view.body, 'z');
  let { phase, ticksLeft } = view;
  let stun = (view.memo >> STUN_SHIFT) & STUN_MASK;
  const vz = read(view.state, view.body, 'vz');
  const charge = BRUTE.charge + BRUTE.chargeStep * hitsOf(view);
  for (let t = 0; t < ticks; t += 1) {
    // Omráčení náběh ukončí (`done`: stojí).
    if (stun > 0) {
      stun -= 1;
      if (phase === 'act') phase = 'recover';
    }
    if (phase === 'telegraph') {
      ticksLeft -= 1;
      if (ticksLeft <= 0) phase = 'act';
      continue;
    }
    if (stun > 0) continue;
    z += phase === 'act' ? clampTo(view.aim.z - z, charge) : vz;
    z = Math.max(arena.lo, Math.min(arena.hi, z));
  }
  return z;
}

export const brute: Behaviour = {
  id: 'brute',
  telegraph: { plane: 'dash', track: 'dash' },
  ticks: TICKS,
  body: { role: 'hazard', kind: 'boss', x: 0, y: 0, z: 0, w: 1600, h: 1300, d: 2000, solid: true, hp: BRUTE.hp } as BodyInit,

  warnTicks: (view) => BRUTE.telegraph - BRUTE.shorten * hitsOf(view),

  ready(view) {
    const { state, body, player } = view;
    if ((view.memo & IN_ARENA) === 0) return false;
    const arena = arenaOf(state, read(state, body, 'd'));
    const pz = read(state, player, 'z');
    return arena !== null && pz >= arena.near && Math.abs(read(state, body, 'z') - pz) <= BRUTE.reach && !onHead(state, body, player);
  },

  aim(view) {
    const { state, body, player } = view;
    const arena = arenaOf(state, read(state, body, 'd'));
    const pz = read(state, player, 'z');
    return { x: 0, z: arena === null ? pz : Math.max(arena.lo, Math.min(arena.hi, pz)) };
  },

  // Náběh skončí, když boss stojí (doběhl na zamčené místo nebo ke kraji arény).
  done: (view) => view.ticksLeft < TICKS.track.act - 1 && read(view.state, view.body, 'vz') === 0,

  move(view: BehaviourStep) {
    const { state, body, player, phase } = view;
    const arena = arenaOf(state, read(state, body, 'd'));
    const base = bodyBase(body);
    if (arena === null) {
      state[base + BODY.vx] = 0;
      state[base + BODY.vy] = 0;
      state[base + BODY.vz] = 0;
      return;
    }
    // Doskok (hráč na hlavě teď, minulý tik ne) boss omráčí na `stun` tiků; omráčený stojí.
    const head = onHead(state, body, player);
    const stunned = (view.memo >> STUN_SHIFT) & STUN_MASK;
    const stun = head && (view.memo & ON_HEAD) === 0 ? BRUTE.stun : Math.max(0, stunned - 1);
    view.remember(IN_ARENA | (head ? ON_HEAD : 0) | (stun << STUN_SHIFT));
    const bz = read(state, body, 'z');
    let vz: number;
    if ((view.memo & IN_ARENA) === 0) vz = arena.home - bz;
    else if (stun > 0) vz = 0;
    else {
      const pz = read(state, player, 'z');
      if (phase === 'act') vz = clampTo(view.aim.z - bz, BRUTE.charge + BRUTE.chargeStep * hitsOf(view));
      else if (phase === 'idle') vz = clampTo((pz < arena.near ? arena.home : pz + (bz >= pz ? 1 : -1) * BRUTE.stand) - bz, BRUTE.walk);
      else vz = 0;
      vz = Math.max(arena.lo, Math.min(arena.hi, bz + vz)) - bz;
    }
    state[base + BODY.vx] = -read(state, body, 'x');
    state[base + BODY.vy] = arena.top - read(state, body, 'y');
    state[base + BODY.vz] = vz;
  },

  effects(view): readonly ArcadeEffect[] {
    const { state, body, player } = view;
    if ((view.memo & ON_HEAD) !== 0 || !onHead(state, body, player)) return [];
    const effects: ArcadeEffect[] = [{ kind: 'hit', body, by: player, amount: 1 }];
    if (bodyHp(state, body) <= 1) effects.push({ kind: 'despawn', body });
    return effects;
  },

  // Základní robot bosse nevidí (jinak ho přeskočí jako hrot); skoky na hlavu řídí `botStep`.
  seenBox: () => null,

  botStep(view, input, control, recent): ArcadeInput {
    if (control !== 'platform' || (view.memo & IN_ARENA) === 0) return input;
    const { state, body, player } = view;
    const d = read(state, body, 'd');
    const arena = arenaOf(state, d);
    const pz = read(state, player, 'z');
    if (arena === null || pz < arena.near - PLATFORM.playerD) return input;
    const py = read(state, player, 'y');
    const vy = read(state, player, 'vy');
    const grounded = (read(state, player, 'flags') & FLAG.grounded) !== 0;
    const tapped = recent.some((seen) => (seen.buttons & BUTTON.TAP) !== 0);
    const lag = recent.length;
    // Hráč teď: viděný stav + stisky, které v něm ještě nejsou (nejvyšší rychlost běhu z toho, jak rychle už běží).
    let v = read(state, player, 'vz');
    let z = pz;
    const run = Math.max(PLATFORM.maxRun, Math.abs(v));
    for (const seen of recent) {
      const target = Math.trunc((seen.axis * run) / AXIS_MAX);
      const ground = grounded && !tapped;
      v = toward(v, target, target !== 0 ? (ground ? PLATFORM.groundAccel : PLATFORM.airAccel) : ground ? PLATFORM.groundFriction : PLATFORM.airDrag);
      z += v;
    }
    const bz = bossAfter(view, arena, lag);
    const top = read(state, body, 'y') + read(state, body, 'h');
    const reach = Math.trunc((PLATFORM.playerD + d) / 2);
    if (grounded && !tapped) {
      // Na hlavě: hned znovu odraz, nad její střed.
      if (py === top && Math.abs(pz - read(state, body, 'z')) < reach) return { buttons: BUTTON.TAP, axis: (sign(bz - z) * AXIS_MAX) / 2 };
      if (py !== arena.top) return input;
      const fall = ticksToLand(arena.top, PLATFORM.jumpVy, top);
      if (fall === null) return input;
      const rise = riseTicks(top - arena.top + PAD);
      const landing = bossAfter(view, arena, lag + fall);
      const dir = landing >= z ? 1 : -1;
      const speed = Math.max((run * 9) / 10, Math.abs(v));
      // Skok tak, aby dopadl bossovi doprostřed hlavy; když by mu dřív, než vystoupá nad hlavu, narazil do boku, couvnout.
      const clear = (bossAfter(view, arena, lag + rise) - z - dir * speed * rise) * dir >= reach + PAD;
      const have = (landing - z) * dir;
      if (!clear) return { buttons: 0, axis: -dir * AXIS_MAX };
      if (have <= speed * fall) return { buttons: BUTTON.TAP, axis: dir * AXIS_MAX };
      return { buttons: 0, axis: dir * AXIS_MAX };
    }
    // Odraz, který robot ještě nevidí: dál k bossovi.
    if (grounded) return { buttons: 0, axis: sign(bz - z) * AXIS_MAX };
    // Ve vzduchu: dopad doprostřed hlavy; když na ni skok nedosáhne, nedopadnout bossovi k boku.
    const land = ticksToLand(py, vy, top);
    if (land !== null && land > lag) {
      const at = bossAfter(view, arena, land);
      const landZ = z + v * (land - lag);
      const half = Math.trunc(d / 2) - PAD;
      return { buttons: 0, axis: landZ > at + half ? -AXIS_MAX : landZ < at - half ? AXIS_MAX : 0 };
    }
    const floor = ticksToLand(py, vy, arena.top);
    if (floor === null) return input;
    const at = bossAfter(view, arena, Math.max(lag, floor));
    const landZ = z + v * Math.max(0, floor - lag);
    return Math.abs(landZ - at) < reach + PAD ? { buttons: 0, axis: landZ >= at ? AXIS_MAX : -AXIS_MAX } : input;
  },
};
