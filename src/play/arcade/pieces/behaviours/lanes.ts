/**
 * Plánovač pruhů robota běžce (P45C R2): uhnutí před chováním, které vidí i řady překážek.
 *
 * Dřívější uhnutí (`dodgeLane`) znalo jen pruh úderu – na trati s řadami posílalo hráče do bedny,
 * nebo mu bránilo uhnout z pruhu, kde bedna stála. Plánovač si z pozorování (staré `recent.length`
 * tiků) a stisků `recent` dopočítá, kde hráč je teď (cílový pruh, `x`, výška, skluz), a prohledá
 * tahy na `horizon` tiků dopředu: každých `every` tiků vlevo, vpravo, nebo nic. Skok a skluz v nich
 * dělá jako robot běžce (`runner-bot.ts`: v pruhu čeká řada s překážkou, kterou jde přeskočit či
 * podklouznout, a je dost blízko) a fyziku skoku jako jádro. Tah, po kterém hráč do konce horizontu
 * nenarazí do překážky řady ani do toho, čím chování zraní (`Hazard`: tělo ve výpadu, výstřel),
 * platí; přednost má tah robota běžce, pak zůstat v pruhu. Když neplatí žádný, vyhraje ten, který
 * vydrží nejdéle. Bez hrozby v horizontu plánovač mlčí – robot běžce hraje jako bez chování.
 *
 * Uhnout ale jde jen úderu, který hráči nechá pruh: flanker, který zamkne jediný volný pruh řady právě
 * tam, kde ho hráč dojede, zasáhne vždy (změřeno: běh s jedním životem prohrál na semínku 5 ve 35. s).
 * Proto `fairStrike` – úder na trati začne, jen když s řadami a běžícími hrozbami nezavře všechny pruhy.
 */

import { type ArcadeInput, type ArcadeObservation, type ArcadeState, BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase } from '../../contract';
import { GRAVITY } from '../../kernel';
import { RUNNER } from '../runner';
import { HOSTILE, JUMP_AT_TICKS, NO_COINS, ROW_SPAN, SLIDE_AT_TICKS, footprintsOf, hostileLanes, laneChoice, lastCoins, obstacleAction } from '../runner-bot';

/** Kvádr ve světě (střed spodní stěny, celé rozměry) – co v daném tiku zraní. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/** Kde hrozba zraní `ticks` kroků po pozorovaném stavu; `null` = v tom kroku nezraní. */
export type Hazard = (ticks: number) => Box | null;

export const LANE_PLAN = {
  /** Kroků dopředu: výpad flankera trvá nejvýš 120 tiků. */
  horizon: 120,
  /** Rozestup tahů v plánu. */
  every: 4,
  /** Plán končí tolik kroků za poslední hrozbou: reakce profilu (12) a přejezd o pruh (8) před další řadou. */
  tail: 24,
  /** Rezerva kolem hrozby napříč i podél: předpověď nezná fáze tempa ani výpadek vstupu profilu. */
  margin: 250,
  /**
   * Férový úder (`fairStrike`): řady a jiné hrozby do tolika od místa, kde hráč hrozbu míjí, se počítají k ní –
   * přejezd o pruh (8 tiků) a reakce člověka ve vrcholovém tempu.
   */
  keep: 3 * UNIT,
} as const;

type Need = 'free' | 'jump' | 'slide' | 'blocked';

interface Row {
  /** `z` první překážky řady (jako `nextRow`). */
  readonly z: number;
  /** `z` hráče, za kterým zastaralý pohled řadu minul. */
  readonly passed: number;
  /** Co pruh −1, 0, 1 žádá (jako `nextRow`). */
  readonly lanes: readonly Need[];
  /** Totéž jako stav pruhu robota běžce (`rankOf`) – plán ho čte každý krok. */
  readonly ranks: readonly number[];
}

/** Stav pruhu, jak ho čte `laneChoice`: volno < skok či skluz < zavřeno. */
const rankOf = (need: Need): number => (need === 'free' ? 0 : need === 'blocked' ? 2 : 1);
const FREE_RANKS: readonly number[] = [0, 0, 0];

