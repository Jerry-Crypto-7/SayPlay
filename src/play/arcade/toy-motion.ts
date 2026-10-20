/**
 * Hračkový pohyb těla (P45D T4). Čistá funkce: z pohledu těla po tiku a z třídy
 * těla (`src/assets/catalog-motion.json`) spočítá pózu, kterou scéna přičte ke
 * kreslené skupině, dílům a deformaci (`components/play/arcade/toy/applyToy.ts`).
 * Chůze je poskok s kolébáním podle ujeté dráhy, skok natažení, dopad zmáčknutí,
 * útok nápřah – výpad – dojezd, zásah cuknutí a kymácení, smrt převržení, výhra
 * jedna oslava, nesení záklon. Stojící tělo bez události se smí hýbat samo
 * (výjimka `docs/brand/REPO-NOTES.md` → „Pohyb ve 3D scéně“, 19. 10. 2026):
 * nečinný dech a rozhlížení (`ToyIdle`, P54B T6), které `prefers-reduced-motion`
 * vypne. Čte jen stav a tik (i s podílem `tick + alpha`), nikdy
 * hodiny ani náhodu, a do hashovaného stavu nic nepíše.
 */

import { strike } from '@/components/play/arcade/hero-action/actions';
import { HIT_S, FALL_S, fallOf, headingOf, jumpStretchOf, landSquashOf, recoilOf, wobbleOf } from '@/components/play/arcade/characterMotion';
import { hash } from '@/components/play/arcade/look/ground';

import { ARCADE_HZ, BODY, COUNTER, FLAG, HEADER, ROLE, RUN_STATE, UNIT, bodyBase, targetStateOf } from './contract';
import { type MotionView, viewOf } from './motion';

export const BODY_CLASSES = ['biped', 'quadruped', 'flyer', 'swimmer', 'vehicle', 'prop'] as const;
/** Třída těla modelu – jak se hýbe (P45D T2, `scripts/p45d/motion-class.mjs`). */
export type BodyClass = (typeof BODY_CLASSES)[number];

/** `MotionView` a k tomu, co hračkový pohyb čte navíc. */
export interface ToyView extends MotionView {
  /** Hráč vyhrál běh. */
  readonly won: boolean;
  /** Hráč nese věc (`HEADER.held`, totéž, co čte podmínka `notHolding`). */
  readonly carrying: boolean;
  /** Hráč vystřelil nebo udeřil; nepřítel u hráče v tiku, kdy hráči ubyl život. */
  readonly attack: boolean;
  /** Změna směru pohybu za tik (rad, kladná = doleva); 0, když tělo stojí. */
  readonly turn: number;
  /** Cíl posunul svůj stav (dveře, víko) – díl se otevře. */
  readonly opened: boolean;
  /** Běh skončil (výhra, prohra): stav stojí a tik kresby běží dál (`toyTickOf`, P45D T22). Chybí = běží. */
  readonly ended?: boolean;
}

/**
 * Délky a posuny v podílech výšky těla, úhly v radiánech; `pitch` > 0 předklon,
 * `roll` > 0 úklon doleva, `squash` > 0 zmáčknutí / < 0 natažení, `lunge` > 0
 * výpad po lokálním +z. `fall`, `cheer`, `flash`, `open` jsou 0..1, `flap`,
 * `sway`, `stride` −1..1 (deformace křídel, ocasu, nohou), `wheel` úhel kol.
 * Zbylá pole jsou paměť pro další snímek.
 */
export interface ToyPose {
  readonly hop: number;
  readonly roll: number;
  readonly pitch: number;
  readonly yaw: number;
  readonly squash: number;
  readonly lunge: number;
  readonly recoil: number;
  readonly wobble: number;
  readonly fall: number;
  readonly cheer: number;
  readonly flash: number;
  readonly flap: number;
  readonly wheel: number;
  readonly sway: number;
  readonly stride: number;
  readonly open: number;
  readonly grounded: boolean;
  readonly airAt: number;
  readonly landedAt: number;
  readonly hitAt: number;
  readonly attackAt: number;
  readonly diedAt: number;
  readonly wonAt: number;
  readonly openedAt: number;
  /** Tik, kdy póza poprvé viděla konec běhu. */
  readonly endedAt: number;
  /** Tik, od kdy tělo stojí bez události – od něj se rozjede nečinná vrstva. */
  readonly calmAt: number;
  /** Ujetá dráha (m) – fáze kroku, mávnutí a kol. */
  readonly travel: number;
  /** Tik posledního snímku (i s podílem). */
  readonly at: number;
}

