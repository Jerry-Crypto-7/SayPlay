/**
 * Boss (P45C): velké tělo s HP, střídá dva útoky po varování a po každém je
 * chvíli zranitelný.
 *
 * Rovina: drží se `stand` od hráče a do `reach` varuje 60 tiků (každý zásah o
 * 8 méně, nejméně `telegraphMin`). Pak buď **dupne** – zraní hráče do `stomp`
 * od sebe (varování `ring`) –, nebo vypálí **salvu** tří výstřelů ostřelovače
 * po zamčené přímce (`fireShot`, varování `line`); začíná dupnutím. Pak 90
 * tiků `recover`: stojí a první dotek hráče mu ubere 1 HP (pravidlo
 * `boss_beat`, `pieces/boss.ts`).
 *
 * Trať (P46B T4, finále běžce): jede ve vedlejším pruhu `stand` před hráčem a
 * v pásmu `near`–`far` varuje na pruh hráče, zamčený na začátku varování.
 * Útoky se střídají, začíná skokem: **skok** do zamčeného pruhu a běh proti
 * hráči (`charge`, varování `lane`, dotek v útoku zraní přes `boss_beat`),
 * nebo **hod** překážky do zamčeného pruhu (výstřel ostřelovače, `line`).
 * Každý uhnutý útok mu ubere 1 HP: skok, po kterém hráči od začátku varování
 * neubyl život, a hozená překážka, která hráče minula. Poslední HP = zmizí;
 * výhru nedá, trať se doběhne do cíle.
 *
 * Paměť chování: bity 0–3 = HP na startu, 4–7 = HP na začátku tohoto
 * `recover` (rovina; zásah okno zavře), resp. život hráče na začátku
 * varování (trať), bit 8 = útok, který běží nebo běžel, je dupnutí (rovina),
 * resp. skok (trať), bit 9 = trať (okno `recover` se neotvírá).
 */

import { AIM_GRID, type ArcadeEffect, type ArcadeState, BODY, type BodyInit, COUNTER, FLAG, HEADER, HIT_GRACE, ROLE, UNIT, bodyBase, bodyHp } from '../../contract';
import { arenaAxis } from '../arena';
import { RUNNER } from '../runner';
import { STEER_TRACK, type SteerCourse, centerAt, halfWidthAt } from '../steer';
import { actTicks, boxOf, clampTo, flanker, headTo, inside, laneOf, length, read, set, sideLaneX, toward } from './flanker';
import type { Behaviour, BehaviourPhase, BehaviourRef, BehaviourStep, BehaviourView } from './index';
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
  /**
   * Trať: odstup před hráčem, pásmo, odkud varuje, a dorovnání odstupu za tik – k hráči i zpět před něj
   * rychleji než ostřelovač (60): finále běžce trvá jen pár sekund. Varování 36 tiků, každý zásah o 3 méně.
   * Skok běží proti hráči rychlostí `charge`, hozená překážka letí proti němu rychlostí `throw`. `hp` 3 = tři
   * uhnuté útoky (měřidlo bosse chce ≥ 3 zásahy). Změřeno na běžci (20 semínek): s dorovnáním 300, skokem 100 a
   * hodem 40 (ostřelovač) padl ve 35 z 40 výher robota intermediate, zbytek doběhl do cíle se dvěma zásahy.
   */
  track: { stand: 10 * UNIT, near: 8 * UNIT, far: 14 * UNIT, catchUp: 500, telegraph: 36, shorten: 3, charge: 200, throw: 120, hp: 3 },
} as const;

/** Boss žánru: 9/4 velikosti jeho nepřítele, model `boss`, `hp` životů. */
export const bossBody = (enemy: BodyInit, hp: number = BOSS.hp): BodyInit => ({ ...enemy, kind: 'boss', w: Math.trunc((enemy.w * 9) / 4), h: Math.trunc((enemy.h * 9) / 4), d: Math.trunc((enemy.d * 9) / 4), solid: false, hp });

/**
 * Salva skončí `act` 10 tiků po posledním výstřelu; dupnutí trvá tik (`done`). Trať: hod trvá tik, skok skončí,
 * když ho hráč minul (nejvýš 2 s), a po útoku se boss hned vrací na odstup.
 */