interface Plan {
  readonly target: number;
  readonly x: number;
  readonly y: number;
  readonly vy: number;
  readonly slide: number;
}

const LANE_BUTTONS = BUTTON.LEFT | BUTTON.RIGHT;
const ACTION_BUTTONS = BUTTON.TAP | BUTTON.UP | BUTTON.DOWN | BUTTON.HOLD;
/** Tahy kroku plánu, kdy se smí měnit pruh (v tomhle pořadí: nejdřív zůstat), a kdy ne. */
const PRESSES = [0, -1, 1] as const;
const STAY = [0] as const;
const clampLane = (lane: number): number => Math.max(-1, Math.min(1, lane));
const pressOf = (buttons: number): number => ((buttons & BUTTON.RIGHT) !== 0 ? 1 : 0) - ((buttons & BUTTON.LEFT) !== 0 ? 1 : 0);
/** Stav plánu jako číslo: pruh, x (±10 m), výška (< 2 m), rychlost výskoku (±256), skluz (< 64) – prostý v rozsahu tratě. */
const keyOf = (plan: Plan): number => ((((plan.target + 1) * 20001 + plan.x + 10000) * 2001 + plan.y) * 512 + plan.vy + 256) * 64 + plan.slide;
/** Zasáhne hráč (`x`, `y`, šířka `w`, výška `h`) kvádr `box` s rezervou `pad` napříč? */
const hits = (box: Box, x: number, y: number, w: number, h: number, pad: number): boolean => Math.abs(x - box.x) * 2 < box.w + w + 2 * pad && y < box.y + box.h && box.y < y + h;

/** Pruhy řady z jejích překážek – stejné pravidlo jako `nextRow` robota běžce. */
function needsOf(obstacles: readonly Box[]): Need[] {
  return [-1, 0, 1].map((lane) => {
    let need: Need = 'free';
    for (const body of obstacles) {
      if (Math.abs(body.x - lane * RUNNER.laneWidth) * 2 >= body.w + RUNNER.playerW) continue;
      const action = obstacleAction(body.y, body.y + body.h);
      if (action === null || (need !== 'free' && need !== action)) return 'blocked';
      need = action;
    }
    return need;
  });
}

/** Živé překážky (role `obstacle`) se středem `z` mezi `from` a `to`. */
function obstaclesBetween(state: ArcadeState, player: number, from: number, to: number): Box[] {
  const found: Box[] = [];
  // Sloty jednou za volání: import pod vitestem čte každý přístup getterem a smyčka jde přes všechna těla.
  const first = bodyBase(0);
  const stride = bodyBase(1) - first;
  const { role: roleSlot, flags: flagsSlot, x: xSlot, y: ySlot, z: zSlot, w: wSlot, h: hSlot, d: dSlot } = BODY;
  const obstacle = ROLE.obstacle;
  const aliveBit = FLAG.alive;
  const bodies = state[HEADER.bodyCount] as number;
  for (let body = 0; body < bodies; body += 1) {
    const base = first + body * stride;
    if (body === player || state[base + roleSlot] !== obstacle || ((state[base + flagsSlot] as number) & aliveBit) === 0) continue;
    const z = state[base + zSlot] as number;
    if (z > from && z < to) found.push({ x: state[base + xSlot] as number, y: state[base + ySlot] as number, z, w: state[base + wSlot] as number, h: state[base + hSlot] as number, d: state[base + dSlot] as number });
  }
  return found;
}

/** Pruhy (bit `pruh + 1`), kde by hráč šířky `pw` kvádr `box` napříč zasáhl. */
const lanesUnder = (box: Box, pw: number): number => [-1, 0, 1].reduce((bits, lane) => (Math.abs(box.x - lane * RUNNER.laneWidth) * 2 < box.w + pw ? bits | (1 << (lane + 1)) : bits), 0);

/**
 * Férový úder na trati: v žádném z `ticks` kroků, kdy hráč (tempem `vz`) míjí hrozbu `strike`, nesmí ona spolu
 * s jinými hrozbami (`others`) a řadami do `keep` od něj zavřít všechny tři pruhy – takový zásah by nešlo minout,
 * ani člověku (flanker v jediném volném pruhu řady). Kroky počítá od stavu `state`.
 */
