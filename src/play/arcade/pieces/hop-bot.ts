/**
 * Robot přeskákání silnice (P54C T9): BFS v čase (pole × tik) k nejbližší trávě za pásem, který má před sebou.
 *
 * Svět vidí `reactionTicks` starý. Vlastní polohu dopočítá z vlastních vstupů od té doby (`stepHopper`, týž kód
 * jako ovládání). Provoz zná z jeho rytmu (perioda a fáze pruhu v parametrech robota, jak je hráč vidí jezdit),
 * s jednou výjimkou – rezervou reakce: vozidlo, které vyjelo po viděném stavu, ale dřív než `HOP_BOT_REACTION` tiků
 * před teď, ještě nezaregistroval. U robota světa je to slepé místo prázdné; začátečník s delší reakcí tak přehlédne
 * auto, které právě vjelo. Kolem vozidel drží rezervu `HOP_BOT_MARGIN` tiků, na kládu dopadá kousek od jejího konce.
 *
 * Drží střed pole (zaručený přechod pásu vede prostředním sloupcem), do strany uhne jen k němu nebo před orlem.
 * Couvat neplánuje: v pruhu silnice jde vpřed, nebo čeká. Nalezenou cestu si pamatuje po dobu běhu (`memos`, klíč =
 * parametry robota, které `runBot` přečte pro každý běh znovu): čeká podle ní, dokud ji nové pozorování nevyvrátí,
 * každý skok ale rozhodne znovu tím, co vidí teď; na trávě bez cesty hledá znovu každých `CADENCE` tiků.
 */

import { z } from 'zod';

import { type ArcadeInput, type ArcadeObservation, BODY, BUTTON, type BotPiece, NO_INPUT, bodyBase, graceOf } from '../contract';
import { DIR, HOP, HOP_BOT_MARGIN, HOP_BOT_REACTION, HOP_HALF, HOP_LOG_INSET, HOP_MID, HOP_STEP, ROW, type Hopper, hopperOf, rowOf, stepHopper, touchesFrom, touchesInto } from './hop';

const botParams = z
  .object({
    /** `[řada, druh, směr, rychlost, šířka, hloubka, perioda, vjezd, fáze]` (`botLanesOf`). */
    lanes: z
      .array(z.tuple([z.int().min(0).max(HOP.rows.max), z.int().min(1).max(3), z.union([z.literal(1), z.literal(-1)]), z.int().min(1).max(1000), z.int().min(1).max(20_000), z.int().min(1).max(5000), z.int().min(1).max(5400), z.int().min(0).max(5_400_000), z.int().min(0).max(5400)]))
      .max(HOP.carsPerRow * HOP.rows.max),
    /** Cílová řada. */
    goal: z.int().min(1).max(HOP.rows.max),
  })
  .strict();
export type HopBotParams = z.infer<typeof botParams>;
type BotLaneRef = HopBotParams['lanes'][number];

// Místní kopie pro horkou smyčku: pod vitestem je každý importovaný název getter modulu (jako v `kernel.ts`).
const CELL: number = HOP.cell;
const TICKS: number = HOP.hopTicks;
const COLS: number = HOP.cols;
const MID: number = HOP_MID;
const HALF: number = HOP_HALF;
const STEP: number = HOP_STEP;
const HERO_W: number = HOP.hero.w;
const HERO_D: number = HOP.hero.d;
const INSET: number = HOP_LOG_INSET;
const GRASS: number = ROW.grass;
const ROAD: number = ROW.road;
const RIVER: number = ROW.river;
const RAIL: number = ROW.rail;
const FORWARD: number = DIR.forward;
const BACK: number = DIR.back;
const LEFT: number = DIR.left;
const RIGHT: number = DIR.right;
const EAGLE: number = HOP.eagle;
const REACTION: number = HOP_BOT_REACTION;

const colXOf = (col: number): number => (col - MID) * CELL;
const colAt = (x: number): number => Math.min(COLS - 1, Math.max(0, Math.round(x / CELL) + MID));

/** Těleso řady: střed po kroku `t` je `p0 + v · (t − t0)`. `seen` = je ve viděném stavu (ne teprve čekané). */
interface Mover {
  readonly p0: number;
  readonly v: number;
  readonly t0: number;
  readonly w: number;
  readonly d: number;
  readonly seen: boolean;
}

interface RowView {
  readonly kind: number;
  readonly obstacles: Mover[];
  readonly logs: Mover[];
}

/** Okno řad kolem hrdiny, které robot čte: `views[row − from]`. */
interface Window {
  readonly from: number;
  readonly views: readonly RowView[];
}

