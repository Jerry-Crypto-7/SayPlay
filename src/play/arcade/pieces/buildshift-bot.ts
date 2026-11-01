/**
 * Robot směny se stavbou obchodu (P68-S T3).
 *
 * **Rozvržení (`planLayout`, pravidlo nad pevnou mřížkou):** pult na stavební buňce nejblíž dveřím (shoda = přímo
 * naproti dveřím), pec hned vedle pultu, zbylé mince ve fázi stavby na druhý pult (stačí-li na něj), jinak na polici
 * vedle pultu; pak Open. Během směny za vydělané mince další pec vedle pultu.
 *
 * **Obsluha (`serveWithLayout`) je oddělená od rozvržení**, aby šla pustit nad cizím (i špatným) rozvržením: postaví
 * jeho `opening`, dokud stačí mince, otevře, a pak posílá prodavače – nese-li věc, k pultu s nejdelší frontou (nikdo
 * nečeká → odloží na polici s místem, jinak čeká u pultu); nenese-li, pro hotovou věc s nejkratší cestou přes ni k pultu
 * (pec, při čekající frontě i police), a když nic hotové není, k peci, která dopeče nejdřív. Stavby `later` staví za
 * vydělané mince v pořadí (na další šetří, i když by stačilo na levnější).
 *
 * Svět vidí `reactionTicks` starý: dokud ťuk, který vydal, ve viděném stavu není, neťuká znovu (nejvýš jeden ťuk
 * na reakci, žádný dvojí výběr ani dvojí stavba).
 */

import { z } from 'zod';

import { ARCADE_LIMITS, type ArcadeInput, type ArcadeState, BODY, BUTTON, type BotPiece, NO_INPUT, bodyBase } from '../contract';
import {
  BOARD_CELLS,
  BUILDSHIFT,
  PALETTE,
  PHASE,
  STATION,
  STATION_COST,
  STATION_SLOTS,
  type ShiftView,
  type StationKind,
  cellOf,
  cellX,
  cellZ,
  colOf,
  isBuildCell,
  manhattan,
  queueAt,
  shiftView,
  stationCode,
} from './buildshift-world';
import { axisOfCell } from './lanes';

/** Reakce robota (tiky): jako ostatní roboti knihovny. */
export const BUILDSHIFT_BOT_REACTION = 8;

const botParams = z
  .object({
    keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
    /** Cíl směny (robot ho nepotřebuje – hraje, dokud jádro nevyhlásí výhru). */
    goal: z.int().min(BUILDSHIFT.goal.min).max(BUILDSHIFT.goal.max),
  })
  .strict();
export type BuildshiftBotParams = z.infer<typeof botParams>;

/** Stanoviště na buňce desky. */
export interface Placement {
  readonly kind: StationKind;
  readonly cell: number;
}

/** Rozvržení: co postavit ve fázi stavby (v pořadí, dokud stačí mince) a co během směny za vydělané mince. */
export interface ShopLayout {
  readonly opening: readonly Placement[];
  readonly later: readonly Placement[];
}

const PALETTE_OF: Readonly<Record<StationKind, number>> = { oven: PALETTE.oven, counter: PALETTE.counter, shelf: PALETTE.shelf };
const tapCell = (cell: number): ArcadeInput => ({ buttons: BUTTON.TAP, axis: axisOfCell(cell) });

/** Buňka z `cells` s nejmenším klíčem; shoda = nižší buňka. */
function argmin(cells: Iterable<number>, key: (cell: number) => number): number {
  let best = -1;
  let bestKey = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    const value = key(cell);
    if (value < bestKey || (value === bestKey && cell < best)) {
      best = cell;
      bestKey = value;
    }
  }
  return best;
}

/**
 * Dobré rozvržení pravidlem: pult nejblíž dveřím (shoda = ve sloupci dveří), pec vedle pultu, zbytek mincí na druhý
 * pult nebo polici vedle pultu; během směny další pec vedle pultu.
 */