export function fairStrike(state: ArcadeState, player: number, strike: Hazard, others: readonly Hazard[], ticks: number): boolean {
  const p = bodyBase(player);
  const pz = state[p + BODY.z] as number;
  const vz = Math.max(1, state[p + BODY.vz] as number);
  const pw = state[p + BODY.w] as number;
  const pd = state[p + BODY.d] as number;
  const { keep } = LANE_PLAN;
  let rows: Box[] | null = null;
  for (let t = 1; t <= ticks; t += 1) {
    const box = strike(t);
    const zp = pz + vz * t;
    if (box === null || Math.abs(box.z - zp) * 2 >= box.d + pd) continue;
    let closed = lanesUnder(box, pw);
    for (const other of others) {
      const near = other(t);
      if (near !== null && Math.abs(near.z - zp) * 2 < near.d + pd + 2 * keep) closed |= lanesUnder(near, pw);
    }
    rows ??= obstaclesBetween(state, player, pz - keep - UNIT, pz + vz * ticks + keep + UNIT);
    needsOf(rows.filter((body) => Math.abs(body.z - zp) * 2 < body.d + pd + 2 * keep)).forEach((need, lane) => {
      if (need === 'blocked') closed |= 1 << lane;
    });
    if (closed === 0b111) return false;
  }
  return true;
}

/**
 * Vstup robota běžce upravený plánem pruhů (`hazards` = těla a výstřely chování na trati).
 * simplified: tempo hráče v předpovědi stálé (fáze trati ho mění o ≤ 15 %, `margin` to kryje); tahy jen každých `every` tiků.
 */
