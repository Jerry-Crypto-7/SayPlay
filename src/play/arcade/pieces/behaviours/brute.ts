/**
 * Boss skákačky (P46B T6): na konci úrovně v aréně – jámě, na jejímž dně stojí cíl (`PLATFORM_SEGMENTS.arena`).
 *
 * Pevné tělo role `hazard`: dotek z boku zraní jako hrot (pravidlo `hit` plošinovky, s milostí a návratem na
 * checkpoint arény), doskok na hlavu ne – jádro hráče na pevné tělo shora postaví. Každý doskok na hlavu mu ubere
 * 1 HP (jednou za doskok, stání na hlavě se nepočítá) a omráčí ho na `stun` tiků; poslední HP = zmizí. Výhru nedá:
 * úroveň se vyhrává cílem. Je dvakrát vyšší než hrdina (R5 – soudce menšího bosse na snímku neviděl), takže mu na
 * hlavu dosáhne jen skok z římsy nad jámou (`PLATFORM_SEGMENTS.pit`); ze dna ho nepřeskočí ani na něj nedoskočí.
 *
 * Arénu najde podle cíle (role `goal`) a římsu podle její vzdálenější hrany nad bližší hranou jámy. Než hráč na
 * římsu doskočí, čeká `home` za hranou jámy; pak drží odstup `stand` od hráče na své straně – k hráči sám nikdy
 * nejde –, do `reach` varuje (`dash`, `telegraph` tiků, každý zásah o `shorten` méně) a pak se rozběhne na místo
 * hráče zamčené na začátku varování (`act`, s každým zásahem rychleji); po náběhu stojí (`recover`). Jámu neopustí:
 * od stěny pod římsou drží `edge`, k cíli nechá `goal` volna – na hráče na římse tedy nabíhá ke stěně pod ním.
 *
 * Paměť: bit 0 = boss je v aréně (první tik ho tam přenese z místa vstupu), bit 1 = hráč mu stál na hlavě
 * na začátku tiku (doskok = stojí na ní teď a předtím ne), bity 2–7 = zbývající tiky omráčení.
 *
 * Obtížnost (8 semínek × 4 buňky `platformer.default*`, robot intermediate 32/32, boss padl v každé výhře): bez
 * omráčení prohrál útěk s jedním životem 2/16 na doskoku z hlavy, když boss zrovna nabíhal. S jámou (R5, 20 semínek ×
 * 4 buňky): intermediate 80/80, začátečník 0,4–0,5 (před R5 0,35–0,45); na 8 semínkách pinu každý doskok z římsy.
 */

import { type ArcadeEffect, type ArcadeInput, type ArcadeState, AXIS_MAX, BODY, BUTTON, type BodyInit, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp } from '../../contract';
import { GRAVITY } from '../../kernel';
import { PLATFORM, riseTicks } from '../platform';
import { ticksToLand } from '../platform-bot';
import { clampTo, read } from './flanker';
import type { Behaviour, BehaviourStep, BehaviourView } from './index';

export const BRUTE = {
  /** Čeká tak daleko za bližší hranou jámy; od stěny pod římsou drží `edge`, od cíle `goal`. */
  home: 5 * UNIT,
  edge: 300,
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
  /** Bližší hrana jámy a výška jejího dna. */
  readonly near: number;
  readonly top: number;
  /** Římsa nad jámou (vzdálenější hranou u `near`), ze které se bossovi skáče na hlavu; boj začne, když je na ní hráč. */
  readonly ledge: { readonly near: number; readonly far: number; readonly top: number } | null;
  readonly entry: number;
  /** Kam smí střed bosse. */
  readonly lo: number;
  readonly hi: number;
  readonly home: number;
}