export function planLayout(coins: number = BUILDSHIFT.startCoins): ShopLayout {
  const free = new Set(Array.from({ length: BOARD_CELLS }, (_, cell) => cell).filter(isBuildCell));
  const take = (key: (cell: number) => number): number => {
    const cell = argmin(free, key);
    free.delete(cell);
    return cell;
  };
  const byDoor = (cell: number): number => manhattan(cell, BUILDSHIFT.door) * 10 + Math.abs(colOf(cell) - colOf(BUILDSHIFT.door));
  const counter = take(byDoor);
  const byCounter = (cell: number): number => manhattan(cell, counter);
  const opening: Placement[] = [
    { kind: 'counter', cell: counter },
    { kind: 'oven', cell: take(byCounter) },
  ];
  let left = coins - STATION_COST.counter - STATION_COST.oven;
  if (left >= STATION_COST.counter) {
    opening.push({ kind: 'counter', cell: take(byDoor) });
    left -= STATION_COST.counter;
  }
  if (left >= STATION_COST.shelf) opening.push({ kind: 'shelf', cell: take(byCounter) });
  return { opening, later: [{ kind: 'oven', cell: take(byCounter) }] };
}

/**
 * Pevné špatné rozvržení (důkaz T3, e2e T6): jeden pult z `planLayout` u dveří a pec ve stavebním rohu nejdál od něj;
 * nic dalšího se nestaví. Stejná obsluha `serveWithLayout` nad ním prohraje.
 */
export function badLayout(): ShopLayout {
  const counter = (planLayout().opening.find((at) => at.kind === 'counter') as Placement).cell;
  const [right, back] = [BUILDSHIFT.cols - 1, BUILDSHIFT.rows - 1];
  const corners = [cellOf(0, 0), cellOf(right, 0), cellOf(0, back), cellOf(right, back)].filter(isBuildCell);
  const oven = corners.reduce((best, cell) => (manhattan(cell, counter) > manhattan(best, counter) ? cell : best));
  return { opening: [{ kind: 'counter', cell: counter }, { kind: 'oven', cell: oven }], later: [] };
}

interface Spot {
  readonly cell: number;
  /** Pec a police: hotové věci / zásoba; pult: délka fronty. */
  readonly count: number;
  /** Pec: postup pečení. */
  readonly bake: number;
}

/** Stanoviště po druzích z viděného stavu. */
function spotsOf(state: ArcadeState, view: ShiftView): { readonly ovens: Spot[]; readonly shelves: Spot[]; readonly counters: Spot[] } {
  const ovens: Spot[] = [];
  const shelves: Spot[] = [];
  const counters: Spot[] = [];
  for (let cell = 0; cell < BOARD_CELLS; cell += 1) {
    const body = view.stations[cell] as number;
    if (body < 0) continue;
    const base = bodyBase(body);
    const code = stationCode(state, body);
    if (code === STATION.oven) ovens.push({ cell, count: state[base + STATION_SLOTS.stock] as number, bake: state[base + STATION_SLOTS.bake] as number });
    else if (code === STATION.shelf) shelves.push({ cell, count: state[base + STATION_SLOTS.stock] as number, bake: 0 });
    else if (code === STATION.counter) counters.push({ cell, count: queueAt(state, cell).length, bake: 0 });
  }
  return { ovens, shelves, counters };
}

/**
 * Kam poslat prodavače (buňka), nebo −1, když nemá kam (žádný pult). Nese-li věc: pult s nejdelší frontou (shoda =
 * nejblíž), nikdo nečeká → police s místem, jinak nejbližší pult. Nenese-li: hotová věc s nejkratší cestou prodavač →
 * zdroj → pult (pec před policí, police jen při čekající frontě), jinak pec, která dopeče nejdřív.
 *
 * Cíl, který pořád patří mezi přípustné, prodavač drží – jinak by na půli cesty mezi dvěma stejně dobrými pecemi
 * přepínal sem a tam.
 */