const TICKS = { plane: { telegraph: BOSS.telegraph, act: 40, recover: 90 }, track: { telegraph: BOSS.track.telegraph, act: 120, recover: 12 } } as const;

const HP_BITS = 0xf;
const WINDOW_SHIFT = 4;
const STOMP = 1 << 8;
const TRACK = 1 << 9;

/** Rovina: dupnutí; trať: skok. */
const stomping = (memo: number): boolean => (memo & STOMP) !== 0;
/** Život hráče: zásah (`damage`) ubírá čítač `health`, ne HP jeho těla. */
const healthOf = (state: ArcadeState): number => state[HEADER.counters + COUNTER.health] as number;
/** Paměť i před prvním zápisem: HP na startu = HP teď. */
const memoOf = (view: BehaviourView): number => (view.memo === 0 ? bodyHp(view.state, view.body) & HP_BITS : view.memo);

/** Zranitelný: v `recover` v rovině, a v tomto `recover` ho ještě nic nezasáhlo. */
export function bossOpen(state: Int32Array, body: number, phase: BehaviourPhase, memo: number): boolean {
  const hp = bodyHp(state, body);
  return phase === 'recover' && (memo & TRACK) === 0 && hp > 0 && hp === ((memo >> WINDOW_SHIFT) & HP_BITS);
}

/** Podpis těla (jako `matches` rámce chování) – hozená překážka bosse. */
const SIGNATURE = ['role', 'kind', 'w', 'h', 'd'] as const;
const thrownBy = (state: ArcadeState, body: number, template: number): boolean =>
  (read(state, body, 'flags') & FLAG.alive) !== 0 && SIGNATURE.every((slot) => read(state, body, slot) === read(state, template, slot));

/** Trať: skok do zamčeného pruhu a běh proti hráči; hod a varování drží tempo hráče; jinak ve vedlejším pruhu na odstup. */
function moveOnTrack(view: BehaviourStep): void {
  const { state, body, player, phase } = view;
  const pvz = read(state, player, 'vz');
  const x = read(state, body, 'x');
  if (phase === 'telegraph' || (phase === 'act' && !stomping(view.memo))) set(state, body, 0, pvz);
  else if (phase === 'act') set(state, body, toward(x, view.aim.x, RUNNER.laneSpeed), -BOSS.track.charge);
  else {
    // Nejdřív z pruhu hráče do vedlejšího, pak dorovnat odstup (po skoku zpátky před hráče).
    const side = sideLaneX(view);
    set(state, body, toward(x, side, RUNNER.laneSpeed), x === side ? pvz + clampTo(read(state, player, 'z') + BOSS.track.stand - read(state, body, 'z'), BOSS.track.catchUp) : pvz);
  }
}

/**
 * Trať: uhnuté útoky v tomto tiku – skok na začátku `recover`, když hráči od začátku varování neubyl život, a hozené
 * překážky, které hráče celé minuly (zmizí). Každý ubere 1 HP; poslední bosse odnese.
 */
