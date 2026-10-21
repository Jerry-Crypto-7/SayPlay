/**
 * Vytlačování z ringu (P54C T12, sumo): hrdina a soupeři jsou koule Rapieru na kulatém ringu. Kdo se středem
 * dostane za okraj, spadne: soupeř je venku (čítač `items`), hrdina ztratí život a vrátí se doprostřed. Tři kola;
 * ve třetím se ring zmenšuje.
 *
 * **Proč dvojice těl.** Rapier hýbe jen tělesy, která nejsou hráč, a do `aux0/aux1` jim píše natočení – chování
 * nepřátel (`pieces/behaviours`) tam ale nese svou fázi a zamčený cíl. Proto:
 * - hráč jádra je **pilot** (`player`, tělo 0): neviditelný, každý tik stojí tam, kde koule hrdiny, a nese směr
 *   (`aux0`) a výpad (`aux1`). Chování míří na něj, takže míří na hrdinu.
 * - hrdina je koule Rapieru (`PUSH_BODIES.hero`), kterou ovládání tlačí rychlostí.
 * - soupeř je **mysl** (tělo chování flanker, bez fyziky) a hned za ní jeho **koule** Rapieru. Mysl každý tik stojí
 *   na kouli, chování jí nastaví rychlost, kam chce, a ovládání z ní udělá zrychlení koule. Dvojice vzniká naráz
 *   (mysl, pak koule) a nikdy nezmizí – vystrčenou dvojici ovládání odstaví (`parkRivals`) –, takže koule leží vždy
 *   o slot za svou myslí (`mindOf`), i ve slotech spawnu.
 * - Fyzikální těleso nikdy nezmizí (despawn by ho v Rapieru vypnul a to rozbilo kontakty sousední koule), hrdinu
 *   vrátí ovládání dřív, než ho fyzikální fáze uvidí mrtvého.
 *
 * **Ovládání `push`.** Osa je směr pohybu z 32 (`arenaAxis`, jako `move_free`), hrdina zrychluje `accel` za tik
 * k rychlosti `speed`, bez vstupu brzdí `brake`. `TAP` = výpad: `lunge.ticks` tiků jede `lunge.speed` ve směru,
 * kam naposled šel (směr se během výpadu nemění, osa se nečte), pak zabrzdí na `lunge.settle` a `lunge.recover`
 * tiků výpad nejde; výpad, který by ho vynesl ven, skončí u okraje (`lungeOut`).
 * Soupeř zrychluje `rivalAccel` k rychlosti chování × `rivalWalk` (výpad chování × `rivalDash` s `rivalDashAccel`),
 * po výpadu couvá od hrdiny (`backOff`); u okraje ringu (`edgeGuard`) chce jen dovnitř a ven brzdí `edgeBrake`.
 * Spadnout smí jen soupeř, kterého nedávno zasáhl výpad hrdiny (`PUSH.credit`, HP = 1 + tiky); jiného lano
 * zadrží na okraji (`creditStep`) – nečinný hráč nikoho nevystrčí.
 *
 * **Pravidla.** `push_out` (tik): zasažený soupeř se středem dál než poloměr ringu je venku (HP 0, ovládání ho
 * odstaví), `items` + 1, body × kombo; hrdina za okrajem ztratí život s milostí a ovládání ho další tik postaví
 * doprostřed. `push_round` (tik): prázdný ring po `breakTicks` přivede další kolo soupeřů (místa na kruhu ze
 * semínka, daleko od hrdiny); prázdný ring po posledním kole = výhra. Ve třetím kole se poloměr za `shrinkTicks`
 * zmenší z `radius` na `shrinkTo`. Poslední život = prohra (`out_of_health`), hodiny `time_limit` = prohra.
 *
 * Pravidla žánru leží tady u ovládání a generátoru jako v `crowd.ts` a `merge-drop.ts`; `arcade/rules/` je jazyk
 * pravidel specu.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeCounter,
  type ArcadeEffect,
  type ArcadeLevel,
  type ArcadeState,
  BODY,
  BUTTON,
  type BodyInit,
  COMBO,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  HIT_GRACE,
  type ModeGeneratorPiece,
  type ModeParts,
  ROLE,
  type RulePiece,
  bodyBase,
  bodyHp,
  setBodyHp,
} from '../contract';
import { DIRECTIONS, directionOfAxis } from './arena';
import { type BehaviourRef, behaviourPhaseOf, behaviourRefSchema, stepBehaviours } from './behaviours';
import { length } from './behaviours/flanker';
import { nextMultiplier } from './rules';

export const PUSH = {
  /** Poloměr ringu (j) a kam se ve třetím kole zmenší, za kolik tiků. */
  radius: 6500,
  shrinkTo: 4200,
  shrinkTicks: 1500,
  /** Průměr koule hrdiny a soupeře. */
  hero: 1000,
  rival: 1100,
  /** Odraz koulí (‰): ring je pružný. */
  restitution: 800,
  /** Hrdina: nejvyšší rychlost (j/tik), zrychlení a brzda za tik. */
  speed: 110,
  accel: 8,
  brake: 10,
  /**
   * Výpad: rychlost, tiky výpadu a tiky, kdy další nejde. Po výpadu hrdina zabrzdí na `settle`; výpad, který by ho
   * odnesl ven (hrdina blíž okraji než `edgeStop` a jede ven), skončí dřív – sám se výpadem nevystrčí.
   */
  lunge: { speed: 240, ticks: 10, recover: 60, settle: 60, edgeStop: 900 },
  /**
   * Z ringu smí spadnout jen soupeř, kterého výpad hrdiny zasáhl (v dosahu `reach` za dotykem) nejvýš `ticks`
   * tiků zpátky; jiného u okraje lano zadrží. Nečinný hráč tak nikoho nevystrčí ani náhodou (soupeř o soupeře).
   */
  credit: { ticks: 90, reach: 400 },
  /** Soupeř: podíl rychlosti chování v chůzi a ve výpadu (‰), zrychlení v chůzi a ve výpadu, u okraje brzda ven. */
  rivalWalk: 600,
  rivalDash: 850,
  rivalAccel: 7,
  rivalDashAccel: 28,
  edgeGuard: 1500,
  edgeBrake: 18,
  /** U okraje chce soupeř dovnitř až touto rychlostí (j/tik) na samé hraně – zmenšující se ring ho nesrazí. */
  edgePull: 40,
  /** Po výpadu soupeř couvá od hrdiny touto rychlostí, dokud není tak daleko. */
  backOff: { speed: 45, range: 3000 },
  /** Chování míří do čtverce vepsaného ringu: polovina strany = poloměr × tohle (‰). */
  flankShare: 700,
  /** Intenzita chování po kolech (‰). */
  intensity: [900, 1000, 1100],
  /** Soupeři vstupují na kruhu tak daleko od středu a aspoň tak daleko od hrdiny. */
  spawnRadius: 4800,
  spawnClear: 2600,
  /** Pauza mezi koly (tiky). */
  breakTicks: 240,
  /** Body za vystrčeného soupeře × kombo. */
  points: 100,
  lives: 3,
  /** Hodiny hry (s): pod horizontem ověření (90 s), aby nečinný hráč prohrál i bez pádu. */
  seconds: 89,
  /** Soupeřů za celou hru (do tří kol) a výchozí počet. */
  rivals: { min: 3, max: 9, default: 7 },
} as const;

