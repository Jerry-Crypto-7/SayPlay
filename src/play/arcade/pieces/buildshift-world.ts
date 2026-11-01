/**
 * Směna se stavbou obchodu (P68-S T2) – míry, rozložení stavu a čtení stavu, které sdílí ovládání a pravidla
 * (`buildshift.ts`), robot (`buildshift-bot.ts`) i scéna (`BuildshiftScene.tsx`). Bez chování: jen konstanty
 * a čisté funkce nad stavem, celá čísla.
 *
 * **Mřížka:** deska 5 sloupců × 6 řad (buňky 0–29, řada 0 vzadu, řada 5 u dveří) a pod ní řada palety (buňky 30–34:
 * Oven, Counter, Shelf, mince, Open). Ťuk nese buňku v ose (`axisOfCell` z `lanes.ts`), takže stavba i provoz jdou
 * dnešním záznamem, výzvou i serverovým replayem beze změny. Dveře a dva kusy přední zdi jsou pevné, zbytek desky se
 * dá zastavět.
 */

import { ARCADE_HZ, AXIS_MAX, type ArcadeState, BODY, COUNTER, FLAG, HEADER, ROLE, UNIT, bodyBase } from '../contract';

// ---------------------------------------------------------------------------
// Míry

export const BUILDSHIFT = {
  cols: 5,
  rows: 6,
  /** Rozestup buněk ve světě (2 m). */
  cell: 2 * UNIT,
  /** Vchod (řada 5, prostřední sloupec): odtud přicházejí zákazníci. */
  door: 27,
  /** Pevná přední zeď vedle dveří: nedá se na ni stavět. */
  walls: [25, 29] as readonly number[],
  /** Kde prodavač stojí na začátku (uprostřed obchodu). */
  sellerStart: 17,
  /** Tiky na buňku: prodavač (0,33 s) a zákazník (0,5 s). Cesta = Manhattanova vzdálenost × tiky na buňku. */
  sellerTicks: 20,
  customerTicks: 30,
  /** Mince na začátku a cena za obslouženého zákazníka. */
  startCoins: 6,
  price: 1,
  /** Body za obslouženého zákazníka. */
  points: 10,
  /** Fáze stavby: nejdéle tolik tiků (10 s), pak se obchod otevře sám. */
  buildTicks: 10 * ARCADE_HZ,
  /** Pec upeče jednu věc za tolik tiků (2 s) a drží nejvýš `ovenCap` hotových. */
  bakeTicks: 2 * ARCADE_HZ,
  ovenCap: 2,
  /** Police drží nejvýš tolik věcí. */
  shelfCap: 3,
  /** Trpělivost zákazníka od vstupu do dveří (15 s); kdo nedostane věc do té doby, odejde. */
  patience: 15 * ARCADE_HZ,
  /** Kolik odešlých zákazníků směna unese (životy). */
  walkouts: 4,
  /** Cíl směny: obsloužit tolik zákazníků (věta „serve 12 cats“). */
  goal: { min: 6, max: 20, default: 12 },
  /** Hodiny celé směny (s, pravidlo `time_limit`): prohra před horizontem ověření 90 s. */
  seconds: 88,
  /** Příchody: první zákazník tolik tiků po otevření, poslední nejpozději tolik tiků po otevření. */
  firstArrival: ARCADE_HZ,
  arrivalSpan: 60 * ARCADE_HZ,
  /** Rozestup fronty u pultu (zákazník stojí před pultem směrem ke dveřím). */
  queueGap: 700,
  queueFront: 900,
  seller: { w: 900, h: 1700, d: 900 },
  customer: { w: 800, h: 1400, d: 800 },
  station: { w: 1800, h: 1100, d: 1800 },
} as const;

/** Buněk desky a celé mřížky (deska + paleta). */
export const BOARD_CELLS = BUILDSHIFT.cols * BUILDSHIFT.rows;
export const PALETTE_ROW = BUILDSHIFT.rows;
export const GRID_CELLS = BOARD_CELLS + BUILDSHIFT.cols;

/** Druhy stanovišť: kód v hashovaném stavu (výběr palety), cena a buňka palety. Čísla jsou součást hashe. */
export const STATION = { oven: 1, counter: 2, shelf: 3 } as const;
export type StationKind = keyof typeof STATION;
export type StationCode = (typeof STATION)[StationKind];
export const STATION_KINDS: readonly StationKind[] = ['oven', 'counter', 'shelf'];
export const STATION_COST: Readonly<Record<StationKind, number>> = { oven: 3, counter: 2, shelf: 1 };

/** Buňky palety: druh stanoviště, mince (jen ukazatel) a Open. */
export const PALETTE = { oven: BOARD_CELLS, counter: BOARD_CELLS + 1, shelf: BOARD_CELLS + 2, coins: BOARD_CELLS + 3, open: BOARD_CELLS + 4 } as const;

/** Nejvyšší osa, kterou hra pošle (buňka Open + 1); drží se pod `AXIS_MAX`. */
export const MAX_CELL_AXIS = GRID_CELLS;
if (MAX_CELL_AXIS >= AXIS_MAX) throw new Error('buildshift: the grid does not fit the input axis');