/** Pod touhle rychlostí (m/s) tělo stojí; od `GAIT_FULL` jde krok naplno. */
const RUN_MIN = 0.5;
const GAIT_FULL = 3;
/** Délka jednoho kroku (m) a jak ho zkrátí nesení. */
const STEP_M: Readonly<Record<BodyClass, number>> = { biped: 0.8, quadruped: 0.6, prop: 0.7, flyer: 1, swimmer: 1.6, vehicle: 0.9 };
const CARRY_STEP = 0.7;
const CARRY_LEAN = 0.18;
const HOP: Readonly<Record<BodyClass, number>> = { biped: 0.08, quadruped: 0.05, prop: 0.16, flyer: 0, swimmer: 0, vehicle: 0 };
const ROLL: Readonly<Record<BodyClass, number>> = { biped: 0.14, quadruped: 0, prop: 0.1, flyer: 0, swimmer: 0, vehicle: 0 };
const WALK_LEAN = 0.08;
const ROCK_PITCH = 0.12;
const SWIM_YAW = 0.12;
const SPRING = 0.03;
const WHEEL_R = 0.3;
/** Náklon do zatáčky (rad na rad/s) a jeho strop. */
const BANK = 0.12;
const MAX_BANK = 0.3;
/** Útok: nápřah – výpad – dojezd (`strike`), přehnaně a krátce. */
const ATTACK_S = 0.36;
const LUNGE = 0.3;
const ATTACK_PITCH = 0.25;
/** Oslava: tři poskoky po `duration-celebrate` (420 ms) s jednou otočkou; otevření dílu stejně dlouho. */
const CHEER_HOP_S = 0.42;
const CHEER_HOPS = 3;
const OPEN_S = 0.42;
/** Nepřítel do téhle vzdálenosti (jednotky jádra) od hráče je ten, kdo udeřil. */
const REACH = 3 * UNIT;

/**
 * Nečinná vrstva (P54B T6) těla `index` ve hře se semínkem `seed`: z nich fáze a perioda
 * dechu a rozhlédnutí, ať dvě těla nedýchají v jednom rytmu. Scéna ji předá jen statickému
 * modelu – riggovaná postava hraje klip `idle` a vrstvu nedostane.
 */
export interface ToyIdle {
  readonly index: number;
  readonly seed: number;
}

/** Síla celé nečinné vrstvy: 1 = hodnoty níž, 0 = stojící tělo stojí. Jediné místo, kde ji ztlumit. */
const IDLE_STRENGTH = 1;
/** Dech bipeda a čtyřnožce: zmáčknutí ±2 % výšky, perioda 2,5–3,5 s podle těla. */
const BREATH = 0.02;
const BREATH_MIN_S = 2.5;
const BREATH_SPAN_S = 1;
/** Rozhlédnutí: ±15° jednou za 4–7 s podle těla, střídavě na obě strany; otočka, pohled, otočka zpět. */
const GLANCE = (15 * Math.PI) / 180;
const GLANCE_MIN_S = 4;
const GLANCE_SPAN_S = 3;
const GLANCE_TURN_S = 0.4;
const GLANCE_HOLD_S = 0.8;
/** Letec se vznáší ±4 % výšky v rytmu dechu, plavec vlní ocasem a ploutvemi dvakrát rychleji. */
const HOVER = 0.04;
const SWIM_WAVE = 0.3;
/** Po zastavení nebo události se vrstva rozjede za tolik sekund – bez skoku do půlky rozhlédnutí. */
const IDLE_FADE_S = 0.6;