/** Kol je vždy tři. */
export const PUSH_ROUNDS = 3;

/** Těla úrovně: pilot 0, koule hrdiny, předloha mysli, předloha koule soupeře, pak dvojice prvního kola. */
export const PUSH_BODIES = { hero: 1, mind: 2, rival: 3, first: 4 } as const;

/** Čítače: kolo (1–3), tik začátku třetího kola, odpočet pauzy mezi koly; vystrčení soupeři jsou `items`. */
export const ROUND_COUNTER = 'ammo' satisfies ArcadeCounter;
export const SHRINK_COUNTER = 'reserve' satisfies ArcadeCounter;
export const BREAK_COUNTER = 'trigger' satisfies ArcadeCounter;

const counter = (state: ArrayLike<number>, name: ArcadeCounter): number => state[HEADER.counters + COUNTER[name]] as number;
export const roundOf = (state: ArrayLike<number>): number => counter(state, ROUND_COUNTER);
export const pushedOf = (state: ArrayLike<number>): number => counter(state, 'items');
export const breakOf = (state: ArrayLike<number>): number => counter(state, BREAK_COUNTER);

/** Pilot: směr 0–31 v `aux0`, výpad v `aux1` (> 0 tiky výpadu, < 0 −tiky do dalšího, 0 připraveno). */
export const facingOf = (state: ArrayLike<number>, player: number): number => state[bodyBase(player) + BODY.aux0] as number;
export const lungeOf = (state: ArrayLike<number>, player: number): number => state[bodyBase(player) + BODY.aux1] as number;

/** Rozdělení soupeřů do tří kol: zbytek dostanou pozdější kola (7 → 2, 2, 3). */
export const roundSizes = (rivals: number): readonly number[] => Array.from({ length: PUSH_ROUNDS }, (_, round) => Math.floor((rivals + round) / PUSH_ROUNDS));