export function planLanes(observation: ArcadeObservation, hazards: readonly Hazard[], input: ArcadeInput): ArcadeInput {
  // Bez hrozby plánovač mlčí – robot běží na každém tiku, tohle je nejčastější cesta.
  if (hazards.length === 0) return input;
  const { state, player, recent } = observation;
  const { horizon, every, margin } = LANE_PLAN;
  const p = bodyBase(player);
  const lag = recent.length;
  const vz = Math.max(1, state[p + BODY.vz] as number);
  const pz = state[p + BODY.z] as number;
  const pw = state[p + BODY.w] as number;
  const pd = state[p + BODY.d] as number;
  /** `z` hráče po kroku `s` plánu (krok 0 = tah, o kterém se rozhoduje). */
  const zAt = (s: number): number => pz + vz * (lag + s + 1);

  const threats: Box[][] = [];
  const none: Box[] = [];
  let last = -1;
  for (let s = 0; s < horizon; s += 1) {
    let near = none;
    for (const hazard of hazards) {
      const box = hazard(lag + s + 1);
      if (box === null || Math.abs(box.z - zAt(s)) * 2 >= box.d + pd + 2 * margin) continue;
      if (near === none) near = [];
      near.push(box);
    }
    if (near !== none) last = s;
    threats.push(near);
  }
  if (last < 0) return input;
  // Plán jen kousek za poslední hrozbu: dál řady hraje robot běžce sám.
  const end = Math.min(horizon, last + 1 + LANE_PLAN.tail);

  // Řady, které zastaralý pohled ještě neminul, až po konec plánu.
  const far = zAt(end);
  const ahead = obstaclesBetween(state, player, pz - 2 * UNIT, far + 2 * UNIT)
    .filter((body) => body.z + (body.d + RUNNER.playerD) / 2 > pz && body.z - body.d < far)
    .sort((a, b) => a.z - b.z);
  const rows: Row[] = [];
  for (let k = 0; k < ahead.length; ) {
    const z = (ahead[k] as Box).z;
    const row: Box[] = [];
    while (k < ahead.length && (ahead[k] as Box).z - z <= ROW_SPAN) row.push(ahead[k++] as Box);
    const lanes = needsOf(row);
    rows.push({ z, passed: Math.max(...row.map((body) => body.z + (body.d + RUNNER.playerD) / 2)), lanes, ranks: lanes.map(rankOf) });
  }
  const crash: Box[][] = Array.from({ length: end }, (_, s) => ahead.filter((body) => Math.abs(body.z - zAt(s)) * 2 < body.d + pd));
  /** Řada, kterou pohled robota běžce (o `lag` starší) v kroku `s` má před sebou – nezávisí na tazích plánu. */
  const rowAt: (Row | undefined)[] = Array.from({ length: end }, (_, s) => rows.find((candidate) => candidate.passed > pz + vz * s));

  const tapped = recent.some((pressed) => (pressed.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0);
  const slid = recent.some((pressed) => (pressed.buttons & BUTTON.DOWN) !== 0);
  /** Co robot běžce v kroku `s` zmáčkne v pruhu `lane`: řada, kterou jeho pohled (o `lag` starší) má před sebou. */
  const actionAt = (lane: number, s: number, grounded: boolean, sliding: boolean): 'jump' | 'slide' | null => {
    const row = rowAt[s];
    if (row === undefined) return null;
    const need = row.lanes[lane + 1];
    const ticksTo = (row.z - (pz + vz * s)) / vz;
    if (need === 'jump' && ticksTo <= JUMP_AT_TICKS && grounded && !(s === 0 && tapped)) return 'jump';
    if (need === 'slide' && ticksTo <= SLIDE_AT_TICKS && !sliding && !(s === 0 && slid)) return 'slide';
    return null;
  };

  /** Jeden krok hráče (ovládání `runner` + jádro): tah, skok či skluz robota běžce, pohyb; `null` = náraz. */
  const { jumpVy, slideTicks, laneSpeed, laneWidth, slideH, runH } = RUNNER;
  const gravity = GRAVITY;
  const step = (plan: Plan, press: number, s: number): Plan | null => {
    const target = clampLane(plan.target + press);
    let { x, y, vy, slide } = plan;
    const action = press === 0 ? actionAt(target, s, y === 0 && vy === 0, slide > 0) : null;
    if (action === 'jump') {
      vy = jumpVy;
      slide = 0;
    } else if (action === 'slide') {
      slide = slideTicks;
      if (y > 0 || vy !== 0) vy = Math.min(vy, -jumpVy);
    } else if (slide > 0) slide -= 1;
    x += Math.max(-laneSpeed, Math.min(laneSpeed, target * laneWidth - x));
    vy -= gravity;
    y += vy;
    if (y <= 0) {
      y = 0;
      vy = 0;
    }
    const h = slide > 0 ? slideH : runH;
    for (const box of crash[s] as Box[]) if (hits(box, x, y, pw, h, 0)) return null;
    for (const box of threats[s] as Box[]) if (hits(box, x, y, pw, h, margin)) return null;
    return { target, x, y, vy, slide };
  };

  // Teď: pozorovaný hráč posunutý o stisky, které ve stavu ještě nejsou.
  let now: Plan = { target: state[p + BODY.aux0] as number, x: state[p + BODY.x] as number, y: state[p + BODY.y] as number, vy: state[p + BODY.vy] as number, slide: (state[p + BODY.aux1] as number) & 0x3f };
  for (const pressed of recent) {
    const target = clampLane(now.target + pressOf(pressed.buttons));
    let { y, vy, slide } = now;
    if ((pressed.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0 && y === 0 && vy === 0) vy = RUNNER.jumpVy;
    else if ((pressed.buttons & (BUTTON.DOWN | BUTTON.HOLD)) !== 0) slide = RUNNER.slideTicks;
    else if (slide > 0) slide -= 1;
    vy -= GRAVITY;
    y = Math.max(0, y + vy);
    if (y === 0) vy = 0;
    now = { ...now, target, x: now.x + Math.max(-RUNNER.laneSpeed, Math.min(RUNNER.laneSpeed, target * RUNNER.laneWidth - now.x)), y, vy, slide };
  }

  /**
   * Do kterého kroku nejdál vydrží některé pokračování plánu, který přežil krok `s`. Budoucnost plánu závisí jen na
   * kroku a stavu (`keyOf`), proto paměť `deepest` sdílí všechna pokračování i první tahy; hledání do hloubky končí,
   * jakmile jedno pokračování vydrží celý plán – ve volné trati hned první cestou.
   */
  const deepest = Array.from({ length: end }, () => new Map<number, number>());
  const reach = (plan: Plan, s: number): number => {
    if (s === end - 1) return s;
    const key = keyOf(plan);
    const known = (deepest[s] as Map<number, number>).get(key);
    if (known !== undefined) return known;
    let best = s;
    const next = s + 1;
    for (const press of next % every === 0 ? PRESSES : STAY) {
      if (press !== 0 && Math.abs(plan.target + press) > 1) continue;
      const moved = step(plan, press, next);
      if (moved === null) continue;
      best = Math.max(best, reach(moved, next));
      if (best === end - 1) break;
    }
    (deepest[s] as Map<number, number>).set(key, best);
    return best;
  };
  /** Do kterého kroku vydrží nejlepší plán s prvním tahem `press`; −1 = nevydrží ani první krok. */
  const lasted = (press: number): number => {
    const moved = step(now, press, 0);
    return moved === null ? -1 : reach(moved, 0);
  };

  // Tah robota běžce, když vydrží celý plán; jinak ostatní (zůstat, vlevo, vpravo) a ten, který vydrží nejdéle.
  const wanted = clampLane(now.target + pressOf(input.buttons)) - now.target;
  // Nejčastěji stačí tah robota a dál jeho vlastní volba pruhu (`laneChoice`, jako `runnerBot`): jedna cesta místo prohledávání.
  // Mince a těla, která zraní, jak je robot běžce vidí v pozorování (pohyb těl během plánu nesleduje, hrozby chování ano).
  const coins = footprintsOf(state, [ROLE.collectible]);
  const hostile = footprintsOf(state, HOSTILE);
  const own = (plan: Plan, s: number, collect: boolean): number => {
    const row = rowAt[s];
    const rowZ = row?.z ?? Number.POSITIVE_INFINITY;
    const seen = pz + vz * s;
    const status = row === undefined ? FREE_RANKS : row.ranks;
    const last = collect ? lastCoins(coins, seen, rowZ) : NO_COINS;
    return Math.sign(laneChoice(status, plan.target, rowZ, seen, vz, lag, last, hostileLanes(hostile, seen, rowZ)) - plan.target);
  };
  const holds = (first: number, collect: boolean): boolean => {
    let plan: Plan | null = now;
    for (let s = 0; s < end && plan !== null; s += 1) plan = step(plan, s === 0 ? first : own(plan, s, collect), s);
    return plan !== null;
  };
  /** Vstup s tahem `press` místo tahu robota; zůstat = skok či skluz, který pruh žádá. */
  const inputFor = (press: number): ArcadeInput => {
    const lane = press < 0 ? BUTTON.LEFT : press > 0 ? BUTTON.RIGHT : 0;
    const action = press === 0 ? actionAt(now.target, 0, now.y === 0 && now.vy === 0, now.slide > 0) : null;
    const pressed = action === 'jump' ? BUTTON.TAP : action === 'slide' ? BUTTON.DOWN : 0;
    return { buttons: (input.buttons & ~(LANE_BUTTONS | ACTION_BUTTONS)) | lane | pressed, axis: input.axis };
  };
  if (holds(wanted, true)) return input;
  // Mince plán neunese (P46B R1): robot hraje, jako by je neviděl – tah k minci přes hrozbu nedělá ani napůl.
  const plain = own(now, 0, false);
  if (holds(plain, false)) return plain === wanted ? input : inputFor(plain);
  // Při shodě vyhraje dřívější tah v pořadí: robota (bez mincí), zůstat, vlevo, vpravo.
  const order = [...new Set([plain, 0, -1, 1])].filter((press) => Math.abs(now.target + press) <= 1);
  let chosen = plain;
  let best = -2;
  for (const press of order) {
    const survived = lasted(press);
    if (survived > best) {
      best = survived;
      chosen = press;
    }
    if (best === end - 1) break;
  }
  return chosen === wanted ? input : inputFor(chosen);
}