/** Role těl. Stanoviště jsou cíle obsluhy (`target`), zákazníci věci pravidel (`collectible` – hráč je „sbírá“ obsluhou). */
export const STATION_ROLE = ROLE.target;
export const CUSTOMER_ROLE = ROLE.collectible;

/** Tělesa úrovně v pořadí (indexy jsou součást hashe): prodavač, počítadlo směny, předlohy stanovišť a zákazníka. */
export const BUILDSHIFT_BODIES = { seller: 0, keeper: 1, oven: 2, counter: 3, shelf: 4, customer: 5 } as const;

/** Předloha stanoviště podle kódu druhu. */
export const templateOf = (code: number): number => BUILDSHIFT_BODIES.keeper + code;

/**
 * Stav směny na těle-počítadle (mrtvá předloha za prodavačem): fáze (0 stavba, 1 provoz), mince, vybraný druh palety
 * (0 = nic), co prodavač nese (0/1), cíl prodavače (buňka + 1, 0 = stojí), tik otevření, žádost o stavbu tohoto tiku
 * (buňka + 1 a kód druhu – stanoviště vystaví pravidlo `buildshift_build`), obsloužení a odešlí v tomto tiku
 * (pravidlo `buildshift_shift` z nich udělá efekty) a poslední zamítnutý ťuk (buňka + 1, scéna jím zatřese).
 * Píše jen ovládání, pravidla čtou.
 */
export const SHIFT_SLOTS = {
  phase: BODY.x,
  coins: BODY.y,
  selected: BODY.z,
  carrying: BODY.vx,
  target: BODY.vy,
  openTick: BODY.vz,
  buildCell: BODY.w,
  buildKind: BODY.h,
  served: BODY.d,
  walked: BODY.aux0,
  rejected: BODY.aux1,
} as const;

export const PHASE = { build: 0, open: 1 } as const;

/**
 * Stanoviště (živá kopie předlohy): `aux0` = postup pečení (pec), `aux1` = hotové věci (pec) nebo zásoba (police).
 * Zákazník: `aux0` = tik příchodu + 1, `aux1` = pult (buňka + 1, 0 = ještě žádný).
 */
export const STATION_SLOTS = { bake: BODY.aux0, stock: BODY.aux1 } as const;
export const CUSTOMER_SLOTS = { arrived: BODY.aux0, counter: BODY.aux1 } as const;

// ---------------------------------------------------------------------------
// Buňky

export const colOf = (cell: number): number => cell % BUILDSHIFT.cols;
export const rowOf = (cell: number): number => Math.floor(cell / BUILDSHIFT.cols);
export const cellOf = (col: number, row: number): number => row * BUILDSHIFT.cols + col;

/** Střed buňky desky ve světě: x do stran, z k dveřím (+z). Řada palety leží před deskou. */
export const cellX = (cell: number): number => (colOf(cell) - (BUILDSHIFT.cols - 1) / 2) * BUILDSHIFT.cell;
export const cellZ = (cell: number): number => Math.trunc(((2 * rowOf(cell) - (BUILDSHIFT.rows - 1)) * BUILDSHIFT.cell) / 2);

export const manhattan = (a: number, b: number): number => Math.abs(colOf(a) - colOf(b)) + Math.abs(rowOf(a) - rowOf(b));

/** Buňka desky, na kterou se dá stavět (ne dveře, ne zeď, ne paleta). */
export const isBuildCell = (cell: number): boolean => cell >= 0 && cell < BOARD_CELLS && cell !== BUILDSHIFT.door && !BUILDSHIFT.walls.includes(cell);

/** Buňka desky pod bodem světa, nebo −1. */
export function cellAtWorld(x: number, z: number): number {
  const col = Math.round(x / BUILDSHIFT.cell + (BUILDSHIFT.cols - 1) / 2);
  const row = Math.round((2 * z) / BUILDSHIFT.cell + (BUILDSHIFT.rows - 1)) / 2;
  if (!Number.isInteger(row) || col < 0 || col >= BUILDSHIFT.cols || row < 0 || row >= BUILDSHIFT.rows) return -1;
  return cellOf(col, row);
}

// ---------------------------------------------------------------------------
// Čtení stavu

export const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
export const kindOf = (state: ArcadeState, body: number): number => state[bodyBase(body) + BODY.kind] as number;
export const shiftSlot = (state: ArcadeState, slot: number, keeper: number = BUILDSHIFT_BODIES.keeper): number => state[bodyBase(keeper) + slot] as number;

export const phaseOf = (state: ArcadeState, keeper?: number): number => shiftSlot(state, SHIFT_SLOTS.phase, keeper);
export const coinsOf = (state: ArcadeState, keeper?: number): number => shiftSlot(state, SHIFT_SLOTS.coins, keeper);
export const selectedOf = (state: ArcadeState, keeper?: number): number => shiftSlot(state, SHIFT_SLOTS.selected, keeper);
export const carryingOf = (state: ArcadeState, keeper?: number): number => shiftSlot(state, SHIFT_SLOTS.carrying, keeper);
export const targetOf = (state: ArcadeState, keeper?: number): number => shiftSlot(state, SHIFT_SLOTS.target, keeper) - 1;
export const openTickOf = (state: ArcadeState, keeper?: number): number => shiftSlot(state, SHIFT_SLOTS.openTick, keeper);

