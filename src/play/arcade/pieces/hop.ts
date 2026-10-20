/**
 * Přeskákání silnice (P54C T9): hrdina skáče po polích mřížky přes silnice s auty, řeky s kládami
 * a koleje s vlakem (Crossy Road, Frogger). Cíl = dojít `rows` řad. Trať a její kontrola: `hop-course.ts`.
 *
 * **Ovládání `hop`.** `TAP`/`UP` = skok o pole vpřed, `LEFT`/`RIGHT` (nebo osa) o pole do strany, `DOWN` zpět.
 * Skok trvá `HOP.hopTicks` tiků, vstup během skoku se nečte. Skok vpřed a vzad dopadne na střed sloupce,
 * kterému je hrdina nejblíž (z klády se tak vrátí do mřížky). Stojí-li hrdina na kládě, kláda ho veze.
 * Tělo hrdiny: `aux0` = zbývající tiky skoku | směr << 5 | cílový sloupec << 7, `aux1` = tiky bez skoku.
 *
 * **Provoz** vysílá pravidlo `hop_traffic`: vozidlo (kládu, vlak) z předlohy každých `period` tiků za hranou pole,
 * odebere ho za druhou hranou. Vlak vyjede `HOP.trainLead` tiků před hranou pole (scéna ukáže varování).
 *
 * **Pravidla.** Srážka s autem nebo vlakem (`hit`, kontakt) a dopad do vody bez klády nebo odvoz kládou za
 * hranu pole (`hop_cross`) = život a návrat na poslední trávu (`checkpoint`), vteřina milosti. Nová nejvzdálenější
 * řada = čítač `items`, body × kombo. Nečinnost `HOP.eagle` tiků = orel (prohra), takže nečinný hráč prohraje.
 */

import { z } from 'zod';

import { ARCADE_LIMITS, AXIS_MAX, type ArcadeEffect, type ArcadeInput, BODY, BUTTON, COUNTER, type ControlPiece, FLAG, HEADER, HIT_GRACE, type ModeGeneratorPiece, type ModeParts, ROLE, type RulePiece, START_LIVES, bodyBase } from '../contract';
import { DIR, HOP, HOP_BODIES, HOP_HALF, HOP_STEP, type HopLane, type HopLayout, type HopParams, ROW, checkHopLevel, colOf, colX, grassRows, hopLayout, hopLevel, hopParams, laneX, rowOf } from './hop-course';
import { nextMultiplier } from './rules';

export * from './hop-course';

/** Osa, od které se počítá skok do strany. */
const AXIS_SIDE = AXIS_MAX / 2;
/** `aux0` hrdiny: zbývající tiky skoku (5 bitů, skok nejvýš 31 tiků), směr (2 bity) a cílový sloupec. */
const REM_MASK = 31;
const DIR_SHIFT = 5;
const COL_SHIFT = 7;
const IDLE_CAP = 10 * HOP.eagle;

const mod = (a: number, b: number): number => ((a % b) + b) % b;

// ---------------------------------------------------------------------------
// Ovládání

/** Hrdina mezi tiky: poloha, rychlost, skok a tiky bez skoku. */
export interface Hopper {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Zbývající tiky skoku (0 = stojí). */
  rem: number;
  dir: number;
  /** Cílový sloupec skoku. */
  col: number;
  idle: number;
}