export function sellerTarget(state: ArcadeState, player: number, view: ShiftView = shiftView(state)): number {
  const { ovens, shelves, counters } = spotsOf(state, view);
  if (counters.length === 0) return -1;
  const base = bodyBase(player);
  // Vzdálenost od prodavače v jednotkách světa (i na cestě mezi buňkami, bez zaokrouhlení na buňku).
  const away = (cell: number): number => Math.abs((state[base + BODY.x] as number) - cellX(cell)) + Math.abs((state[base + BODY.z] as number) - cellZ(cell));
  const pick = (options: readonly Spot[], key: (cell: number) => number): number =>
    options.some((spot) => spot.cell === view.target)
      ? view.target
      : argmin(
          options.map((spot) => spot.cell),
          key,
        );
  const waiting = counters.filter((spot) => spot.count > 0);
  const longest = Math.max(0, ...waiting.map((spot) => spot.count));
  const busiest = waiting.filter((spot) => spot.count === longest);
  if (view.carrying > 0) {
    const room = shelves.filter((spot) => spot.count < BUILDSHIFT.shelfCap);
    return pick(busiest.length > 0 ? busiest : room.length > 0 ? room : counters, away);
  }
  const dest = argmin(
    (busiest.length > 0 ? busiest : counters).map((spot) => spot.cell),
    away,
  );
  const ready = [...ovens.filter((spot) => spot.count > 0), ...(busiest.length > 0 ? shelves.filter((spot) => spot.count > 0) : [])];
  const isOven = new Set(ovens.map((spot) => spot.cell));
  // Shoda cesty: pec před policí (plná pec přestane péct).
  const route = (cell: number): number => (away(cell) + manhattan(cell, dest) * BUILDSHIFT.cell) * 2 + (isOven.has(cell) ? 0 : 1);
  if (ready.length > 0) return pick(ready, route);
  const soonest = Math.max(...ovens.map((spot) => spot.bake));
  return pick(
    ovens.filter((spot) => spot.bake === soonest),
    route,
  );
}

/** První stavba z `placements`, která ještě nestojí a jejíž buňka je volná; `null` = vše hotové nebo zastavěné. */
function nextBuild(view: ShiftView, placements: readonly Placement[]): Placement | null {
  return placements.find((at) => (view.stations[at.cell] as number) < 0) ?? null;
}

/**
 * Robot s pevným rozvržením a společnou obsluhou: postaví `layout.opening`, otevře, obsluhuje a během směny staví
 * `layout.later`. Rozvržení s buňkou mimo stavební buňky nebo s dvěma stavbami na jedné buňce je chyba volajícího.
 */
export function serveWithLayout(layout: ShopLayout): BotPiece<BuildshiftBotParams> {
  const all = [...layout.opening, ...layout.later];
  const bad = all.find((at, k) => !isBuildCell(at.cell) || all.findIndex((other) => other.cell === at.cell) !== k);
  if (bad !== undefined) throw new Error(`buildshift bot: cannot build a ${bad.kind} on cell ${String(bad.cell)}`);
  return {
    id: 'buildshift_bot',
    params: botParams,
    roles: ['player', 'target', 'collectible'],
    reactionTicks: BUILDSHIFT_BOT_REACTION,
    cost: () => ({ bodies: 0, rules: 0 }),
    decide: ({ state, player, recent }): ArcadeInput => {
      if (recent.some((input) => (input.buttons & BUTTON.TAP) !== 0)) return NO_INPUT;
      const view = shiftView(state);
      const building = view.phase === PHASE.build;
      const pending = nextBuild(view, building ? layout.opening : all);
      // Na další stavbu v pořadí robot šetří: dokud na ni nemá, nestaví nic.
      const build = pending !== null && view.coins >= STATION_COST[pending.kind] ? pending : null;
      if (build !== null && view.selected === STATION[build.kind]) return tapCell(build.cell);
      if (building) return tapCell(build === null ? PALETTE.open : PALETTE_OF[build.kind]);
      const target = sellerTarget(state, player, view);
      if (target >= 0 && target !== view.target) return tapCell(target);
      return build === null ? NO_INPUT : tapCell(PALETTE_OF[build.kind]);
    },
  };
}

/** Robot světa: rozvržení pravidlem `planLayout` a společná obsluha. */
export const buildshiftBot = serveWithLayout(planLayout());