/** Poloměr ringu v tiku `tick` stavu: ve třetím kole se od jeho začátku zmenšuje. */
export function ringAt(state: ArrayLike<number>, tick: number = state[HEADER.tick] as number): number {
  if (roundOf(state) < PUSH_ROUNDS) return PUSH.radius;
  const since = Math.max(0, tick - counter(state, SHRINK_COUNTER));
  return Math.max(PUSH.shrinkTo, PUSH.radius - Math.trunc((since * (PUSH.radius - PUSH.shrinkTo)) / PUSH.shrinkTicks));
}

const alive = (state: ArrayLike<number>, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Koule soupeře, ať je ve hře, nebo už venku: fyzikální těleso s modelem předlohy soupeře. */
const isRivalBall = (state: ArrayLike<number>, body: number): boolean =>
  body > PUSH_BODIES.rival && alive(state, body) && state[bodyBase(body) + BODY.kind] === state[bodyBase(PUSH_BODIES.rival) + BODY.kind] && ((state[bodyBase(body) + BODY.flags] as number) & FLAG.physics) !== 0;

/**
 * Soupeř ve hře: jeho koule má roli předlohy a HP aspoň 1 (nad 1 = zásah výpadem, `creditOf`). Vystrčenému
 * `push_out` vezme HP a ovládání ho další tik odstaví (`parkRivals`) – fyzikální těleso nikdy nezmizí: vypnutí
 * tělesa v Rapieru (despawn) poškodilo kontakty jiné koule (změřeno: koule bez gravitace a tření až do výbuchu
 * rychlostí).
 */
export function isRival(state: ArrayLike<number>, body: number): boolean {
  return isRivalBall(state, body) && state[bodyBase(body) + BODY.role] === state[bodyBase(PUSH_BODIES.rival) + BODY.role] && bodyHp(state as Int32Array, body) > 0;
}

/** Koule soupeřů ve hře vzestupně. */
export function rivalsOf(state: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let body = PUSH_BODIES.first; body < (state[HEADER.bodyCount] as number); body += 1) if (isRival(state, body)) out.push(body);
  return out;
}

/** Odstavení vystrčených soupeřů leží daleko za ringem, každý na svém místě (kamera tam nevidí). */
export const PARK = { z: 60 * 1000, step: 2500 } as const;

/**
 * Vystrčené soupeře (koule s HP 0, ještě v roli soupeře) odstaví: koule i mysl dostanou roli překážky (nejsou
 * soupeř ani tělo chování), stojí daleko za ringem a bez rychlosti. Sloty se tak nikdy neuvolní a koule další
 * dvojice leží zase hned za svou myslí.
 */
export function parkRivals(state: ArcadeState): void {
  const role = state[bodyBase(PUSH_BODIES.rival) + BODY.role] as number;
  for (let body = PUSH_BODIES.first; body < (state[HEADER.bodyCount] as number); body += 1) {
    if (!isRivalBall(state, body) || state[bodyBase(body) + BODY.role] !== role || bodyHp(state, body) > 0) continue;
    for (const part of [body, mindOf(body)]) {
      const base = bodyBase(part);
      state[base + BODY.role] = ROLE.obstacle;
      state[base + BODY.x] = 0;
      state[base + BODY.y] = 0;
      state[base + BODY.z] = PARK.z + body * PARK.step;
      state[base + BODY.vx] = 0;
      state[base + BODY.vy] = 0;
      state[base + BODY.vz] = 0;
    }
  }
}

/** Mysl soupeře leží hned před jeho koulí. */
export const mindOf = (rival: number): number => rival - 1;

/** Soupeř ve hře nejblíž kouli hrdiny (svědek mu připíše pád hrdiny), nebo −1. */
export function nearestRival(state: ArrayLike<number>): number {
  const hero = bodyBase(PUSH_BODIES.hero);
  let best = -1;
  let near = Number.POSITIVE_INFINITY;
  for (const rival of rivalsOf(state)) {
    const base = bodyBase(rival);
    const far = ((state[base + BODY.x] as number) - (state[hero + BODY.x] as number)) ** 2 + ((state[base + BODY.z] as number) - (state[hero + BODY.z] as number)) ** 2;
    if (far < near) {
      best = rival;
      near = far;
    }
  }
  return best;
}

/** Zbývající tiky, kdy soupeř smí spadnout (HP nad 1, `PUSH.credit`); 0 = lano ho zadrží. */
export const creditOf = (state: ArrayLike<number>, rival: number): number => Math.max(0, bodyHp(state as Int32Array, rival) - 1);