/** Kam vstup chce skočit (`DIR`), nebo −1. Vpřed má přednost. */
export function hopWanted(input: ArcadeInput): number {
  if ((input.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0) return DIR.forward;
  if ((input.buttons & BUTTON.LEFT) !== 0 || input.axis <= -AXIS_SIDE) return DIR.left;
  if ((input.buttons & BUTTON.RIGHT) !== 0 || input.axis >= AXIS_SIDE) return DIR.right;
  if ((input.buttons & BUTTON.DOWN) !== 0) return DIR.back;
  return -1;
}

/**
 * Jeden krok ovládání bez integrace: rychlost a stav skoku. `carry` = rychlost klády pod hrdinou (0 mimo kládu).
 * Sdílí ho ovládání i robot (předpověď vlastní polohy), takže obojí počítá týmiž celými čísly.
 */
export function stepHopper(h: Hopper, input: ArcadeInput, carry: number): void {
  // Návrat na místo návratu (`respawn`) uprostřed skoku vynuluje rychlost – skok tím končí.
  if (h.rem > 0 && h.vx === 0 && h.vz === 0) h.rem = 0;
  if (h.rem === 0) {
    const wanted = hopWanted(input);
    const here = colOf(h.x);
    const col = wanted === DIR.left ? here - 1 : wanted === DIR.right ? here + 1 : here;
    if (wanted >= 0 && col >= 0 && col < HOP.cols && !(wanted === DIR.back && h.z <= 0)) {
      h.rem = HOP.hopTicks;
      h.dir = wanted;
      h.col = col;
      h.idle = 0;
    } else h.idle = Math.min(IDLE_CAP, h.idle + 1);
  }
  if (h.rem > 0) {
    h.vx = Math.trunc((colX(h.col) - h.x) / h.rem);
    h.vz = h.dir === DIR.forward ? HOP_STEP : h.dir === DIR.back ? -HOP_STEP : 0;
    h.rem -= 1;
  } else {
    h.vx = carry;
    h.vz = 0;
  }
}

export function hopperOf(state: Int32Array, player: number): Hopper {
  const base = bodyBase(player);
  const aux0 = state[base + BODY.aux0] as number;
  return {
    x: state[base + BODY.x] as number,
    z: state[base + BODY.z] as number,
    vx: state[base + BODY.vx] as number,
    vz: state[base + BODY.vz] as number,
    rem: aux0 & REM_MASK,
    dir: (aux0 >> DIR_SHIFT) & 3,
    col: aux0 >> COL_SHIFT,
    idle: state[base + BODY.aux1] as number,
  };
}

/** Zbývající tiky skoku hrdiny ve stavu (0 = stojí). */
export const hopLeft = (state: Int32Array, player: number): number => (state[bodyBase(player) + BODY.aux0] as number) & REM_MASK;
/** Směr skoku (`DIR`), dokud skáče. */
export const hopDir = (state: Int32Array, player: number): number => ((state[bodyBase(player) + BODY.aux0] as number) >> DIR_SHIFT) & 3;
/** Tiky bez skoku (orel). */
export const idleTicks = (state: Int32Array, player: number): number => state[bodyBase(player) + BODY.aux1] as number;

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Kláda (živé tělo role `platform`) v řadě hrdiny, na které stojí jeho střed; −1 = žádná. */
export function logUnder(state: Int32Array, x: number, z: number): number {
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] !== ROLE.platform || !alive(state, body) || state[base + BODY.z] !== z) continue;
    if (Math.abs(x - (state[base + BODY.x] as number)) * 2 < (state[base + BODY.w] as number)) return body;
  }
  return -1;
}

const hopControlParams = z.object({}).strict();

export const hopControl: ControlPiece<z.infer<typeof hopControlParams>> = {
  id: 'hop',
  params: hopControlParams,
  roles: ['player'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input) => {
    const h = hopperOf(state, player);
    const log = h.rem === 0 ? logUnder(state, h.x, h.z) : -1;
    stepHopper(h, input, log < 0 ? 0 : (state[bodyBase(log) + BODY.vx] as number));
    const base = bodyBase(player);
    state[base + BODY.vx] = h.vx;
    state[base + BODY.vz] = h.vz;
    state[base + BODY.aux0] = h.rem | (h.dir << DIR_SHIFT) | (h.col << COL_SHIFT);
    state[base + BODY.aux1] = h.idle;
  },
};

// ---------------------------------------------------------------------------
// Díly světa

/** Pravidla provozu: `[řada, předloha, směr, rychlost, perioda, fáze, předjetí, vjezd, výjezd]`. */
export type LaneRef = readonly [row: number, template: number, dir: number, speed: number, period: number, phase: number, warm: number, entry: number, exit: number];
export const laneRefsOf = (lanes: readonly HopLane[]): LaneRef[] => lanes.map((lane) => [lane.row, lane.template, lane.dir, lane.speed, lane.period, lane.phase, lane.warm, lane.entry, lane.exit]);
/** Robot: `[řada, druh, směr, rychlost, šířka, hloubka, perioda, vjezd, fáze]` – rytmus provozu, který hráč vidí jezdit. */
export type BotLane = readonly [row: number, kind: number, dir: number, speed: number, w: number, d: number, period: number, entry: number, phase: number];
export const botLanesOf = (lanes: readonly HopLane[]): BotLane[] => lanes.map((lane) => [lane.row, lane.kind, lane.dir, lane.speed, lane.w, lane.d, lane.period, lane.entry, lane.phase]);