/** Aréna podle cíle: deska, na které cíl stojí, a římsa nad její bližší hranou; `d` = délka bosse. Bez cíle na desce `null`. */
function arenaOf(state: ArcadeState, d: number): Arena | null {
  const count = state[HEADER.bodyCount] as number;
  const fixed = (body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & (FLAG.alive | FLAG.kinematic)) === FLAG.alive && read(state, body, 'role') === ROLE.platform;
  const topOf = (body: number): number => read(state, body, 'y') + read(state, body, 'h');
  const half = (body: number): number => Math.trunc(read(state, body, 'd') / 2);
  let goal = -1;
  for (let body = 0; body < count && goal < 0; body += 1) if (((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0 && read(state, body, 'role') === ROLE.goal) goal = body;
  if (goal < 0) return null;
  const gz = read(state, goal, 'z');
  const top = read(state, goal, 'y');
  let pit = -1;
  for (let body = 0; body < count && pit < 0; body += 1) if (fixed(body) && topOf(body) === top && Math.abs(gz - read(state, body, 'z')) < half(body)) pit = body;
  if (pit < 0) return null;
  const near = read(state, pit, 'z') - half(pit);
  // Hrany desek z poloviny délky: lichá délka je o jednotku posune.
  let ledge = -1;
  for (let body = 0; body < count && ledge < 0; body += 1) if (fixed(body) && topOf(body) > top && Math.abs(read(state, body, 'z') + half(body) - near) <= 1) ledge = body;
  const lo = near + BRUTE.edge + Math.trunc(d / 2);
  const hi = Math.max(lo, gz - BRUTE.goal - Math.trunc(d / 2));
  const shelf = ledge < 0 ? null : { near: read(state, ledge, 'z') - half(ledge), far: read(state, ledge, 'z') + half(ledge), top: topOf(ledge) };
  return { near, top, ledge: shelf, entry: shelf?.near ?? near, lo, hi, home: Math.min(hi, near + BRUTE.home) };
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

/** Robot: vodorovná dráha `ticks` tiků skoku s plnou osou `dir` z rychlosti `v` (ve vzduchu `airAccel` k nejvyšší `run`). */
function airRun(v: number, dir: number, run: number, ticks: number): number {
  let along = 0;
  for (let t = 0, speed = v; t < ticks; t += 1) {
    speed = toward(speed, dir * run, PLATFORM.airAccel);
    along += speed;
  }
  return along * dir;
}

/** Robot: nejvyšší bod skoku z viděného `y`, `vy` (jádro: nejdřív `vy −= g`, pak `y += vy`). */
function peakOf(y: number, vy: number): number {
  let peak = y;
  for (let speed = vy - GRAVITY; speed > 0; speed -= GRAVITY) peak += speed;
  return peak;
}

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
  body: { role: 'hazard', kind: 'boss', x: 0, y: 0, z: 0, w: 1600, h: 2 * PLATFORM.playerH, d: 2000, solid: true, hp: BRUTE.hp } as BodyInit,

  warnTicks: (view) => BRUTE.telegraph - BRUTE.shorten * hitsOf(view),

  ready(view) {
    const { state, body, player } = view;
    if ((view.memo & IN_ARENA) === 0) return false;
    const arena = arenaOf(state, read(state, body, 'd'));
    const pz = read(state, player, 'z');
    return arena !== null && pz >= arena.entry && Math.abs(read(state, body, 'z') - pz) <= BRUTE.reach && !onHead(state, body, player);
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
      else if (phase === 'idle') vz = clampTo((pz < arena.entry ? arena.home : pz + (bz >= pz ? 1 : -1) * BRUTE.stand) - bz, BRUTE.walk);
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
    if (arena === null || pz < arena.entry - PLATFORM.playerD) return input;
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
      // Odsud skok nad hlavu nevystoupá (dno jámy, schod): dál vede základní robot.
      const rise = riseTicks(top - py + PAD);
      if (!Number.isFinite(rise)) return input;
      const fall = ticksToLand(py, PLATFORM.jumpVy, top) as number;
      const landing = bossAfter(view, arena, lag + fall);
      const dir = landing >= z ? 1 : -1;
      // Skok tak, aby dopadl bossovi doprostřed hlavy a nad ni vystoupal dřív, než dojde k jeho boku.
      const clear = (bossAfter(view, arena, lag + rise) - z) * dir - airRun(v, dir, run, rise) >= reach + PAD;
      if (clear && (landing - z) * dir <= airRun(v, dir, run, fall)) return { buttons: BUTTON.TAP, axis: dir * AXIS_MAX };
      // Jinak na místo odrazu: uprostřed pásma, odkud skok z klidu obojí stihne – z římsy ne přes její hranu.
      const launch = Math.trunc((reach + PAD + airRun(0, 1, run, rise) + airRun(0, 1, run, fall)) / 2);
      const edge = arena.ledge !== null && py === arena.ledge.top ? arena.ledge.far - PLATFORM.playerD / 2 - PAD : Number.POSITIVE_INFINITY;
      const want = Math.min(edge, landing - dir * launch);
      const stop = z + Math.trunc((v * Math.abs(v)) / (2 * PLATFORM.groundFriction));
      return { buttons: 0, axis: stop < want - PAD ? AXIS_MAX : stop > want + PAD ? -AXIS_MAX : 0 };
    }
    // Odraz, který robot ještě nevidí: dál k bossovi.
    if (grounded) return { buttons: 0, axis: sign(bz - z) * AXIS_MAX };
    // Ve vzduchu: dopad doprostřed hlavy, když nad ni skok vystoupá – i dopad, který robot ještě nevidí (jinak by ho
    // větev dna hnala od bosse a z hlavy by sešel za něj); jinak nedopadnout bossovi do jámy k boku.
    const land = peakOf(py, vy) > top ? ticksToLand(py, vy, top) : null;
    if (land !== null && (land > lag || Math.abs(z - bz) < reach)) {
      const at = bossAfter(view, arena, Math.max(lag, land));
      const landZ = z + v * Math.max(0, land - lag);
      const half = Math.trunc(d / 2) - PAD;
      return { buttons: 0, axis: landZ > at + half ? -AXIS_MAX : landZ < at - half ? AXIS_MAX : 0 };
    }
    const floor = ticksToLand(py, vy, arena.top);
    if (floor === null || z < arena.near) return input;
    const at = bossAfter(view, arena, Math.max(lag, floor));
    const landZ = z + v * Math.max(0, floor - lag);
    return Math.abs(landZ - at) < reach + PAD ? { buttons: 0, axis: landZ >= at ? AXIS_MAX : -AXIS_MAX } : input;
  },
};