/** Spadne soupeř tento tik z ringu? Je za okrajem a výpad hrdiny ho nedávno zasáhl. */
export const fallsOut = (state: ArrayLike<number>, rival: number, ring: number): boolean => creditOf(state, rival) > 0 && outside(state, rival, ring);

/** Dotyk hrdiny a soupeře (vzdálenost středů). */
export const CONTACT = (PUSH.hero + PUSH.rival) / 2;

/** Je střed tělesa za okrajem ringu poloměru `ring`? */
export function outside(state: ArrayLike<number>, body: number, ring: number): boolean {
  const base = bodyBase(body);
  const x = state[base + BODY.x] as number;
  const z = state[base + BODY.z] as number;
  return x * x + z * z > ring * ring;
}

/** Vektor zkrácený na délku nejvýš `max`. */
export function clampVector(dx: number, dz: number, max: number): readonly [number, number] {
  const size = length(dx, dz);
  return size <= max ? [dx, dz] : [Math.trunc((dx * max) / size), Math.trunc((dz * max) / size)];
}

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z.object({ behaviours: z.array(behaviourRefSchema).min(1).max(2) }).strict();
export type PushControlParams = z.infer<typeof controlParams>;

/**
 * Výpad a směr hrdiny o jeden tik dál – táž pravidla, jaká hraje ovládání (sdílí je robot).
 * Vrací nový směr, nový stav výpadu, zda tik jede výpadem a zda je to první tik po výpadu (hrdina zabrzdí).
 */
export function lungeStep(facing: number, lunge: number, input: { readonly axis: number; readonly buttons: number }): { readonly facing: number; readonly lunge: number; readonly lunging: boolean; readonly settle: boolean } {
  const direction = directionOfAxis(input.axis);
  let next = lunge;
  let face = facing;
  if (next <= 0 && direction >= 0) face = direction;
  if (next === 0 && (input.buttons & BUTTON.TAP) !== 0) next = PUSH.lunge.ticks;
  if (next > 0) return { facing: face, lunge: next === 1 ? -PUSH.lunge.recover : next - 1, lunging: true, settle: false };
  return { facing: face, lunge: next < 0 ? next + 1 : 0, lunging: false, settle: next === -PUSH.lunge.recover };
}

/** Výpad v `x, z` směrem `facing` by hrdinu vynesl ven: je blíž okraji než `lunge.edgeStop` a jede ven. */
export function lungeOut(x: number, z: number, facing: number, ring: number): boolean {
  const dir = DIRECTIONS[facing] as { dx: number; dz: number };
  return x * x + z * z > (ring - PUSH.lunge.edgeStop) ** 2 && dir.dx * x + dir.dz * z > 0;
}

/**
 * Rychlost hrdiny po tiku: výpad jede plnou rychlostí ve směru; první tik po něm hrdina zabrzdí na `lunge.settle`
 * (výpad ho neodnese přes půl ringu); jinak zrychlení k ose, bez osy brzda.
 */
export function heroVelocity(vx: number, vz: number, axis: number, facing: number, lunging: boolean, settle = false): readonly [number, number] {
  if (lunging) {
    const dir = DIRECTIONS[facing] as { dx: number; dz: number };
    return [Math.trunc((dir.dx * PUSH.lunge.speed) / 1000), Math.trunc((dir.dz * PUSH.lunge.speed) / 1000)];
  }
  if (settle) [vx, vz] = clampVector(vx, vz, PUSH.lunge.settle);
  const direction = directionOfAxis(axis);
  const dir = direction < 0 ? null : (DIRECTIONS[direction] as { dx: number; dz: number });
  const tx = dir === null ? 0 : Math.trunc((dir.dx * PUSH.speed) / 1000);
  const tz = dir === null ? 0 : Math.trunc((dir.dz * PUSH.speed) / 1000);
  const [ax, az] = clampVector(tx - vx, tz - vz, dir === null ? PUSH.brake : PUSH.accel);
  return [vx + ax, vz + az];
}

/**
 * Přání soupeře po výpadu (fáze `recover`): couvnout od hrdiny, dokud je blíž než `backOff.range` – flanker by jinak
 * stál opřený o hrdinu a další výpad by skončil dotykem hned na začátku (nikdo by nikoho netlačil).
 */
export function backOff(x: number, z: number, heroX: number, heroZ: number): readonly [number, number] {
  const dx = x - heroX;
  const dz = z - heroZ;
  const gap = length(dx, dz);
  return gap === 0 || gap >= PUSH.backOff.range ? [0, 0] : [Math.trunc((dx * PUSH.backOff.speed) / gap), Math.trunc((dz * PUSH.backOff.speed) / gap)];
}