/** Uzel cesty: tik (stav před krokem `t`), řada, x a čím do něj robot přišel. */
interface PathNode {
  readonly t: number;
  readonly row: number;
  readonly x: number;
  readonly action: number;
}

interface Memo {
  readonly at: number;
  readonly row: number;
  readonly x: number;
  readonly found: boolean;
  readonly path: readonly PathNode[];
}

/** Jak daleko dopředu robot plánuje (tiky) a kolik uzlů BFS nejvýš projde. */
// Zaručený přechod pásu (`HOP.longestCross`) a k němu až čtyři kroky stranou po trávě.
const HORIZON = HOP.longestCross + 4 * HOP.hopTicks + 10;
const NODE_CAP = 5000;
/** Robot drží střed pole: do strany dál než o tolik sloupců od středu neuhne (zaručený přechod pásu vede středem). */
const SIDE_REACH = 0;
/** Na trávě bez cesty hledá robot znovu po tolika ticích. */
const CADENCE = 6;
/** Kolik tiků před orlem robot na trávě uhne do strany, místo aby čekal. */
const EAGLE_GUARD = 90;
const WAIT = -1;

const at = (mover: Mover, tick: number): number => mover.p0 + mover.v * (tick - mover.t0);

const lanesOf = new WeakMap<HopBotParams, Map<number, BotLaneRef>>();
function laneMap(params: HopBotParams): Map<number, BotLaneRef> {
  let found = lanesOf.get(params);
  if (found === undefined) lanesOf.set(params, (found = new Map(params.lanes.map((lane) => [lane[0], lane]))));
  return found;
}

const memos = new WeakMap<HopBotParams, Memo>();

/**
 * Řady kolem viděného hrdiny: vozidla a klády z rytmu provozu (perioda a fáze pruhu), jak je hráč vidí jezdit –
 * i ta, která na plátno teprve vjedou. `seen` = vozidlo už bylo ve viděném stavu.
 */
function windowOf({ state, player, tick: seenAt, recent }: ArcadeObservation, params: HopBotParams): Window {
  const now = seenAt + recent.length;
  const lanes = laneMap(params);
  const seenRow = rowOf(state[bodyBase(player) + BODY.z] as number);
  const from = Math.max(0, seenRow - 3);
  const to = Math.min(params.goal, seenRow + 8);
  const views: RowView[] = [];
  for (let row = from; row <= to; row += 1) views.push({ kind: lanes.get(row)?.[1] ?? GRASS, obstacles: [], logs: [] });
  const end = now + HORIZON + TICKS;
  // Slepé místo: co vyjelo po viděném stavu, ale dřív než `HOP_BOT_REACTION` tiků před teď, robot ještě nezaregistroval
  // (u robota světa prázdné; začátečník s delší reakcí tak přehlédne auto, které právě vjelo).
  const blindFrom = seenAt;
  const blindTo = now - REACTION;
  for (const [row, kind, dir, speed, w, d, period, entry, phase] of params.lanes) {
    if (row < from || row > to) continue;
    const view = views[row - from] as RowView;
    // Vozidla, která jsou v okně plánu kdekoli mezi vjezdem a druhou stranou pole.
    const oldest = now - Math.ceil((entry + HALF + w) / speed) - 1;
    for (let sent = oldest + mod(phase - oldest, period); sent <= end; sent += period) {
      if (sent >= blindFrom && sent < blindTo) continue;
      const mover: Mover = { p0: -dir * entry, v: dir * speed, t0: sent, w, d, seen: sent < seenAt };
      (kind === RIVER ? view.logs : view.obstacles).push(mover);
    }
  }
  return { from, views };
}

const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** Vlastní hrdina v tiku `now`: viděný stav a vlastní vstupy od té doby (klády jedou dál, náraz nepředvídá). */
function predictHopper({ state, player, tick: seenAt, recent }: ArcadeObservation, window: Window): Hopper {
  const h = hopperOf(state, player);
  recent.forEach((input, index) => {
    const tick = seenAt + index;
    let carry = 0;
    if (h.rem === 0 && h.z % CELL === 0) {
      for (const log of window.views[h.z / CELL - window.from]?.logs ?? []) {
        if (Math.abs(h.x - at(log, tick - 1)) * 2 < log.w) {
          carry = log.v;
          break;
        }
      }
    }
    stepHopper(h, input, carry);
    h.x += h.vx;
    h.z += h.vz;
  });
  return h;
}

/** Kam hrdina z `(row, x)` po kroku `t` akcí dojde bezpečně (`row`, `x` do `out`), nebo `false`. */
type Edge = (row: number, x: number, t: number, action: number, out: { row: number; x: number }) => boolean;