/** Díly světa: ovládání `hop`, robot, úroveň a pravidla. Bez životů ze specu hraje se třemi. */
export function hopParts(seed: number, params: HopParams, health: number | undefined): ModeParts {
  const layout = hopLayout(seed, params);
  const parts = hopWorldOf(layout, health ?? START_LIVES);
  return { ...parts, issues: checkHopLevel(parts.level, layout, params) };
}

/** Svět z hotového rozvržení (i ručního v testech): cíl je jeho poslední řada. */
export function hopWorldOf(layout: HopLayout, lives: number): Omit<ModeParts, 'issues'> {
  const rows = layout.kinds.length - 1;
  const level = hopLevel(layout);
  const grass = grassRows(layout);
  return {
    control: { id: 'hop', params: {} },
    bot: { id: 'hop_bot', params: { lanes: botLanesOf(layout.lanes), goal: rows } },
    level,
    rules: [
      { id: 'hop_traffic', params: { lanes: laneRefsOf(layout.lanes) } },
      {
        id: 'hop_cross',
        params: {
          river: [...new Set(layout.lanes.filter((lane) => lane.kind === ROW.river).map((lane) => lane.row))],
          grass: grass.map((row, index) => [row, HOP_BODIES.markers + index]),
          points: HOP.points,
          eagle: HOP.eagle,
        },
      },
      // Auto a vlak: život, vteřina milosti a návrat na poslední trávu (`checkpoint` značky řady).
      { id: 'hit', params: { role: 'obstacle', effect: 'damage', grace: HIT_GRACE, after: 'respawn' } },
      { id: 'out_of_health', params: {} },
      // Dotek pásky cíle s `rows` započtenými řadami = výhra; pilulka postupu HUD z něj čte cíl.
      { id: 'finish_collected', params: { need: rows } },
    ],
    health: lives,
  };
}

export const hopRows: ModeGeneratorPiece<HopParams> = {
  id: 'hop_rows',
  params: hopParams,
  roles: ['player', 'obstacle', 'platform', 'goal', 'checkpoint'],
  cost: (params) => ({ bodies: HOP_BODIES.markers + 5 * params.rows, rules: 5 }),
  generate: (seed, params) => hopLevel(hopLayout(seed, params)),
  parts: hopParts,
};

// ---------------------------------------------------------------------------
// Pravidla

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const rowIndex = z.int().min(0).max(HOP.rows.max);
const far = z.int().min(0).max(ARCADE_LIMITS.maxTicks * 1000);

const trafficParams = z
  .object({
    lanes: z
      .array(z.tuple([rowIndex, index, z.union([z.literal(1), z.literal(-1)]), z.int().min(1).max(1000), z.int().min(1).max(ARCADE_LIMITS.maxTicks), z.int().min(0).max(ARCADE_LIMITS.maxTicks), z.int().min(0).max(60), far, far]))
      // Řada silnice je kolona: pod-pruh na auto.
      .max(HOP.carsPerRow * HOP.rows.max),
  })
  .strict();
type TrafficParams = z.infer<typeof trafficParams>;

/** Pruh podle řady pro úklid (z parametrů, jednou na svět). */
const rowLanes = new WeakMap<TrafficParams, Map<number, TrafficParams['lanes'][number]>>();
const lanesByRow = (params: TrafficParams): Map<number, TrafficParams['lanes'][number]> => {
  let found = rowLanes.get(params);
  if (found === undefined) rowLanes.set(params, (found = new Map(params.lanes.map((lane) => [lane[0], lane]))));
  return found;
};

/**
 * Provoz (tik): v tiku předjetí postaví vozidla pruhu, která vyjela dřív, rovnou na jejich místa; pak vysílá
 * každých `period` tiků z vjezdu a odebírá vozidla za výjezdem. Výjezdy první: nové vozidlo vezme slot mrtvý
 * už před tímhle tikem, ne ten, který se uvolní teď (scéna je nezamění).
 */