function trackBlows(view: BehaviourView, ref: BehaviourRef): ArcadeEffect[] {
  const { state, body, player, memo } = view;
  const effects: ArcadeEffect[] = [];
  let blows = view.phase === 'recover' && view.ticksLeft === TICKS.track.recover && stomping(memo) && healthOf(state) >= ((memo >> WINDOW_SHIFT) & HP_BITS) ? 1 : 0;
  if (ref.shot !== undefined) {
    const behind = read(state, player, 'z') - Math.trunc(read(state, player, 'd') / 2);
    for (let shot = state[HEADER.spawnBase] as number; shot < (state[HEADER.bodyCount] as number); shot += 1) {
      if (!thrownBy(state, shot, ref.shot) || read(state, shot, 'z') + Math.trunc(read(state, shot, 'd') / 2) >= behind) continue;
      effects.push({ kind: 'despawn', body: shot });
      blows += 1;
    }
  }
  for (let k = 0; k < blows; k += 1) effects.push({ kind: 'hit', body, by: player, amount: 1 });
  if (blows > 0 && bodyHp(state, body) <= blows) effects.push({ kind: 'despawn', body });
  return effects;
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

/** Boss je poslední krok k výhře: na zemi neleží věc a nestojí soupeř s HP. */
function lastStep(state: Int32Array, player: number): boolean {
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (i === player || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const role = state[base + BODY.role];
    if (role === ROLE.collectible || (role === ROLE.enemy && bodyHp(state, i) > 0)) return false;
  }
  return true;
}

export const boss: Behaviour = {
  id: 'boss',
  telegraph: { plane: 'ring', track: 'ring' },
  ticks: TICKS,
  body: bossBody(flanker.body),
  shot: { ...SHOT, kind: 'boss_shot' },

  warnTicks: (view) => (view.space === 'track' ? BOSS.track.telegraph - BOSS.track.shorten * bossHitsOf(view) : Math.max(BOSS.telegraphMin, BOSS.telegraph - BOSS.shorten * bossHitsOf(view))),
  kindOf: (view) => (stomping(view.memo) ? (view.space === 'track' ? 'lane' : 'ring') : 'line'),

  ready(view) {
    const { state, body, player } = view;
    if (view.space === 'track') {
      const ahead = read(state, body, 'z') - read(state, player, 'z');
      return ahead >= BOSS.track.near && ahead <= BOSS.track.far && read(state, body, 'x') === sideLaneX(view);
    }
    return length(read(state, body, 'x') - read(state, player, 'x'), read(state, body, 'z') - read(state, player, 'z')) <= BOSS.reach;
  },

  aim(view) {
    const { state, body, player } = view;
    if (view.space === 'track') {
      // Pruh hráče; do paměti jeho život teď – skok je uhnutý, když do konce útoku neubude.
      view.remember(((memoOf(view) ^ STOMP) & ~(HP_BITS << WINDOW_SHIFT)) | (Math.min(HP_BITS, Math.max(0, healthOf(state))) << WINDOW_SHIFT) | TRACK);
      return { x: laneOf(read(state, player, 'x')) * RUNNER.laneWidth, z: read(state, body, 'z') };
    }
    // Útoky se střídají; dupnutí míří na bosse samého, salva tam, kde hráč stojí.
    const memo = memoOf(view) ^ STOMP;
    view.remember(memo);
    const target = stomping(memo) ? body : player;
    return { x: read(state, target, 'x'), z: read(state, target, 'z') };
  },

  done(view) {
    if (view.space !== 'track') return stomping(view.memo);
    // Hod trvá tik (překážka letí sama); skok skončí, když ho hráč celý minul.
    const { state, body, player } = view;
    return !stomping(view.memo) || read(state, body, 'z') + read(state, body, 'd') < read(state, player, 'z') - read(state, player, 'd');
  },

  move(view) {
    const { state, body, player, phase } = view;
    // `aim` v témže tiku už paměť zapsal; v `idle` ji založí tady.
    if (view.memo === 0 && phase === 'idle') view.remember(memoOf(view));
    if (view.space === 'track') {
      moveOnTrack(view);
      return;
    }
    if (phase === 'recover' && view.ticksLeft === TICKS.plane.recover) view.remember((view.memo & ~(HP_BITS << WINDOW_SHIFT)) | (bodyHp(state, body) << WINDOW_SHIFT));
    if (phase !== 'idle') set(state, body, 0, 0);
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
    if (view.space === 'track') {
      const throws = view.phase === 'act' && view.ticksLeft === TICKS.track.act && !stomping(view.memo) && ref.shot !== undefined;
      const thrown: ArcadeEffect[] = throws ? [{ kind: 'spawn', template: ref.shot as number, x: view.aim.x, y: SHOT.y, z: read(view.state, view.body, 'z'), vx: 0, vy: 0, vz: -BOSS.track.throw }] : [];
      return [...thrown, ...trackBlows(view, ref)];
    }
    if (view.phase !== 'act') return [];
    const elapsed = TICKS.plane.act - view.ticksLeft;
    if (!stomping(view.memo)) return elapsed % BOSS.volley === 0 && elapsed < BOSS.shots * BOSS.volley ? fireShot(view, ref) : [];
    const { state, body, player } = view;
    const near = length(read(state, player, 'x') - read(state, body, 'x'), read(state, player, 'z') - read(state, body, 'z')) <= BOSS.stomp;
    return elapsed === 0 && near ? [{ kind: 'damage', amount: 1, grace: HIT_GRACE }] : [];
  },

  // Robot arény plánuje útěk před pronásledovateli a jde k věcem bezpečnou cestou:
  // útočícímu bossovi se vyhne jako pronásledovateli, k otevřenému (a k bossovi,
  // který nese poslední krok k výhře) dojde jako k věci.
  seenAs(view) {
    if (view.space !== 'plane') return undefined;
    if (view.phase === 'telegraph' || view.phase === 'act') return 'chaser';
    if (bossOpen(view.state, view.body, view.phase, view.memo)) return 'collectible';
    return view.phase === 'idle' && lastStep(view.state, view.player) ? 'collectible' : undefined;
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
      // Při salvě se bosse nejdřív přestat dotýkat (dotek v útoku zraní), pak uhnout z přímky.
      const touching = length(rx, rz) < Math.ceil(((read(state, body, 'w') + read(state, player, 'w')) * 3) / 4) + BOSS.margin;
      if (view.phase !== 'recover' && touching) return { buttons: input.buttons, axis: arenaAxis(rx, rz) };
      const dodged = dodgeShot(view, input, recent, sinceLastShot(view, recent.length));
      if (dodged !== input || view.phase !== 'recover') return dodged;
    }
    // Okno: k bossovi a dotknout se ho.
    return bossOpen(state, body, view.phase, view.memo) ? { buttons: input.buttons, axis: arenaAxis(-rx, -rz) } : input;
  },

  // Trať: uhýbá plánovač pruhů běžce – hod jako výstřel ostřelovače, skok jako výpad flankera.
  hazard(view) {
    if (view.space !== 'track' || (view.phase !== 'telegraph' && view.phase !== 'act')) return null;
    const { state, body, player, aim, ticksLeft } = view;
    const pvz = read(state, player, 'vz');
    const box = boxOf(state, body);
    if (!stomping(view.memo)) {
      // Překážka vznikne v kroku, kdy varování přejde do útoku, v zamčeném pruhu, a letí proti hráči; ve vzduchu ji plánovač vidí sám.
      if (view.phase !== 'telegraph') return null;
      const thrown = box.z + pvz * ticksLeft;
      return (ticks) => (ticks < ticksLeft ? null : { x: aim.x, y: SHOT.y, z: thrown - BOSS.track.throw * (ticks - ticksLeft), w: SHOT.w, h: SHOT.h, d: SHOT.d });
    }
    return (ticks) => {
      const n = actTicks(view, TICKS.track.act, ticks);
      return n === 0 ? null : { ...box, x: box.x + clampTo(aim.x - box.x, RUNNER.laneSpeed * n), z: box.z + pvz * (ticks - n) - BOSS.track.charge * n };
    };
  },
};