/** Rychlost soupeře po tiku: k přání chování (ve výpadu `dash` prudčeji), u okraje jen dovnitř a ven brzda. */
export function rivalVelocity(x: number, z: number, vx: number, vz: number, wantX: number, wantZ: number, ring: number, dash = false): readonly [number, number] {
  let dx = wantX;
  let dz = wantZ;
  const r = length(x, z);
  const edge = r > ring - PUSH.edgeGuard && r > 0;
  if (edge) {
    const outward = dx * x + dz * z;
    if (outward > 0) {
      const share = outward / (r * r);
      dx -= Math.trunc(share * x);
      dz -= Math.trunc(share * z);
    }
    const pull = Math.trunc((Math.min(PUSH.edgeGuard, r - (ring - PUSH.edgeGuard)) * PUSH.edgePull) / PUSH.edgeGuard);
    dx -= Math.trunc((x * pull) / r);
    dz -= Math.trunc((z * pull) / r);
  }
  const rate = edge && vx * x + vz * z > 0 ? PUSH.edgeBrake : dash ? PUSH.rivalDashAccel : PUSH.rivalAccel;
  const [ax, az] = clampVector(dx - vx, dz - vz, rate);
  return [vx + ax, vz + az];
}

/**
 * Zásah a lano jednoho soupeře (krok ovládání, před fyzikou): během výpadu hrdiny soupeř do `credit.reach` za
 * dotykem dostane `credit.ticks` tiků, kdy smí spadnout (HP = 1 + tiky), jinak tiky ubývají. Soupeř bez zásahu,
 * kterého fyzika vynesla za okraj (odraz o jiného soupeře), stojí zpátky na okraji bez rychlosti ven.
 */
export function creditStep(state: ArcadeState, rival: number, ring: number, lunging: boolean): void {
  const ball = bodyBase(rival);
  const hero = bodyBase(PUSH_BODIES.hero);
  const x = state[ball + BODY.x] as number;
  const z = state[ball + BODY.z] as number;
  const credit = creditOf(state, rival);
  const near = length(x - (state[hero + BODY.x] as number), z - (state[hero + BODY.z] as number)) <= CONTACT + PUSH.credit.reach;
  if (lunging && near) setBodyHp(state, rival, 1 + PUSH.credit.ticks);
  else if (credit > 0) setBodyHp(state, rival, credit);
  if (creditOf(state, rival) > 0 || x * x + z * z <= ring * ring) return;
  const r = length(x, z);
  state[ball + BODY.x] = Math.trunc((x * ring) / r);
  state[ball + BODY.z] = Math.trunc((z * ring) / r);
  const vx = state[ball + BODY.vx] as number;
  const vz = state[ball + BODY.vz] as number;
  const outward = vx * x + vz * z;
  if (outward > 0) {
    state[ball + BODY.vx] = vx - Math.trunc((outward * x) / (r * r));
    state[ball + BODY.vz] = vz - Math.trunc((outward * z) / (r * r));
  }
}