/**
 * Pravidla pohybu nad oknem: čekání (na kládě veze kláda), skok vpřed a vzad, do strany jen na trávě a kládách.
 * S `tables` čte obsazení sloupců silnic z tabulek po ticích `now..now + span − 1` (hledání), jinak počítá přímo
 * (ověření zapamatované cesty, platí pro jakýkoli tik).
 */
function edgesOf(window: Window, params: HopBotParams, now: number, lowest: number, highest: number, margin: number, tables: boolean, shielded: number, reach = SIDE_REACH): Edge {
  const lanes = laneMap(params);
  const from0 = window.from;
  const views = window.views;
  const span = HORIZON + TICKS + 1;
  const rowsIn = highest - lowest + 1;
  const kinds = new Int8Array(rowsIn);
  const fromK = new Int8Array(rowsIn);
  const intoK = new Int8Array(rowsIn);
  const blocked: (Uint8Array | null)[] = [];
  for (let row = lowest; row <= highest; row += 1) {
    const view = views[row - from0] as RowView;
    const d = lanes.get(row)?.[5] ?? 0;
    kinds[row - lowest] = view.kind;
    fromK[row - lowest] = touchesFrom(d);
    intoK[row - lowest] = touchesInto(d);
    if (!tables || (view.kind !== ROAD && view.kind !== RAIL)) {
      blocked.push(null);
      continue;
    }
    const table = new Uint8Array(COLS * span);
    for (const mover of view.obstacles) {
      const half = (HERO_W + mover.w) / 2 + Math.abs(mover.v) * margin;
      for (let col = 0; col < COLS; col += 1) {
        const x = colXOf(col);
        const a = (x - mover.p0 - half) / mover.v;
        const b = (x - mover.p0 + half) / mover.v;
        const from = Math.max(now, mover.t0 + Math.floor(Math.min(a, b)));
        const to = Math.min(now + span - 1, mover.t0 + Math.ceil(Math.max(a, b)));
        for (let t = from; t <= to; t += 1) if (Math.abs(x - at(mover, t)) < half) table[col * span + t - now] = 1;
      }
    }
    blocked.push(table);
  }
  /** Srazí hrdinu v `(x, z)` po kroku `t` vozidlo (s rezervou)? V milosti po zásahu (do kroku `shielded`) ne. */
  const struck = (x: number, z: number, t: number): boolean => {
    if (t <= shielded) return false;
    const low = Math.max(lowest, Math.ceil((z - CELL) / CELL));
    const high = Math.min(highest, Math.floor((z + CELL) / CELL));
    for (let row = low; row <= high; row += 1) {
      const dz = Math.abs(z - row * CELL) * 2;
      for (const mover of (views[row - from0] as RowView).obstacles) {
        if (dz >= HERO_D + mover.d) continue;
        if (Math.abs(x - at(mover, t)) * 2 < HERO_W + mover.w + 2 * Math.abs(mover.v) * margin) return true;
      }
    }
    return false;
  };
  /** Stojí hrdina ve sloupci `col` řady po kroku `t` mimo vozidla? */
  const free = (row: number, col: number, t: number): boolean => {
    if (!tables || t <= shielded) return !struck(colXOf(col), row * CELL, t);
    const table = blocked[row - lowest];
    return table === null || table === undefined || table[col * span + t - now] !== 1;
  };
  /** Kláda pod `x` v řadě po kroku `t` (`inset` od konce), nebo `null`. */
  const logAt = (row: number, x: number, t: number, inset: number): Mover | null => {
    for (const log of (views[row - from0] as RowView).logs) if (Math.abs(x - at(log, t)) * 2 < log.w - 2 * inset) return log;
    return null;
  };
  return (row, x, t, action, out) => {
    const kind = kinds[row - lowest] as number;
    const river = kind === RIVER;
    const here = colAt(x);
    const centred = x === colXOf(here);
    if (action === WAIT) {
      const under = river ? logAt(row, x, t - 1, 0) : null;
      if (river && under === null) return false;
      const stay = under === null ? x : x + under.v;
      if (Math.abs(stay) > HALF || (river && logAt(row, stay, t, 0) === null)) return false;
      if (centred && !river ? !free(row, here, t) : struck(stay, row * CELL, t)) return false;
      out.row = row;
      out.x = stay;
      return true;
    }
    const col = action === LEFT ? here - 1 : action === RIGHT ? here + 1 : here;
    const next = action === FORWARD ? row + 1 : action === BACK ? row - 1 : row;
    if (col < 0 || col >= COLS || next < lowest || next > highest) return false;
    let hx = colXOf(col);
    if (next === row) {
      // Do strany jen na trávě a kládách (tam žádné vozidlo nezasáhne) a jen k prostřednímu sloupci nebo v jeho okolí.
      if ((kind !== GRASS && !river) || (Math.abs(col - MID) > reach && Math.abs(col - MID) >= Math.abs(here - MID))) return false;
    } else if (centred) {
      // Skok středem sloupce: obsazení řady, ze které skáče, a té, kam skáče.
      const leave = fromK[row - lowest] as number;
      const enter = intoK[next - lowest] as number;
      for (let k = 1; k <= TICKS; k += 1) {
        if (k <= leave && !free(row, col, t + k - 1)) return false;
        if (k >= enter && !free(next, col, t + k - 1)) return false;
      }
    } else {
      hx = x;
      for (let k = 1; k <= TICKS; k += 1) {
        hx += Math.trunc((colXOf(col) - hx) / (TICKS - k + 1));
        if (struck(hx, row * CELL + (next - row) * k * STEP, t + k - 1)) return false;
      }
    }
    // Dopad na řeku jen na kládu, kousek od jejího konce.
    if (kinds[next - lowest] === RIVER && logAt(next, hx, t + TICKS - 1, INSET) === null) return false;
    out.row = next;
    out.x = hx;
    return true;
  };
}