/**
 * Boss-terč střelnice (P45C T13): hráč stojí, takže boss nedupe ani nechodí –
 * stojí, kde přišel, a do `reach` od hráče po varování (`line`, 60 tiků, každý
 * zásah o 8 méně) vypálí salvu tří výstřelů po zamčené přímce. Výstřely mají
 * roli nepřítele: hráč je sestřelí (`shot_hit`), jinak zasáhnou. Po salvě 90
 * tiků `recover`: první střela hráče bossovi ubere 1 HP (`boss_beat_hit`; terč
 * mu `shot_hit` nesebere – `spare`). Role terče: výhra střelnice (`cleared`)
 * počká na jeho pád. Paměť jako boss (HP na startu, HP na začátku `recover`).
 */
export const TURRET = {
  /** Varuje, když je hráč blíž; stojí na místě vstupu (26 m), takže hned. */
  reach: 30 * UNIT,
  /**
   * Salva: `shots` výstřelů po `volley` tikách rychlostí `shotSpeed` (střela hráče letí 400). Změřeno na
   * střelnici s jedním životem (20 semínek): do 300 robot bez profilu salvu sestřelí vždy, od 330 ne
   * (19/20, 400: 6/20) – přebíjení 75 tiků je delší než let výstřelu; 200 nechává rezervu.
   */
  shots: BOSS.shots, volley: BOSS.volley, shotSpeed: 200,
  /** HP bosse-terče (zadání 4–6). */
  hp: 5,
} as const;