/** Obsloužených zákazníků (čítač `items`) a odešlých (životy, které ubyly). */
export const servedOf = (state: ArcadeState): number => state[HEADER.counters + COUNTER.items] as number;
export const walkoutsLeft = (state: ArcadeState): number => state[HEADER.counters + COUNTER.health] as number;

/** Živá těla s rolí a modelem předlohy `template` (stanoviště jednoho druhu, zákazníci), v pořadí indexů. */
export function copiesOf(state: ArcadeState, template: number): number[] {
  const kind = kindOf(state, template);
  const role = state[bodyBase(template) + BODY.role];
  const out: number[] = [];
  for (let i = state[HEADER.spawnBase] as number; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === role && state[base + BODY.kind] === kind && alive(state, i)) out.push(i);
  }
  return out;
}

/** Buňka, na které tělo stojí (stanoviště stojí přesně ve středu). */
export const bodyCell = (state: ArcadeState, body: number): number => cellAtWorld(state[bodyBase(body) + BODY.x] as number, state[bodyBase(body) + BODY.z] as number);

/** Kód druhu stanoviště tělesa (podle modelu předlohy), nebo 0, když tělo stanoviště není. */
export function stationCode(state: ArcadeState, body: number): number {
  if (state[bodyBase(body) + BODY.role] !== STATION_ROLE || !alive(state, body)) return 0;
  for (const kind of STATION_KINDS) if (kindOf(state, body) === kindOf(state, templateOf(STATION[kind]))) return STATION[kind];
  return 0;
}

/** Stanoviště po buňkách desky: index těla, nebo −1. */
export function stationsByCell(state: ArcadeState): Int32Array {
  const out = new Int32Array(BOARD_CELLS).fill(-1);
  for (let i = state[HEADER.spawnBase] as number; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (stationCode(state, i) === 0) continue;
    const cell = bodyCell(state, i);
    if (cell >= 0) out[cell] = i;
  }
  return out;
}

/** Živí zákazníci v pořadí příchodu (shoda = nižší index). */
export function customersOf(state: ArcadeState): number[] {
  const out = copiesOf(state, BUILDSHIFT_BODIES.customer);
  return out.sort((a, b) => (state[bodyBase(a) + CUSTOMER_SLOTS.arrived] as number) - (state[bodyBase(b) + CUSTOMER_SLOTS.arrived] as number) || a - b);
}

/** Pult zákazníka (buňka), nebo −1. */
export const counterOfCustomer = (state: ArcadeState, customer: number): number => (state[bodyBase(customer) + CUSTOMER_SLOTS.counter] as number) - 1;

/** Fronta u pultu v buňce `cell`: zákazníci, kteří k němu patří, v pořadí příchodu. */
export const queueAt = (state: ArcadeState, cell: number): number[] => customersOf(state).filter((c) => counterOfCustomer(state, c) === cell);

/** Místo `k`-tého ve frontě u pultu v buňce `cell`: před pultem směrem ke dveřím, další za ním. */
export function queueSpot(cell: number, k: number): { readonly x: number; readonly z: number } {
  return { x: cellX(cell), z: cellZ(cell) + BUILDSHIFT.queueFront + k * BUILDSHIFT.queueGap };
}

/** Stojí zákazník na svém místě ve frontě (došel k pultu)? */
export function atQueueSpot(state: ArcadeState, customer: number, k: number): boolean {
  const cell = counterOfCustomer(state, customer);
  if (cell < 0) return false;
  const spot = queueSpot(cell, k);
  const base = bodyBase(customer);
  return state[base + BODY.x] === spot.x && state[base + BODY.z] === spot.z;
}

/** Stojí prodavač ve středu buňky `cell`? */
export function sellerAt(state: ArcadeState, player: number, cell: number): boolean {
  const base = bodyBase(player);
  return state[base + BODY.x] === cellX(cell) && state[base + BODY.z] === cellZ(cell);
}

/** Kolik zákazníků přijde za směnu s cílem `goal`: cíl a rezerva (aspoň 4, jinak půlka cíle). */
export const customersFor = (goal: number): number => goal + Math.max(4, Math.ceil(goal / 2));

/** Rozpis směny pro scénu a robota: fáze, mince, výběr, nese, cíl, obslouženo, zbývající odchody, stanoviště po buňkách. */
export interface ShiftView {
  readonly phase: number;
  readonly coins: number;
  readonly selected: number;
  readonly carrying: number;
  readonly target: number;
  readonly served: number;
  readonly walkoutsLeft: number;
  readonly stations: Int32Array;
}

export function shiftView(state: ArcadeState): ShiftView {
  return {
    phase: phaseOf(state),
    coins: coinsOf(state),
    selected: selectedOf(state),
    carrying: carryingOf(state),
    target: targetOf(state),
    served: servedOf(state),
    walkoutsLeft: walkoutsLeft(state),
    stations: stationsByCell(state),
  };
}