export const pushControl: ControlPiece<PushControlParams> = {
  id: 'push',
  params: controlParams,
  roles: ['player', 'thing', 'enemy'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input, params) => {
    const pilot = bodyBase(player);
    const hero = bodyBase(PUSH_BODIES.hero);
    const ring = ringAt(state);
    parkRivals(state);
    // Hrdina, kterého `push_out` vystrčil, se vrátí doprostřed bez rychlosti a bez rozjetého výpadu. Mrtvý je
    // jen mezi pravidlem a tímto krokem – fyzikální fáze ho mrtvého nikdy nevidí, takže ho Rapier nevypne.
    if (!alive(state, PUSH_BODIES.hero)) {
      state[hero + BODY.flags] = (state[hero + BODY.flags] as number) | FLAG.alive;
      for (const slot of [BODY.x, BODY.y, BODY.z, BODY.vx, BODY.vy, BODY.vz, BODY.aux0, BODY.aux1]) state[hero + slot] = 0;
      state[pilot + BODY.aux1] = 0;
    }
    let lunge = lungeStep(state[pilot + BODY.aux0] as number, state[pilot + BODY.aux1] as number, input);
    if (lunge.lunging && lungeOut(state[hero + BODY.x] as number, state[hero + BODY.z] as number, lunge.facing, ring)) lunge = { ...lunge, lunge: -PUSH.lunge.recover, lunging: false, settle: true };
    state[pilot + BODY.aux0] = lunge.facing;
    state[pilot + BODY.aux1] = lunge.lunge;
    const [vx, vz] = heroVelocity(state[hero + BODY.vx] as number, state[hero + BODY.vz] as number, input.axis, lunge.facing, lunge.lunging, lunge.settle);
    state[hero + BODY.vx] = vx;
    state[hero + BODY.vz] = vz;
    // Pilot stojí na hrdinovi a jede jeho rychlostí: jádro ho posune tam, kam Rapier hrdinu.
    state[pilot + BODY.x] = state[hero + BODY.x] as number;
    state[pilot + BODY.y] = 0;
    state[pilot + BODY.z] = state[hero + BODY.z] as number;
    state[pilot + BODY.vx] = vx;
    state[pilot + BODY.vy] = 0;
    state[pilot + BODY.vz] = vz;

    // Zásah výpadem (`PUSH.credit`) a lano: soupeř bez zásahu, kterého fyzika vynesla za okraj, se vrátí na něj.
    const rivals = rivalsOf(state);
    for (const rival of rivals) creditStep(state, rival, ring, lunge.lunging);
    // Mysli na své koule, chování (fáze a přání rychlosti), pak z přání zrychlení koulí.
    for (const rival of rivals) {
      const ball = bodyBase(rival);
      const mind = bodyBase(mindOf(rival));
      for (const slot of [BODY.x, BODY.z, BODY.vx, BODY.vz]) state[mind + slot] = state[ball + slot] as number;
      state[mind + BODY.y] = 0;
      state[mind + BODY.vy] = 0;
    }
    const intensity = PUSH.intensity[Math.max(0, Math.min(PUSH_ROUNDS, roundOf(state)) - 1)] as number;
    stepBehaviours(state, player, params.behaviours as BehaviourRef[], 'plane', intensity, Math.trunc((ring * PUSH.flankShare) / 1000));
    for (const rival of rivals) {
      const ball = bodyBase(rival);
      const mind = bodyBase(mindOf(rival));
      const phase = behaviourPhaseOf(state, mindOf(rival));
      const dash = phase === 'act';
      const share = dash ? PUSH.rivalDash : PUSH.rivalWalk;
      let wantX = Math.trunc(((state[mind + BODY.vx] as number) * share) / 1000);
      let wantZ = Math.trunc(((state[mind + BODY.vz] as number) * share) / 1000);
      if (phase === 'recover') [wantX, wantZ] = backOff(state[ball + BODY.x] as number, state[ball + BODY.z] as number, state[hero + BODY.x] as number, state[hero + BODY.z] as number);
      const [rx, rz] = rivalVelocity(state[ball + BODY.x] as number, state[ball + BODY.z] as number, state[ball + BODY.vx] as number, state[ball + BODY.vz] as number, wantX, wantZ, ring, dash);
      state[ball + BODY.vx] = rx;
      state[ball + BODY.vz] = rz;
      state[mind + BODY.vx] = rx;
      state[mind + BODY.vy] = 0;
      state[mind + BODY.vz] = rz;
    }
  },
};

// ---------------------------------------------------------------------------
// Úroveň

/** Místa vstupu `count` soupeřů na kruhu `PUSH.spawnRadius`: směry po 32 od `offset`, otočené pryč od hrdiny. */
export function spawnSpots(count: number, offset: number, heroX: number, heroZ: number): { readonly x: number; readonly z: number }[] {
  const spotsAt = (turn: number): { x: number; z: number }[] =>
    Array.from({ length: count }, (_, k) => {
      const dir = DIRECTIONS[(((offset + turn + Math.round((k * 32) / count)) % 32) + 32) % 32] as { dx: number; dz: number };
      return { x: Math.trunc((dir.dx * PUSH.spawnRadius) / 1000), z: Math.trunc((dir.dz * PUSH.spawnRadius) / 1000) };
    });
  for (let turn = 0; turn < 32; turn += 1) {
    const spots = spotsAt(turn);
    if (spots.every((spot) => (spot.x - heroX) ** 2 + (spot.z - heroZ) ** 2 >= PUSH.spawnClear ** 2)) return spots;
  }
  return spotsAt(0);
}

// Soupeř (role `enemy`: svědek z něj dělá hrozbu „rival“) nese HP 1 (ve hře); `push_out` mu ho vezme, až spadne.
const fighter = (role: 'thing' | 'enemy', kind: string, size: number, template: boolean, x = 0, z = 0): BodyInit => ({
  role, kind, x, y: 0, z, w: size, h: size, d: size, solid: false, physics: true, ball: true, restitution: PUSH.restitution, ...(role === 'enemy' ? { hp: 1 } : {}), ...(template ? { template: true } : {}),
});
const mind = (template: boolean, x = 0, z = 0): BodyInit => ({ role: 'enemy', kind: 'rival-mind', x, y: 0, z, w: PUSH.rival, h: PUSH.rival, d: PUSH.rival, solid: false, ...(template ? { template: true } : {}) });