export const hopTrafficRule: RulePiece<TrafficParams> = {
  id: 'hop_traffic',
  params: trafficParams,
  roles: ['obstacle', 'platform'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    const effects: ArcadeEffect[] = [];
    const tick = state[HEADER.tick] as number;
    for (const [row, template, dir, speed, period, phase, warm, entry, exit] of params.lanes) {
      if (tick < warm) continue;
      const lane = { dir, entry, speed };
      const z = row * HOP.cell;
      if (tick === warm) {
        for (let sent = tick - 1 - mod(tick - 1 - phase, period); dir * laneX(lane, sent, tick) < exit; sent -= period) {
          effects.push({ kind: 'spawn', template, x: laneX(lane, sent, tick), y: 0, z, vx: dir * speed, vy: 0, vz: 0 });
        }
      }
      if (mod(tick - phase, period) === 0) effects.push({ kind: 'spawn', template, x: -dir * entry, y: 0, z, vx: dir * speed, vy: 0, vz: 0 });
    }
    const byRow = lanesByRow(params);
    for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
      if (!alive(state, body)) continue;
      const base = bodyBase(body);
      const role = state[base + BODY.role] as number;
      if (role !== ROLE.obstacle && role !== ROLE.platform) continue;
      const lane = byRow.get(Math.round((state[base + BODY.z] as number) / HOP.cell));
      if (lane !== undefined && lane[2] * (state[base + BODY.x] as number) >= lane[8]) effects.push({ kind: 'despawn', body });
    }
    return effects;
  },
};

const crossParams = z
  .object({
    /** Řady řeky: stojící hrdina mimo kládu = voda. */
    river: z.array(rowIndex).max(HOP.rows.max),
    /** Řady trávy a jejich značky (místa návratu). */
    grass: z.array(z.tuple([rowIndex, index])).max(HOP.rows.max + 1),
    points: z.int().min(1).max(100),
    /** Tiky bez skoku, po kterých orel hru ukončí. */
    eagle: z.int().min(1).max(ARCADE_LIMITS.maxTicks),
    /** Počítadlo komba (P46C T3, `withCombo`); bez něj body bez násobiče. */
    combo: index.optional(),
  })
  .strict();

/**
 * Přechod (tik): nová nejvzdálenější řada = čítač `items` a body × kombo. Stojící hrdina (po dopadu i na kládě)
 * ve vodě mimo kládu nebo odvezený za hranu pole přijde o život a vrátí se na poslední trávu (v milosti jen
 * návrat); na trávě se její značka stane místem návratu. Orel: `eagle` tiků bez skoku = prohra.
 */
export const hopCrossRule: RulePiece<z.infer<typeof crossParams>> = {
  id: 'hop_cross',
  params: crossParams,
  roles: ['player', 'platform', 'checkpoint'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const effects: ArcadeEffect[] = [];
    const base = bodyBase(player);
    const x = state[base + BODY.x] as number;
    const z = state[base + BODY.z] as number;
    const row = rowOf(z);
    const crossed = state[HEADER.counters + COUNTER.items] as number;
    if (row > crossed) {
      const multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo);
      effects.push({ kind: 'count', counter: 'items', amount: row - crossed }, { kind: 'score', amount: params.points * multiplier });
      if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
    }
    if (hopLeft(state, player) === 0) {
      const drowned = params.river.includes(row) && logUnder(state, x, z) < 0;
      if (drowned || Math.abs(x) > HOP_HALF) effects.push({ kind: 'damage', amount: 1, grace: HIT_GRACE }, { kind: 'respawn' });
      else {
        const marker = params.grass.find(([grass]) => grass === row)?.[1];
        if (marker !== undefined && state[HEADER.respawnZ] !== z) effects.push({ kind: 'checkpoint', body: marker });
      }
    }
    if (idleTicks(state, player) >= params.eagle) effects.push({ kind: 'lose' });
    return effects;
  },
};

export const HOP_RULES = { hop_traffic: hopTrafficRule, hop_cross: hopCrossRule } as const;