const NEVER = -1_000_000;
const AT_REST = {
  hop: 0, roll: 0, pitch: 0, yaw: 0, squash: 0, lunge: 0, recoil: 0, wobble: 0, fall: 0,
  cheer: 0, flash: 0, flap: 0, wheel: 0, sway: 0, stride: 0, open: 0,
} as const;
const REST: ToyPose = {
  ...AT_REST, grounded: true, airAt: NEVER, landedAt: NEVER, hitAt: NEVER, attackAt: NEVER,
  diedAt: NEVER, wonAt: NEVER, openedAt: NEVER, endedAt: NEVER, calmAt: NEVER, travel: 0, at: 0,
};

const HOSTILE: ReadonlySet<number> = new Set([ROLE.enemy, ROLE.chaser]);

const metresPerSecond = (perTick: number): number => (perTick * ARCADE_HZ) / UNIT;
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const easeInOut = (u: number): number => u * u * (3 - 2 * u);
/** Nula, ať do pózy nepronikne −0 (scéna ji porovnává s klidem). */
const clean = (value: number): number => (value === 0 ? 0 : value);

/** Nejbližší živý nepřítel do `REACH` od hráče v tiku, kdy hráči ubyl život; −1 = nikdo. */
function strikerOf(state: Int32Array, prev: Int32Array): number {
  const health = HEADER.counters + COUNTER.health;
  if ((state[health] as number) >= (prev[health] as number)) return -1;
  const count = state[HEADER.bodyCount] as number;
  let player = -1;
  for (let index = 0; index < count && player < 0; index += 1) if ((state[bodyBase(index) + BODY.role] as number) === ROLE.player) player = index;
  if (player < 0) return -1;
  const px = state[bodyBase(player) + BODY.x] as number;
  const pz = state[bodyBase(player) + BODY.z] as number;
  let best = -1;
  let bestDistance = REACH;
  for (let index = 0; index < count; index += 1) {
    const base = bodyBase(index);
    if (!HOSTILE.has(state[base + BODY.role] as number) || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const distance = Math.hypot((state[base + BODY.x] as number) - px, (state[base + BODY.z] as number) - pz);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Změna směru pohybu po vodorovné rovině za poslední tik. */
function turnOf(state: Int32Array, prev: Int32Array, base: number): number {
  const minimum = (RUN_MIN * UNIT) / ARCADE_HZ;
  const [vx, vz, px, pz] = [state[base + BODY.vx], state[base + BODY.vz], prev[base + BODY.vx], prev[base + BODY.vz]] as number[];
  if (Math.hypot(vx!, vz!) < minimum || Math.hypot(px!, pz!) < minimum) return 0;
  const change = headingOf(vx!, vz!) - headingOf(px!, pz!);
  return clean(Math.atan2(Math.sin(change), Math.cos(change)));
}

/** Pohled těla pro hračkový pohyb – nad `viewOf`, jen čte. */
export function toyViewOf(state: Int32Array, prev: Int32Array, index: number): ToyView {
  const view = viewOf(state, prev, index);
  const base = bodyBase(index);
  const role = state[base + BODY.role] as number;
  const player = role === ROLE.player;
  return {
    ...view,
    won: player && (state[HEADER.runState] as number) === RUN_STATE.won,
    carrying: player && view.alive && (state[HEADER.held] as number) > 0,
    attack: player ? view.shot : HOSTILE.has(role) && view.alive && strikerOf(state, prev) === index,
    turn: turnOf(state, prev, base),
    opened: role === ROLE.target && targetStateOf(state, index) > 0,
    ended: (state[HEADER.runState] as number) !== RUN_STATE.running,
  };
}

/** Krok, mávnutí, vlnění a kola podle třídy; `gait` 0..1 je síla chůze. */
function gaitOf(body: BodyClass, view: ToyView, travel: number, gait: number) {
  const phase = travel / (STEP_M[body] * (view.carrying ? CARRY_STEP : 1));
  const step = Math.sin(Math.PI * phase);
  const cycle = Math.sin(2 * Math.PI * phase);
  const bank = clamp(-view.turn * ARCADE_HZ * BANK, MAX_BANK);
  switch (body) {
    case 'biped':
    case 'prop':
      return { hop: HOP[body] * gait * Math.abs(step), roll: ROLL[body] * gait * step, pitch: WALK_LEAN * gait, stride: gait * step };
    case 'quadruped':
      return { hop: HOP.quadruped * gait * Math.abs(step), pitch: ROCK_PITCH * gait * step, stride: gait * step };
    case 'flyer':
      return { flap: gait * cycle, roll: gait * bank };
    case 'swimmer':
      return { sway: gait * cycle, yaw: SWIM_YAW * gait * cycle };
    case 'vehicle':
      return { squash: SPRING * gait * cycle, roll: gait * bank };
  }
}

/** Kam rozhlédnutí došlo `u` s po začátku okna: otočka, pohled, otočka zpět; mimo okno 0. */
function glanceOf(u: number): number {
  if (u < GLANCE_TURN_S) return easeInOut(u / GLANCE_TURN_S);
  if (u < GLANCE_TURN_S + GLANCE_HOLD_S) return 1;
  return easeInOut(clamp01(1 - (u - GLANCE_TURN_S - GLANCE_HOLD_S) / GLANCE_TURN_S));
}

/**
 * Nečinná vrstva stojícího těla v tiku `tick`: dech a rozhlédnutí, vznášení, vlnění; předmět
 * a vozidlo stojí. Periody a fáze jsou hash indexu těla a semínka hry, `weight` 0..1 ji
 * rozjíždí po zastavení.
 */
function idleOf(body: BodyClass, { index, seed }: ToyIdle, tick: number, weight: number) {
  const t = tick / ARCADE_HZ;
  const breathS = BREATH_MIN_S + BREATH_SPAN_S * hash(4 * index, seed);
  const breath = t / breathS + hash(4 * index + 1, seed);
  switch (body) {
    case 'biped':
    case 'quadruped': {
      const glanceS = GLANCE_MIN_S + GLANCE_SPAN_S * hash(4 * index + 2, seed);
      const cycle = t / glanceS + hash(4 * index + 3, seed);
      const round = Math.floor(cycle);
      const side = round % 2 === 0 ? 1 : -1;
      return { squash: weight * BREATH * Math.sin(2 * Math.PI * breath), yaw: weight * side * GLANCE * glanceOf((cycle - round) * glanceS) };
    }
    case 'flyer':
      return { hop: weight * HOVER * Math.sin(2 * Math.PI * breath) };
    case 'swimmer':
      return { sway: weight * SWIM_WAVE * Math.sin(4 * Math.PI * breath) };
    default:
      return {};
  }
}

/**
 * Platí události a rychlost stavu v tiku `tick`? Po konci běhu stav stojí a tik kresby běží
 * dál (`toyTickOf`): zásah, útok a rychlost posledního tiku platí jen v tiku konce – jinak by
 * se zásah spouštěl každý další tik a tělo kráčelo na místě (P45D T22).
 */
export const toyEventsLive = (view: ToyView, previous: ToyPose | null, tick: number): boolean =>
  !view.ended || previous === null || previous.endedAt === NEVER || Math.floor(tick) === previous.endedAt;

/**
 * Póza těla pro tik `tick` (smí mít podíl). `previous` je póza minulého snímku
 * téhož těla; `reduced` = `prefers-reduced-motion`: žádná amplituda, stav se
 * ukáže okamžitě – mrtvý leží, otevřený díl je otevřený, zásah jen blikne.
 * S `idle` stojící tělo bez události dýchá a rozhlíží se (P54B T6); pohyb
 * i událost vrstvu utnou, `reduced` ji vypne.
 */
export function toyPoseOf(view: ToyView, body: BodyClass, previous: ToyPose | null, tick: number, reduced: boolean, idle?: ToyIdle): ToyPose {
  const before = previous ?? { ...REST, at: tick };
  // Událost patří celému tiku: další snímek téhož tiku ji nezačne znovu.
  const now = Math.floor(tick);
  const since = (at: number): number => (tick - at) / ARCADE_HZ;
  const endedAt = !view.ended ? NEVER : before.endedAt === NEVER ? now : before.endedAt;
  const live = toyEventsLive(view, before, tick);
  const airAt = !view.grounded && before.grounded ? now : before.airAt;
  const landedAt = view.grounded && !before.grounded ? now : before.landedAt;
  const hitAt = view.hit && live ? now : before.hitAt;
  const attackAt = view.attack && live ? now : before.attackAt;
  const diedAt = view.alive ? NEVER : before.diedAt === NEVER ? now : before.diedAt;
  const wonAt = !view.won ? NEVER : before.wonAt === NEVER ? now : before.wonAt;
  const openedAt = !view.opened ? NEVER : before.openedAt === NEVER ? now : before.openedAt;

  const free = body === 'flyer' || body === 'swimmer';
  const speed = live ? Math.hypot(metresPerSecond(view.vx), free ? metresPerSecond(view.vy) : 0, metresPerSecond(view.vz)) : 0;
  const travel = before.travel + speed * (Math.max(0, tick - before.at) / ARCADE_HZ);
  const memory = { grounded: view.grounded, airAt, landedAt, hitAt, attackAt, diedAt, wonAt, openedAt, endedAt, calmAt: NEVER, travel, at: tick };

  const hit = since(hitAt) / HIT_S;
  const flash = hit < 1 ? 1 - hit : 0;
  const open = view.opened ? (reduced ? 1 : easeInOut(clamp01(since(openedAt) / OPEN_S))) : 0;
  if (!view.alive) {
    const down = since(diedAt);
    // `fallOf` po dopadu odskočí; hračka zůstane ležet, ať pád jde jen k zemi.
    return { ...AT_REST, ...memory, flash, open, fall: reduced || down >= FALL_S ? 1 : fallOf(down) };
  }
  if (reduced) return { ...AT_REST, ...memory, flash, open };

  const gait = (free || view.grounded) && speed > RUN_MIN ? clamp01((speed - RUN_MIN) / (GAIT_FULL - RUN_MIN)) : 0;
  const air = !view.grounded && !free ? -jumpStretchOf(since(airAt)) : landSquashOf(since(landedAt));
  const attack = since(attackAt) / ATTACK_S;
  const swing = attack < 1 ? strike(attack) : 0;
  const cheering = since(wonAt) / (CHEER_HOP_S * CHEER_HOPS);
  const cheer = view.won && cheering < 1 ? Math.abs(Math.sin(CHEER_HOPS * Math.PI * cheering)) : 0;
  // Stojí bez události: nejde, neletí, nedopadá, neútočí, nedoznívá zásah, neslaví, neotevírá se.
  const calm = gait === 0 && (free || view.grounded) && air === 0 && attack >= 1 && hit >= 1 && !(view.won && cheering < 1) && !(view.opened && since(openedAt) < OPEN_S);
  const calmAt = !calm ? NEVER : before.calmAt === NEVER ? now : before.calmAt;
  const settled = IDLE_STRENGTH * easeInOut(clamp01(since(calmAt) / IDLE_FADE_S));
  // Chůze, nebo nečinná vrstva stojícího těla – nikdy obojí.
  const walk: Partial<Record<keyof typeof AT_REST, number>> = gait > 0 ? gaitOf(body, view, travel, gait) : calm && idle !== undefined ? idleOf(body, idle, tick, settled) : {};

  return {
    hop: clean(walk.hop ?? 0),
    roll: clean(walk.roll ?? 0),
    pitch: clean((walk.pitch ?? 0) + ATTACK_PITCH * swing - (view.carrying ? CARRY_LEAN : 0)),
    yaw: clean((walk.yaw ?? 0) + (cheer > 0 ? 2 * Math.PI * easeInOut(cheering) : 0)),
    squash: clean((walk.squash ?? 0) + air),
    lunge: clean(LUNGE * swing),
    recoil: hit < 1 ? recoilOf(hit) : 0,
    wobble: hit < 1 ? clean(wobbleOf(hit)) : 0,
    fall: 0,
    cheer,
    flash,
    flap: clean(walk.flap ?? 0),
    wheel: body === 'vehicle' ? (travel / WHEEL_R) % (2 * Math.PI) : 0,
    sway: clean(walk.sway ?? 0),
    stride: clean(walk.stride ?? 0),
    open,
    ...memory,
    calmAt,
  };
}