/** Výstřel salvy: role nepřítele, spodní hrana 0,5 m, výška přes střelu hráče (ústí 1–1,2 m) i hráče. */
export const TURRET_SHOT: BodyInit = { ...SHOT, role: 'enemy', kind: 'turret_shot', h: 800 };

/** Výstřel salvy po zamčené přímce k cíli rychlostí `TURRET.shotSpeed`. */
function turretShot(view: BehaviourView, ref: { readonly shot?: number }): readonly ArcadeEffect[] {
  if (ref.shot === undefined) return [];
  const x = read(view.state, view.body, 'x');
  const z = read(view.state, view.body, 'z');
  const gap = Math.max(1, length(view.aim.x - x, view.aim.z - z));
  const speed = TURRET.shotSpeed;
  return [{ kind: 'spawn', template: ref.shot, x, y: TURRET_SHOT.y, z, vx: Math.trunc(((view.aim.x - x) * speed) / gap), vy: 0, vz: Math.trunc(((view.aim.z - z) * speed) / gap) }];
}

export const turret: Behaviour = {
  id: 'turret',
  telegraph: { plane: 'line', track: 'line' },
  ticks: TICKS,
  body: { ...bossBody({ role: 'enemy', kind: 'enemy', x: 0, y: 0, z: 0, w: 800, h: 1700, d: 800, solid: false }, TURRET.hp), role: 'target' },
  shot: TURRET_SHOT,

  warnTicks: boss.warnTicks,
  kindOf: () => 'line',

  ready(view) {
    const { state, body, player } = view;
    return view.space === 'plane' && length(read(state, body, 'x') - read(state, player, 'x'), read(state, body, 'z') - read(state, player, 'z')) <= TURRET.reach;
  },

  aim(view) {
    if (view.memo === 0) view.remember(memoOf(view));
    return { x: read(view.state, view.player, 'x'), z: read(view.state, view.player, 'z') };
  },

  done: () => false,

  move(view) {
    const { state, body, phase } = view;
    if (view.memo === 0 && phase === 'idle') view.remember(memoOf(view));
    if (phase === 'recover' && view.ticksLeft === TICKS[view.space].recover) view.remember((view.memo & ~(HP_BITS << WINDOW_SHIFT)) | (bodyHp(state, body) << WINDOW_SHIFT));
    set(state, body, 0, 0);
  },

  effects(view, ref): readonly ArcadeEffect[] {
    if (view.phase !== 'act') return [];
    const elapsed = TICKS[view.space].act - view.ticksLeft;
    return elapsed % TURRET.volley === 0 && elapsed < TURRET.shots * TURRET.volley ? turretShot(view, ref) : [];
  },

  // Robot střelce míří na terče a nepřátele: zavřeného bosse nevidí jako terč (střela by jen zmizela), otevřeného ano.
  seenAs: (view) => (bossOpen(view.state, view.body, view.phase, view.memo) ? undefined : 'obstacle'),

  // Hráč střelnice z místa neuhne; salvu sestřelí robot střelce sám (výstřely jsou nepřátelé).
  botStep: (_view, input) => input,
};