const INPUTS: Readonly<Record<number, ArcadeInput>> = {
  [DIR.forward]: { buttons: BUTTON.TAP, axis: 0 },
  [DIR.back]: { buttons: BUTTON.DOWN, axis: 0 },
  [DIR.left]: { buttons: BUTTON.LEFT, axis: 0 },
  [DIR.right]: { buttons: BUTTON.RIGHT, axis: 0 },
};
const inputOf = (action: number): ArcadeInput => (action === WAIT ? NO_INPUT : (INPUTS[action] as ArcadeInput));

/** Robot couvat neplánuje: jednou v pruhu jde jen vpřed, nebo čeká (zmeškaný skok ho tam nechá). */
const MOVES: readonly number[] = [WAIT, FORWARD, LEFT, RIGHT];

/** Plán z `planHop`: vstup do tohoto tiku a jestli robot má cestu na trávu za pásem. */
export interface HopPlan {
  readonly input: ArcadeInput;
  readonly found: boolean;
}

/** Plánovač: z pozorování vstup do tohoto tiku. `margin` = rezerva kolem vozidel v ticích. */
export function planHop(observation: ArcadeObservation, params: HopBotParams, margin: number = HOP_BOT_MARGIN): HopPlan {
  const now = observation.tick + observation.recent.length;
  const lanes = laneMap(params);
  const window = windowOf(observation, params);
  const h = predictHopper(observation, window);
  if (h.rem > 0 || h.z % CELL !== 0) return { input: NO_INPUT, found: false };
  const root = h.z / CELL;
  const top = window.from + window.views.length - 1;
  if (root < window.from || root > top) return { input: NO_INPUT, found: false };
  let target = root + 1;
  while (target < params.goal && lanes.has(target)) target += 1;
  const lowest = Math.max(window.from, root - 2);
  const highest = Math.min(top, target);
  const onGrass = (window.views[root - window.from] as RowView).kind === GRASS;
  const restless = h.idle >= EAGLE - EAGLE_GUARD;
  const out = { row: 0, x: 0 };
  // Milost po zásahu (jádro ji odečte na začátku kroku a chrání, dokud zbývá aspoň tik): vozidlo do té doby nic nevezme.
  const shielded = observation.tick + graceOf(observation.state, observation.player) - 2;

  const memo = memos.get(params);
  if (memo !== undefined && !restless) {
    // Zapamatovaná cesta platí, dokud hrdina stojí, kde má, a každý její další krok je pořád bezpečný.
    const index = memo.found ? memo.path.findIndex((node) => node.t === now) : -1;
    const node = memo.path[index];
    let low = Infinity;
    let high = -Infinity;
    for (const step of memo.path) {
      low = Math.min(low, step.row);
      high = Math.max(high, step.row);
    }
    if (node !== undefined && node.row === root && node.x === h.x && index + 1 < memo.path.length && low >= window.from && high <= top) {
      const check = edgesOf(window, params, now, low, high, margin, false, shielded);
      let ok = true;
      for (let step = index; step + 1 < memo.path.length && ok; step += 1) {
        const from = memo.path[step] as PathNode;
        const to = memo.path[step + 1] as PathNode;
        ok = check(from.row, from.x, from.t, to.action, out) && out.row === to.row && out.x === to.x;
      }
      // Čekat smí podle paměti; skok (závazek) robot rozhodne znovu tím, co vidí teď.
      if (ok && (memo.path[index + 1] as PathNode).action === WAIT) return { input: NO_INPUT, found: true };
    }
    if (!memo.found && onGrass && memo.row === root && memo.x === h.x && now - memo.at < CADENCE) return { input: NO_INPUT, found: false };
  }

  const edge = edgesOf(window, params, now, lowest, highest, margin, true, shielded);
  const rows: number[] = [root];
  const xs: number[] = [h.x];
  const ticks: number[] = [now];
  const parents: number[] = [-1];
  const actions: number[] = [WAIT];
  const buckets: number[][] = Array.from({ length: HORIZON + 1 }, () => []);
  (buckets[0] as number[]).push(0);
  const seen = new Set<number>();

  let found = -1;
  let deepest = 0;
  for (let offset = 0; offset <= HORIZON && found < 0; offset += 1) {
    for (const node of buckets[offset] as number[]) {
      const row = rows[node] as number;
      const x = xs[node] as number;
      const t = ticks[node] as number;
      if (row >= target) {
        if (found < 0 || Math.abs(x) < Math.abs(xs[found] as number)) found = node;
        continue;
      }
      if (t > (ticks[deepest] as number) || (t === ticks[deepest] && row > (rows[deepest] as number))) deepest = node;
      for (const action of MOVES) {
        if (!edge(row, x, t, action, out)) continue;
        const reached = t + (action === WAIT ? 1 : TICKS) - now;
        if (reached > HORIZON || rows.length >= NODE_CAP) continue;
        const key = (reached * 64 + out.row) * 32768 + (out.x + 16384);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(out.row);
        xs.push(out.x);
        ticks.push(now + reached);
        parents.push(node);
        actions.push(action);
        (buckets[reached] as number[]).push(rows.length - 1);
      }
    }
  }
  const pathTo = (node: number): PathNode[] => {
    const path: PathNode[] = [];
    for (let step = node; step >= 0; step = parents[step] as number) path.push({ t: ticks[step] as number, row: rows[step] as number, x: xs[step] as number, action: actions[step] as number });
    return path.reverse();
  };
  const path = found >= 0 ? pathTo(found) : onGrass || deepest === 0 ? [] : pathTo(deepest);
  let action = path.length > 1 ? (path[1] as PathNode).action : WAIT;
  // Orel: kdo dlouho stojí, uhne do strany (na trávě vždy bezpečně) a čekání začne znovu.
  if (action === WAIT && restless) {
    const sides = colAt(h.x) >= MID ? [LEFT, RIGHT] : [RIGHT, LEFT];
    const aside = edgesOf(window, params, now, lowest, highest, margin, false, shielded, COLS);
    action = sides.find((dir) => aside(root, h.x, now, dir, out)) ?? WAIT;
  }
  memos.set(params, { at: now, row: root, x: h.x, found: found >= 0 && action === (path[1]?.action ?? WAIT), path });
  return { input: inputOf(action), found: found >= 0 };
}