/** Úroveň: pilot a hrdina uprostřed, předlohy mysli a koule soupeře, dvojice prvního kola na kruhu. */
export function pushLevel(sizes: readonly number[], offsets: readonly number[]): ArcadeLevel {
  const first = spawnSpots(sizes[0] as number, offsets[0] as number, 0, 0);
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: PUSH.hero, h: PUSH.hero, d: PUSH.hero, solid: false },
    fighter('thing', 'hero', PUSH.hero, false),
    mind(true),
    fighter('enemy', 'rival', PUSH.rival, true),
    ...first.flatMap((spot) => [mind(false, spot.x, spot.z), fighter('enemy', 'rival', PUSH.rival, false, spot.x, spot.z)]),
  ];
  // Vystrčení soupeři sloty nevracejí (`parkRivals`): sloty unesou obě pozdější kola.
  return { bodies, length: 0, spawnSlots: 2 * sizes.slice(1).reduce((sum, size) => sum + size, 0), counters: { [ROUND_COUNTER]: 1 } };
}

/** Díly světa (i ruční v testech): kola `sizes`, posuny míst vstupu `offsets` (jeden na kolo). */
export function pushWorldOf(sizes: readonly number[], offsets: readonly number[], lives: number): Omit<ModeParts, 'issues'> {
  const behaviours: BehaviourRef[] = [{ id: 'flanker', template: PUSH_BODIES.mind }];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return {
    control: { id: 'push', params: { behaviours } },
    bot: { id: 'push_bot', params: {} },
    level: pushLevel(sizes, offsets),
    rules: [
      { id: 'push_out', params: { points: PUSH.points } },
      { id: 'push_round', params: { sizes: [...sizes], offsets: [...offsets] } },
      { id: 'out_of_health', params: {} },
      { id: 'time_limit', params: { seconds: PUSH.seconds } },
      // Pilulka postupu HUD (`collectNeed`) čte cíl z `finish_collected`: vystrčení soupeři. Tělo cíle svět nemá, nevystřelí.
      { id: 'finish_collected', params: { need: total } },
    ],
    health: lives,
  };
}

/**
 * Tvrzení „hratelné z konstrukce“: tři kola po 1–3 soupeřích, soupeři vstupují mimo pás u okraje (v něm by hned
 * brzdili) a daleko od středu, kde hrdina začíná a kam se vrací, a ring se zmenší dřív, než dojdou hodiny.
 */
export function checkPush(sizes: readonly number[]): string[] {
  const issues: string[] = [];
  if (sizes.length !== PUSH_ROUNDS) issues.push(`${sizes.length} rounds instead of ${PUSH_ROUNDS}`);
  if (sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 3)) issues.push('a round brings outside 1–3 rivals');
  if (PUSH.spawnRadius > PUSH.radius - PUSH.edgeGuard) issues.push('rivals would enter inside the edge guard of the ring');
  if (PUSH.spawnRadius < PUSH.spawnClear) issues.push('a rival could enter on top of the hero in the middle');
  if (PUSH.shrinkTicks >= PUSH.seconds * ARCADE_HZ) issues.push('the ring would not finish shrinking before the clock');
  return issues;
}

const generatorParams = z.object({ rivals: z.int().min(PUSH.rivals.min).max(PUSH.rivals.max).optional() }).strict();
export type PushParams = z.infer<typeof generatorParams>;

/** Posuny míst vstupu tří kol ze semínka (stream rozvržení). */
export function pushOffsets(seed: number): number[] {
  const rng = createCompileRng(seed);
  return Array.from({ length: PUSH_ROUNDS }, () => rng.int(0, 31));
}

export function pushParts(seed: number, params: PushParams, health: number | undefined): ModeParts {
  const sizes = roundSizes(params.rivals ?? PUSH.rivals.default);
  return { ...pushWorldOf(sizes, pushOffsets(seed), health ?? PUSH.lives), issues: checkPush(sizes) };
}

export const pushRing: ModeGeneratorPiece<PushParams> = {
  id: 'push_ring',
  params: generatorParams,
  roles: ['player', 'thing', 'enemy'],
  cost: (params) => ({ bodies: 4 + 2 * (params.rivals ?? PUSH.rivals.default), rules: 5 }),
  generate: (seed, params) => pushLevel(roundSizes(params.rivals ?? PUSH.rivals.default), pushOffsets(seed)),
  parts: pushParts,
};