/**
 * Shazovač (P46B T5): boss na silnici – soupeř úseků a boss finále řízení. Silnice řízení se stáčí (osa `centerAt`
 * a šířka `halfWidthAt` z `BehaviourStep.road`), pruhy běžce kolem x = 0 (`laneOf`, `sideLaneX`) na ní nejdou.
 *
 * Jede po ose silnice před hráčem. Odkud ho hráč dojede až za varování a `lead` tiků, tam zamkne místo shozu,
 * zastaví se na něm a varuje (`ring`, `telegraph` tiků); pak shodí překážku (výstřel; stojí) a ujede dopředu. Na
 * rovince padá shoz do stopy (`minOff` od osy, na straně hráče – na druhé straně osy zbude průjezd), jinde k vnějšímu
 * kraji zatáčky; na rovinku do `wait` počká. Překážka, kterou hráč celou minul, zmizí a shazovači ubere 1 HP; poslední
 * HP = odjede (zmizí). Vlastní další shoz až po minutí předchozího místa – shazovač má na silnici nejvýš jednu svou
 * překážku a pozná ji podle polohy (= zamčený cíl); varování shazovačů se nepřekrývají (`takesTurns`). Výhru nedá –
 * trať se dál dojede do cíle. Bez silnice (jiné ovládání) jen drží tempo hráče a nevaruje nikdy.
 *
 * Obtížnost (P46B T5, 20 semínek × 8 buněk `drive.*`): `lead` 4, rychlosti úseků `STEER_FOES.speeds` – novice
 * 0,35–0,65, intermediate ≥ 0,85, boss padl v každé výhře intermediate. Při `lead` 10–20 vyhrával novice skoro vše:
 * varování robot vidí od začátku (`seenBox`) a uhne včas; obtížnost pro něj dávají rychlost a šířka v zatáčkách.
 */
export const DROPPER = {
  /** Odstup v ticích jízdy hráče: za varováním ještě `lead` tiků k překážce; stojí o `slack` dál; nejpomalejší tempo pro odstup. */
  lead: 4, slack: 4 * UNIT, minPace: 200,
  /** Dorovnání odstupu za tik (hráč jede 270–435) a přesun napříč. */
  catchUp: 400, across: 300,
  telegraph: 36,
  /** Střed shozu do stopy `minOff` od osy; u kraje zatáčky `edge` od mantinelu (kraj překážky 0,2 m od něj). */
  minOff: 500, edge: 500,
  /** Další shoz, až hráč minul předchozí místo shozu aspoň o tolik. */
  clear: 2 * UNIT,
  /**
   * Shoz do stopy hráče jen na rovince, aspoň `after` za jejím začátkem a `before` před koncem: v zatáčce by uhnutí
   * ke kraji nestihlo další schod a před zatáčkou by se řidič nevrátil na osu (robot pak narazil do mantinelu).
   * Jinde leží shoz u vnějšího kraje zatáčky (`edge` od mantinelu), mimo stopu, kterou zatáčka vede.
   */
  after: 6 * UNIT, before: 12 * UNIT,
  /** Shoz u kraje jen, když místo do stopy nezačne do `wait` dál (jinak by do stopy padal zřídka). */
  wait: 30 * UNIT,
  /**
   * Nejužší půlka silnice, kam smí shoz – od `narrowBack` před místem do `before` za ním. 1,8 m = nejužší silnice ze
   * spec (3,6 m), na které obtížnost změřil P46B T5. Zúžení okruhu ze vzorů (P46D T4, 2,6 m) by po shozu nechalo
   * průjezd jen pro přesný slalom: robot intermediate do shozu narazil v 5 z 10 her (sloučení P46B × P46D). Shoz 7 m
   * za koncem zúžení robot bez chyb v zúžení zabrzdil a zůstal stát – proto 15 m zpátky.
   */
  minHalf: 1800,
  narrowBack: 15 * UNIT,
  /**
   * Shoz aspoň tak daleko od místa shozu jiného shazovače, které hráč ještě neminul: dva shozy 3,8 m od sebe na
   * opačných stranách osy nestihl ani robot bez chyb (sloučení P46B × P46D, buňky jízdy se střelbou).
   */
  spacing: 20 * UNIT,
  /**
   * Žádný shoz vedle cíle střelby (`before` před ním) ani do `after` za ním (P46H). Varování shozu za cílem řidič vidí
   * jako překážku dřív, než k cíli dojede: uhne z jeho stopy, nevystřelí a do cíle na ose zúženého okruhu P46D narazí
   * (`drive.test` se střelbou, semínka 2, 6, 15, 17, 19; robot střílí jen do své stopy).
   */
  targetClear: { before: 2 * UNIT, after: 25 * UNIT },
  /** HP soupeře úseku (dva uhnuté shozy) a bosse (tři – měřidlo finále chce ≥ 3 zásahy). */
  hp: 2, bossHp: 3,
} as const;