/**
 * Sonda hrozby (P41 svědek `obstacle`): hraje jako robot, ale stojí-li hrdina a skok vpřed by ho teď poslal
 * pod viděné vozidlo (bez rezervy), skočí – náraz pak dokáže, že vozidlo opravdu bere život.
 */
export function hopProbeInput(observation: ArcadeObservation, params: HopBotParams, normal: ArcadeInput): ArcadeInput {
  const now = observation.tick + observation.recent.length;
  const window = windowOf(observation, params);
  const h = predictHopper(observation, window);
  if (h.rem > 0 || h.z % CELL !== 0) return normal;
  const next = window.views[h.z / CELL + 1 - window.from];
  if (next === undefined || next.kind === RIVER) return normal;
  let hx = h.x;
  for (let k = 1; k <= TICKS; k += 1) {
    hx += Math.trunc((colXOf(colAt(h.x)) - hx) / (TICKS - k + 1));
    const dz = Math.abs(h.z + k * STEP - (h.z + CELL)) * 2;
    for (const mover of next.obstacles) {
      if (mover.seen && dz < HERO_D + mover.d && Math.abs(hx - at(mover, now + k - 1)) * 2 < HERO_W + mover.w) return { buttons: BUTTON.TAP, axis: 0 };
    }
  }
  return normal;
}

export const hopBot: BotPiece<HopBotParams> = {
  id: 'hop_bot',
  params: botParams,
  roles: ['player', 'obstacle', 'platform'],
  reactionTicks: HOP_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: (observation, params) => planHop(observation, params).input,
};