// ---------------------------------------------------------------------------
// Pravidla

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);

const outParams = z
  .object({
    points: z.int().min(1).max(1000),
    /** Počítadlo komba (P46C T3, `withCombo`); bez něj body bez násobiče. */
    combo: index.optional(),
  })
  .strict();

/**
 * Pád z ringu (tik, po fyzice): soupeř se středem za okrajem, kterého nedávno zasáhl výpad hrdiny (`fallsOut`),
 * přijde o HP (je venku – ovládání ho další tik
 * odstaví), `items` + 1 a body × kombo (pády téhož tiku jdou v kombu za sebou); hrdina za okrajem ztratí život
 * s vteřinou milosti a zmizí – ovládání ho další tik postaví doprostřed.
 */
export const pushOutRule: RulePiece<z.infer<typeof outParams>> = {
  id: 'push_out',
  params: outParams,
  roles: ['player', 'thing', 'enemy'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const ring = ringAt(state);
    const effects: ArcadeEffect[] = [];
    let multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo);
    for (const rival of rivalsOf(state)) {
      if (!fallsOut(state, rival, ring)) continue;
      effects.push({ kind: 'hit', body: rival, by: player, amount: bodyHp(state, rival) }, { kind: 'count', counter: 'items', amount: 1 }, { kind: 'score', amount: params.points * multiplier });
      if (params.combo !== undefined) {
        effects.push({ kind: 'combo', body: params.combo, multiplier });
        multiplier = Math.min(COMBO.max, multiplier + 1);
      }
    }
    if (alive(state, PUSH_BODIES.hero) && outside(state, PUSH_BODIES.hero, ring)) effects.push({ kind: 'damage', amount: 1, grace: HIT_GRACE }, { kind: 'despawn', body: PUSH_BODIES.hero });
    return effects;
  },
};

const roundParams = z
  .object({
    sizes: z.array(z.int().min(1).max(3)).length(PUSH_ROUNDS),
    offsets: z.array(z.int().min(0).max(31)).length(PUSH_ROUNDS),
  })
  .strict();

/**
 * Kola (tik): dokud je na ringu soupeř, který tento tik nespadl, nic. Prázdný ring po posledním kole = výhra;
 * jinak pauza `breakTicks` (odpočet v `trigger`) a pak dvojice dalšího kola na kruhu pryč od hrdiny. Začátek
 * třetího kola si zapíše tik do `reserve` – od něj se ring zmenšuje.
 */
export const pushRoundRule: RulePiece<z.infer<typeof roundParams>> = {
  id: 'push_round',
  params: roundParams,
  roles: ['player', 'enemy'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const ring = ringAt(state);
    if (rivalsOf(state).some((rival) => !fallsOut(state, rival, ring))) return [];
    const round = roundOf(state);
    if (round >= PUSH_ROUNDS) return [{ kind: 'win' }];
    const wait = breakOf(state);
    if (wait === 0) return [{ kind: 'count', counter: BREAK_COUNTER, amount: PUSH.breakTicks }];
    if (wait > 1) return [{ kind: 'count', counter: BREAK_COUNTER, amount: -1 }];
    const tick = state[HEADER.tick] as number;
    const pilot = bodyBase(player);
    const spots = spawnSpots(params.sizes[round] as number, params.offsets[round] as number, state[pilot + BODY.x] as number, state[pilot + BODY.z] as number);
    const effects: ArcadeEffect[] = [
      { kind: 'count', counter: BREAK_COUNTER, amount: -1 },
      { kind: 'count', counter: ROUND_COUNTER, amount: 1 },
    ];
    if (round + 1 === PUSH_ROUNDS) effects.push({ kind: 'count', counter: SHRINK_COUNTER, amount: tick - counter(state, SHRINK_COUNTER) });
    // Mysl, pak koule: koule tak dostane slot hned za svou myslí (`mindOf`).
    for (const spot of spots) {
      effects.push({ kind: 'spawn', template: PUSH_BODIES.mind, x: spot.x, y: 0, z: spot.z, vx: 0, vy: 0, vz: 0 });
      effects.push({ kind: 'spawn', template: PUSH_BODIES.rival, x: spot.x, y: 0, z: spot.z, vx: 0, vy: 0, vz: 0 });
    }
    return effects;
  },
};

export const PUSH_RULES = { push_out: pushOutRule, push_round: pushRoundRule } as const;