/** Shozená překážka: stojí na silnici, nižší a širší než výstřel ostřelovače. */
export const DROP: BodyInit = { role: 'hazard', kind: 'road_drop', x: 0, y: 0, z: 0, w: 600, h: 500, d: 600, solid: false };

/** Shoz trvá tik (překážka pak stojí sama). */
const DROP_TICKS = { telegraph: DROPPER.telegraph, act: 1, recover: 12 } as const;

/** Odstup před hráčem, odkud shazovač varuje: hráč tam dojede za varování a `lead` tiků. */
const dropDistance = (view: BehaviourView): number => Math.max(DROPPER.minPace, read(view.state, view.player, 'vz')) * (DROPPER.telegraph + DROPPER.lead);

/** Leží `z` na rovince silnice (úsek delší než schod zatáčky), aspoň `after` za začátkem a `before` před koncem? */
function onStraight(road: SteerCourse, z: number): boolean {
  const at = road.ends.findIndex((end) => z < end);
  if (at < 1) return false;
  const near = road.ends[at - 1] as number;
  const far = road.ends[at] as number;
  return far - near > STEER_TRACK.segment && z - near >= DROPPER.after && far - z >= DROPPER.before;
}

/** Začne do `wait` za `z` místo, kde smí shoz do stopy (`onStraight`)? Pak shazovač počká na něj. */
function straightSoon(road: SteerCourse, z: number): boolean {
  for (let at = Math.max(1, road.ends.findIndex((end) => z < end)); at > 0 && at < road.ends.length; at += 1) {
    const near = road.ends[at - 1] as number;
    if (near + DROPPER.after > z + DROPPER.wait) return false;
    if ((road.ends[at] as number) - near > STEER_TRACK.segment && (road.ends[at] as number) - Math.max(z, near + DROPPER.after) >= DROPPER.before) return true;
  }
  return false;
}

/** Padl by shoz do `z` vedle živého cíle střelby (role `enemy`, doplněk `+shoot`) nebo do `targetClear.after` za ním? */
function targetNear(state: ArcadeState, z: number): boolean {
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] !== ROLE.enemy || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const past = z - (state[base + BODY.z] as number);
    if (past >= -DROPPER.targetClear.before && past <= DROPPER.targetClear.after) return true;
  }
  return false;
}

/** Živá překážka shazovače v místě jeho zamčeného cíle (předloha `shot`), nebo −1. */
function dropAt(view: BehaviourView, shot: number): number {
  const { state, aim } = view;
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    if (thrownBy(state, body, shot) && read(state, body, 'x') === aim.x && read(state, body, 'z') === aim.z) return body;
  }
  return -1;
}

export const dropper: Behaviour = {
  id: 'dropper',
  telegraph: { plane: 'ring', track: 'ring' },
  ticks: { plane: DROP_TICKS, track: DROP_TICKS },
  body: { role: 'hazard', kind: 'dropper', x: 0, y: 0, z: 0, w: 1000, h: 900, d: 1800, solid: false, hp: DROPPER.hp },
  shot: DROP,
  takesTurns: true,

  ready(view) {
    const { state, body, player } = view;
    const z = read(state, body, 'z');
    const pz = read(state, player, 'z');
    const ahead = z - pz;
    const from = dropDistance(view);
    // Vlastní další shoz až za minutým předchozím (pozná ho podle cíle); cizí varování se nepřekrývají – shozy dvou
    // shazovačů jdou po sobě aspoň o varování (slalom), nikdy vedle sebe.
    const passed = (aim: BehaviourView['aim']): boolean => pz > aim.z + DROPPER.clear;
    if (view.road === undefined || ahead < from || ahead > from + 2 * DROPPER.slack || !passed(view.aim) || (view.peers ?? []).some((peer) => peer.phase === 'telegraph')) return false;
    const at = Math.trunc(z / AIM_GRID.z) * AIM_GRID.z;
    if ((view.peers ?? []).some((peer) => !passed(peer.aim) && Math.abs(peer.aim.z - at) < DROPPER.spacing)) return false;
    // V zúžení ani těsně za ním se neshazuje (`minHalf`, `narrowBack`): shazovač počká, až bude silnice zas dost široká.
    const { road } = view;
    const narrowest = Math.min(halfWidthAt(road, at - DROPPER.narrowBack), halfWidthAt(road, at - DROPPER.narrowBack / 2), halfWidthAt(road, at), halfWidthAt(road, at + DROPPER.before));
    if (narrowest < DROPPER.minHalf) return false;
    // Ani vedle cíle střelby a těsně za ním (`targetClear`): řidič by uhnul z jeho stopy a nevystřelil.
    if (targetNear(state, at)) return false;
    return onStraight(road, at) || !straightSoon(road, at);
  },

  aim(view) {
    const { state, body, player, road } = view;
    // Místo shozu už na mřížce zamčeného cíle: osa silnice se počítá tam, kam překážka opravdu padne.
    const z = Math.trunc(read(state, body, 'z') / AIM_GRID.z) * AIM_GRID.z;
    if (road === undefined) return { x: read(state, body, 'x'), z };
    const center = centerAt(road, z);
    const before = view.aim.x - centerAt(road, view.aim.z);
    if (!onStraight(road, z)) {
      // Mimo rovinku: k vnějšímu kraji zatáčky (proti směru, kam silnice uhýbá), na rovné na druhou stranu než minule.
      const bend = Math.sign(centerAt(road, z + STEER_TRACK.segment) - centerAt(road, z - STEER_TRACK.segment));
      return { x: center + (bend !== 0 ? -bend : before > 0 ? -1 : 1) * (halfWidthAt(road, z) - DROPPER.edge), z };
    }
    // Rovinka: do stopy – `minOff` od osy, kudy řidič rovinku jede, na straně, kde hráč je; hráč na ose dostane
    // shoz na druhou stranu než minule. Na druhé straně osy zbude průjezd.
    const rel = read(state, player, 'x') - centerAt(road, read(state, player, 'z'));
    const side = Math.abs(rel) * 2 >= DROPPER.minOff ? Math.sign(rel) : before > 0 ? -1 : 1;
    return { x: center + side * DROPPER.minOff, z };
  },

  done: () => true,

  move(view) {
    const { state, body, player, phase, road } = view;
    const x = read(state, body, 'x');
    const z = read(state, body, 'z');
    // Varování: stojí na místě shozu. Jinak po ose silnice na odstup před hráčem.
    if (phase === 'telegraph') set(state, body, toward(x, view.aim.x, DROPPER.across), clampTo(view.aim.z - z, DROPPER.catchUp));
    else {
      const target = read(state, player, 'z') + dropDistance(view) + DROPPER.slack;
      set(state, body, road === undefined ? 0 : toward(x, centerAt(road, z), DROPPER.across), read(state, player, 'vz') + clampTo(target - z, DROPPER.catchUp));
    }
  },

  effects(view, ref): readonly ArcadeEffect[] {
    if (ref.shot === undefined) return [];
    const { state, body, player } = view;
    const effects: ArcadeEffect[] = view.phase === 'act' && view.ticksLeft === DROP_TICKS.act ? [{ kind: 'spawn', template: ref.shot, x: view.aim.x, y: DROP.y, z: view.aim.z, vx: 0, vy: 0, vz: 0 }] : [];
    const drop = dropAt(view, ref.shot);
    // Uhnutý shoz: překážka celá za hráčem.
    if (drop < 0 || read(state, drop, 'z') + Math.trunc(read(state, drop, 'd') / 2) >= read(state, player, 'z') - Math.trunc(read(state, player, 'd') / 2)) return effects;
    effects.push({ kind: 'despawn', body: drop }, { kind: 'hit', body, by: player, amount: 1 });
    if (bodyHp(state, body) <= 1) effects.push({ kind: 'despawn', body });
    return effects;
  },

  // Řidič uhýbá sám (`steer_bot` s `dodge`): varování vidí jako překážku v místě shozu (`seenBox`).
  botStep: (_view, input) => input,

  seenBox: (view) => (view.phase === 'telegraph' ? { x: view.aim.x, y: DROP.y, z: view.aim.z, w: DROP.w, h: DROP.h, d: DROP.d } : null),
};
