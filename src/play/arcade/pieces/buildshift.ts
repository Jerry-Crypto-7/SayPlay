/**
 * Směna se stavbou obchodu (P68-S T2): hráč z omezeného rozpočtu mincí postaví na mřížce obchodu pece, pulty
 * a police, otevře a pak posílá prodavače mezi nimi; zákazníci z věty přicházejí dveřmi, řadí se k pultům a kdo
 * nedostane svou věc včas, odejde. Cíl = obsloužit počet zákazníků z věty. **Rozvržení mění propustnost:** cesta
 * prodavače i zákazníka trvá Manhattanovu vzdálenost × tiky na buňku, pec peče v taktu, pult je fronta.
 *
 * **Vstup:** ťuk s buňkou v ose (`axisOfCell` v `lanes.ts`; plátno ji spočítá z `data-lane-cells` – `cellAxisAt`).
 * Ťuk na druh v paletě ho vybere (stav je hashovaný), ťuk na desku ve fázi stavby postaví vybraný druh, ve fázi
 * provozu pošle prodavače (s vybraným druhem a volnou buňkou postaví, i během směny za vydělané mince). Open otevře;
 * po `BUILDSHIFT.buildTicks` se obchod otevře sám (nečinný hráč otevře prázdný obchod a prohraje).
 *
 * **Kdo co dělá v tiku:**
 * - ovládání `buildshift`: ťuk (výběr, stavba – mince ubude hned –, cíl prodavače, Open), pečení, prodavač (chůze
 *   po ose x, pak z; v cíli vezme hotovou věc z pece, odloží nebo vezme na polici, obslouží prvního ve frontě),
 *   zákazníci (trpělivost, přiřazení k pultu s nejkratší frontou, chůze na místo ve frontě);
 * - `buildshift_build` (stisk, hned za ovládáním): vystaví stanoviště z předlohy na buňce žádosti o stavbu;
 * - `buildshift_shift` (tik): příchody zákazníků dveřmi podle rozpisu od otevření a rush v posledních 15 s hodin
 *   (T10), obsloužení → `items` a body, odchody → ztráta života;
 * - `buildshift_goal` (čítače): obslouženo ≥ cíl = výhra; `out_of_health` = moc odchodů, `time_limit` = konec směny.
 *
 * Determinismus: celá čísla, náhoda jen při stavbě (příchody z `pure-rand` přes `createCompileRng`, stream `spawn`),
 * čas v tikách. Míry a čtení stavu jsou v `buildshift-world.ts`.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  type ArcadeState,
  BODY,
  BUTTON,
  type BodyInit,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  type RulePiece,
  bodyBase,
} from '../contract';
import {
  BOARD_CELLS,
  BUILDSHIFT,
  BUILDSHIFT_BODIES,
  CUSTOMER_SLOTS,
  PALETTE,
  PHASE,
  RUSH_START,
  SHIFT_SLOTS,
  STATION,
  STATION_COST,
  STATION_KINDS,
  STATION_SLOTS,
  atQueueSpot,
  cellX,
  cellZ,
  copiesOf,
  customersFor,
  customersOf,
  isBuildCell,
  manhattan,
  queueAt,
  queueSpot,
  rushFor,
  sellerAt,
  stationCode,
  stationsByCell,
  templateOf,
} from './buildshift-world';
import { cellOfAxis } from './lanes';

export * from './buildshift-world';

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/** Rychlost chůze (jednotek za tik) z tiků na buňku. */
const SELLER_SPEED = BUILDSHIFT.cell / BUILDSHIFT.sellerTicks;
const CUSTOMER_SPEED = Math.trunc(BUILDSHIFT.cell / BUILDSHIFT.customerTicks);

/** Kód druhu → druh (paleta). */
const KIND_OF_CODE: Readonly<Record<number, (typeof STATION_KINDS)[number]>> = { [STATION.oven]: 'oven', [STATION.counter]: 'counter', [STATION.shelf]: 'shelf' };

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z.object({ keeper: index }).strict();
export type BuildshiftControlParams = z.infer<typeof controlParams>;

const slot = (keeper: number, name: keyof typeof SHIFT_SLOTS): number => bodyBase(keeper) + SHIFT_SLOTS[name];

/** Obchod se otevře: provoz začíná a příchody zákazníků se počítají od tohoto tiku. */
function open(state: ArcadeState, keeper: number): void {
  state[slot(keeper, 'phase')] = PHASE.open;
  state[slot(keeper, 'openTick')] = state[HEADER.tick] as number;
  state[slot(keeper, 'selected')] = 0;
}

/** Stavba na buňce: jen volná stavební buňka a jen s dostatkem mincí; mince ubude hned, stanoviště vystaví pravidlo. */
function tryBuild(state: ArcadeState, keeper: number, cell: number, code: number): boolean {
  const kind = KIND_OF_CODE[code];
  const coins = state[slot(keeper, 'coins')] as number;
  if (kind === undefined || !isBuildCell(cell) || stationsByCell(state)[cell] !== -1 || coins < STATION_COST[kind]) {
    state[slot(keeper, 'rejected')] = cell + 1;
    return false;
  }
  state[slot(keeper, 'coins')] = coins - STATION_COST[kind];
  state[slot(keeper, 'buildCell')] = cell + 1;
  state[slot(keeper, 'buildKind')] = code;
  return true;
}

/** Ťuk na buňku mřížky: paleta vybere druh nebo otevře, deska staví (stavba) nebo pošle prodavače (provoz). */
function tap(state: ArcadeState, keeper: number, cell: number): void {
  const phase = state[slot(keeper, 'phase')] as number;
  if (cell === PALETTE.oven || cell === PALETTE.counter || cell === PALETTE.shelf) {
    state[slot(keeper, 'selected')] = STATION[STATION_KINDS[cell - PALETTE.oven] as (typeof STATION_KINDS)[number]];
    return;
  }
  if (cell === PALETTE.open) {
    if (phase === PHASE.build) open(state, keeper);
    return;
  }
  if (cell < 0 || cell >= BOARD_CELLS) return;
  const selected = state[slot(keeper, 'selected')] as number;
  if (phase === PHASE.build) {
    if (selected > 0) tryBuild(state, keeper, cell, selected);
    else state[slot(keeper, 'rejected')] = cell + 1;
    return;
  }
  // Provoz: vybraný druh na volnou stavební buňku = stavba za vydělané mince; jinak tam jde prodavač.
  state[slot(keeper, 'selected')] = 0;
  if (selected > 0 && isBuildCell(cell) && stationsByCell(state)[cell] === -1) {
    tryBuild(state, keeper, cell, selected);
    return;
  }
  state[slot(keeper, 'target')] = cell + 1;
}

/** Pece pečou: postup o tik, hotová věc po `bakeTicks`, nejvýš `ovenCap` hotových. */
function bake(state: ArcadeState): void {
  for (const oven of copiesOf(state, BUILDSHIFT_BODIES.oven)) {
    const base = bodyBase(oven);
    if ((state[base + STATION_SLOTS.stock] as number) >= BUILDSHIFT.ovenCap) continue;
    const progress = (state[base + STATION_SLOTS.bake] as number) + 1;
    if (progress >= BUILDSHIFT.bakeTicks) {
      state[base + STATION_SLOTS.bake] = 0;
      state[base + STATION_SLOTS.stock] = (state[base + STATION_SLOTS.stock] as number) + 1;
    } else state[base + STATION_SLOTS.bake] = progress;
  }
}

/**
 * Prodavač v cíli: u pece vezme hotovou věc (počká, až bude), u police věc odloží (nese-li) nebo vezme, u pultu
 * obslouží prvního ve frontě, který už stojí u pultu (počká na něj, nese-li věc). Hotová akce cíl smaže – prodavač stojí.
 */
function act(state: ArcadeState, keeper: number, cell: number): void {
  const station = stationsByCell(state)[cell] as number;
  const code = station < 0 ? 0 : stationCode(state, station);
  const carrying = (state[slot(keeper, 'carrying')] as number) > 0;
  const done = (): void => {
    state[slot(keeper, 'target')] = 0;
  };
  if (code === STATION.oven) {
    if (carrying) return done();
    const at = bodyBase(station) + STATION_SLOTS.stock;
    if ((state[at] as number) === 0) return;
    state[at] = (state[at] as number) - 1;
    state[slot(keeper, 'carrying')] = 1;
    return done();
  }
  if (code === STATION.shelf) {
    const at = bodyBase(station) + STATION_SLOTS.stock;
    if (carrying && (state[at] as number) < BUILDSHIFT.shelfCap) {
      state[at] = (state[at] as number) + 1;
      state[slot(keeper, 'carrying')] = 0;
    } else if (!carrying && (state[at] as number) > 0) {
      state[at] = (state[at] as number) - 1;
      state[slot(keeper, 'carrying')] = 1;
    }
    return done();
  }
  if (code === STATION.counter) {
    if (!carrying) return done();
    const first = queueAt(state, cell)[0];
    if (first === undefined || !atQueueSpot(state, first, 0)) return;
    const base = bodyBase(first);
    state[base + BODY.flags] = (state[base + BODY.flags] as number) & ~FLAG.alive;
    state[slot(keeper, 'carrying')] = 0;
    state[slot(keeper, 'coins')] = (state[slot(keeper, 'coins')] as number) + BUILDSHIFT.price;
    state[slot(keeper, 'served')] = (state[slot(keeper, 'served')] as number) + 1;
    return done();
  }
  done();
}

/** Prodavač jde k cíli po ose x, pak z (Manhattanova cesta); v cíli jedná. Bez cíle stojí. */
function stepSeller(state: ArcadeState, player: number, keeper: number): void {
  const p = bodyBase(player);
  state[p + BODY.vx] = 0;
  state[p + BODY.vz] = 0;
  const target = (state[slot(keeper, 'target')] as number) - 1;
  if (target < 0) return;
  if (sellerAt(state, player, target)) {
    act(state, keeper, target);
    return;
  }
  const dx = cellX(target) - (state[p + BODY.x] as number);
  const dz = cellZ(target) - (state[p + BODY.z] as number);
  if (dx !== 0) state[p + BODY.vx] = Math.max(-SELLER_SPEED, Math.min(SELLER_SPEED, dx));
  else state[p + BODY.vz] = Math.max(-SELLER_SPEED, Math.min(SELLER_SPEED, dz));
}

/** Pult s nejkratší frontou (shoda = blíž ke dveřím, pak nižší buňka), nebo −1, když žádný není. */
function shortestCounter(state: ArcadeState): number {
  let best = -1;
  let bestKey = Number.MAX_SAFE_INTEGER;
  for (const counter of copiesOf(state, BUILDSHIFT_BODIES.counter)) {
    const cell = stationsByCell(state).indexOf(counter);
    if (cell < 0) continue;
    const key = queueAt(state, cell).length * 10_000 + manhattan(cell, BUILDSHIFT.door) * 100 + cell;
    if (key < bestKey) {
      best = cell;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Zákazníci: nový si zapíše tik příchodu; kdo čeká déle než `patience`, odejde (ztráta); bez pultu čeká u dveří,
 * jinak si vybere pult s nejkratší frontou a jde na své místo ve frontě (po ose z, pak x).
 */
function stepCustomers(state: ArcadeState, keeper: number): void {
  const tick = state[HEADER.tick] as number;
  for (const c of customersOf(state)) {
    const base = bodyBase(c);
    state[base + BODY.vx] = 0;
    state[base + BODY.vz] = 0;
    if ((state[base + CUSTOMER_SLOTS.arrived] as number) === 0) state[base + CUSTOMER_SLOTS.arrived] = tick + 1;
    if (tick - ((state[base + CUSTOMER_SLOTS.arrived] as number) - 1) >= BUILDSHIFT.patience) {
      state[base + BODY.flags] = (state[base + BODY.flags] as number) & ~FLAG.alive;
      state[slot(keeper, 'walked')] = (state[slot(keeper, 'walked')] as number) + 1;
    }
  }
  for (const c of customersOf(state)) {
    if ((state[bodyBase(c) + CUSTOMER_SLOTS.counter] as number) > 0) continue;
    const counter = shortestCounter(state);
    if (counter >= 0) state[bodyBase(c) + CUSTOMER_SLOTS.counter] = counter + 1;
  }
  const counters = stationsByCell(state);
  for (let cell = 0; cell < BOARD_CELLS; cell += 1) {
    if ((counters[cell] as number) < 0 || stationCode(state, counters[cell] as number) !== STATION.counter) continue;
    queueAt(state, cell).forEach((c, k) => {
      const base = bodyBase(c);
      const spot = queueSpot(cell, k);
      const dz = spot.z - (state[base + BODY.z] as number);
      const dx = spot.x - (state[base + BODY.x] as number);
      if (dz !== 0) state[base + BODY.vz] = Math.max(-CUSTOMER_SPEED, Math.min(CUSTOMER_SPEED, dz));
      else state[base + BODY.vx] = Math.max(-CUSTOMER_SPEED, Math.min(CUSTOMER_SPEED, dx));
    });
  }
}

/**
 * Ovládání směny. Pořadí v tiku: smazat žádosti minulého tiku → ťuk → samo otevření po okně stavby → (provoz) pečení,
 * prodavač, zákazníci.
 */
export const buildshiftControl: ControlPiece<BuildshiftControlParams> = {
  id: 'buildshift',
  params: controlParams,
  roles: ['player', 'target', 'collectible'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const { keeper } = params;
    state[slot(keeper, 'buildCell')] = 0;
    state[slot(keeper, 'buildKind')] = 0;
    state[slot(keeper, 'served')] = 0;
    state[slot(keeper, 'walked')] = 0;
    if ((input.buttons & BUTTON.TAP) !== 0 && input.axis > 0) tap(state, keeper, cellOfAxis(input.axis));
    if ((state[slot(keeper, 'phase')] as number) === PHASE.build && (state[HEADER.tick] as number) >= BUILDSHIFT.buildTicks) open(state, keeper);
    if ((state[slot(keeper, 'phase')] as number) !== PHASE.open) return;
    bake(state);
    stepSeller(state, player, keeper);
    stepCustomers(state, keeper);
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const keeperParams = z.object({ keeper: index }).strict();

/** Stavba (stisk, hned za ovládáním): stanoviště z předlohy druhu na buňce žádosti, ještě v tomto tiku. */
export const buildshiftBuild: RulePiece<z.infer<typeof keeperParams>> = {
  id: 'buildshift_build',
  params: keeperParams,
  roles: ['target'],
  trigger: 'press',
  cost: () => ({ bodies: 1, rules: 1 }),
  fire: ({ state }, params) => {
    const cell = (state[slot(params.keeper, 'buildCell')] as number) - 1;
    const code = state[slot(params.keeper, 'buildKind')] as number;
    if (cell < 0 || code === 0) return [];
    return [{ kind: 'spawn', template: templateOf(code), x: cellX(cell), y: 0, z: cellZ(cell), vx: 0, vy: 0, vz: 0 }];
  },
};

const shiftParams = z
  .object({
    keeper: index,
    customer: index,
    /** Příchody zákazníků v ticích od otevření, vzestupně. */
    arrivals: z.array(z.int().min(1).max(ARCADE_LIMITS.maxTicks)).min(1).max(64),
    points: z.int().min(1).max(100),
    /**
     * Příchody rushe (T10) v ticích hodin (absolutně, jako `time_limit`), vzestupně. Volitelné: svět uložený před T10
     * pole nemá a přehraje se beze změny.
     */
    rush: z.array(z.int().min(1).max(ARCADE_LIMITS.maxTicks)).max(16).optional(),
  })
  .strict();
export type BuildshiftShiftParams = z.infer<typeof shiftParams>;

/** Průběh směny (tik): příchody dveřmi podle rozpisu a rushe, obsloužení → `items` a body, odchody → ztráta života. */
export const buildshiftShift: RulePiece<BuildshiftShiftParams> = {
  id: 'buildshift_shift',
  params: shiftParams,
  roles: ['player', 'collectible'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    const effects: ArcadeEffect[] = [];
    const served = state[slot(params.keeper, 'served')] as number;
    const walked = state[slot(params.keeper, 'walked')] as number;
    if (served > 0) effects.push({ kind: 'count', counter: 'items', amount: served }, { kind: 'score', amount: served * params.points });
    if (walked > 0) effects.push({ kind: 'damage', amount: walked });
    if ((state[slot(params.keeper, 'phase')] as number) !== PHASE.open) return effects;
    const tick = state[HEADER.tick] as number;
    const since = tick - (state[slot(params.keeper, 'openTick')] as number);
    const arrive = (): void => {
      effects.push({ kind: 'spawn', template: params.customer, x: cellX(BUILDSHIFT.door), y: 0, z: cellZ(BUILDSHIFT.door), vx: 0, vy: 0, vz: 0 });
    };
    for (const at of params.arrivals) if (at === since) arrive();
    for (const at of params.rush ?? []) if (at === tick) arrive();
    return effects;
  },
};

const goalParams = z.object({ goal: z.int().min(BUILDSHIFT.goal.min).max(BUILDSHIFT.goal.max) }).strict();

/** Cíl směny (čítače, po efektech tiku): obslouženo ≥ cíl = výhra. */
export const buildshiftGoal: RulePiece<z.infer<typeof goalParams>> = {
  id: 'buildshift_goal',
  params: goalParams,
  roles: ['player'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => ((state[HEADER.counters + COUNTER.items] as number) >= params.goal ? [{ kind: 'win' }] : []),
};

/** Pravidla směny – `library.ts` je rozbalí do `rules`. */
export const BUILDSHIFT_RULES: Readonly<Record<string, RulePiece>> = {
  buildshift_build: buildshiftBuild as RulePiece,
  buildshift_shift: buildshiftShift as RulePiece,
  buildshift_goal: buildshiftGoal as RulePiece,
};

// ---------------------------------------------------------------------------
// Generátor

export const buildshiftParams = z
  .object({
    /** Kolik zákazníků obsloužit (věta „serve 12 cats“, `paramBounds` žánru). */
    goal: z.int().min(BUILDSHIFT.goal.min).max(BUILDSHIFT.goal.max).default(BUILDSHIFT.goal.default),
  })
  .strict();
export type BuildshiftParams = z.infer<typeof buildshiftParams>;

/**
 * Příchody `count` zákazníků v ticích od otevření: první po `firstArrival`, poslední nejpozději `arrivalSpan` po něm,
 * rozestupy z vah 60–140 % ze streamu `spawn` (jiné semínko = jiné příchody), vzestupně a každý v jiném tiku.
 */
export function arrivalTicks(seed: number, count: number): number[] {
  const rng = createCompileRng(seed, 'spawn');
  const weights = Array.from({ length: count - 1 }, () => rng.int(60, 140));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const out: number[] = [BUILDSHIFT.firstArrival];
  let acc = 0;
  for (const weight of weights) {
    acc += weight;
    out.push(Math.max((out.at(-1) as number) + 1, BUILDSHIFT.firstArrival + Math.floor((BUILDSHIFT.arrivalSpan * acc) / total)));
  }
  return out;
}

/**
 * Příchody rushe v ticích hodin: první v `RUSH_START`, všechny do `rushSpan` po něm, rozestupy z vah 60–140 % ze streamu
 * `pacing` (příchody směny losuje `spawn`, takže se rozpisy navzájem nepohnou), vzestupně a každý v jiném tiku.
 */
export function rushTicks(seed: number, count: number): number[] {
  const rng = createCompileRng(seed, 'pacing');
  const weights = Array.from({ length: count }, () => rng.int(60, 140));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const out: number[] = [];
  let acc = 0;
  for (const weight of weights) {
    out.push(Math.max((out.at(-1) ?? RUSH_START - 1) + 1, RUSH_START + Math.floor((BUILDSHIFT.rushSpan * acc) / total)));
    acc += weight;
  }
  return out;
}

const body = (role: BodyInit['role'], kind: string, size: { readonly w: number; readonly h: number; readonly d: number }, extra: Partial<BodyInit> = {}): BodyInit => ({ role, kind, x: 0, y: 0, z: 0, ...size, solid: false, ...extra });

/**
 * Tělesa úrovně: prodavač uprostřed obchodu, počítadlo směny (mrtvé; `y` = mince na začátku – `SHIFT_SLOTS.coins`),
 * předlohy pece, pultu, police a zákazníka.
 */
function shopLevel(): BodyInit[] {
  return [
    body('player', 'player', BUILDSHIFT.seller, { x: cellX(BUILDSHIFT.sellerStart), z: cellZ(BUILDSHIFT.sellerStart) }),
    body('thing', 'player', { w: 1, h: 1, d: 1 }, { template: true, y: BUILDSHIFT.startCoins }),
    body('target', 'oven', BUILDSHIFT.station, { template: true }),
    body('target', 'counter', BUILDSHIFT.station, { template: true }),
    body('target', 'shelf', BUILDSHIFT.station, { template: true }),
    body('collectible', 'customer', BUILDSHIFT.customer, { template: true }),
  ];
}

/**
 * Volné sloty spawnu: všechna stanoviště na stavebních buňkách a všichni zákazníci směny s největším cílem. Rush se
 * nepřičítá: jádro bere sloty odešlých a obsloužených zákazníků znovu a v rushi jich žije nejvýš 7 + doznívající
 * řádné příchody (počet slotů je součást stavu, přičtení by pohnulo otiskem každé hry).
 */
export const SPAWN_SLOTS = BOARD_CELLS - 1 - BUILDSHIFT.walls.length + customersFor(BUILDSHIFT.goal.max);

/** Tvrzení „hratelné z konstrukce“ nad úrovní a příchody; prázdné pole = hratelné. */
export function checkShopLevel(level: ArcadeLevel, arrivals: readonly number[], goal: number): string[] {
  const issues: string[] = [];
  if (level.bodies[0]?.role !== 'player') issues.push('no player');
  if (arrivals.length < goal) issues.push(`only ${String(arrivals.length)} customers for a goal of ${String(goal)}`);
  if (arrivals.some((at, k) => at < 1 || (k > 0 && at <= (arrivals[k - 1] as number)))) issues.push('arrivals are out of order');
  if (BUILDSHIFT.startCoins < STATION_COST.oven + STATION_COST.counter) issues.push('the start coins do not buy an oven and a counter');
  if (level.bodies.length + (level.spawnSlots ?? 0) > ARCADE_LIMITS.maxBodies) issues.push('the shop exceeds the body limit');
  return issues;
}

/**
 * Režim `buildshift.default` (generátor `buildshift_shop`): obchod s paletou, `customersFor(goal)` zákazníků od
 * otevření, cíl `goal`. Životy = kolik zákazníků smí odejít (ze specu, výchozí `BUILDSHIFT.walkouts`); prohra =
 * odchody (`out_of_health`) nebo konec směny (`time_limit`, `BUILDSHIFT.seconds`). Pilulka postupu HUD (`collectNeed`)
 * čte cíl z `finish_collected`; tělo cíle svět nemá, takže nevystřelí.
 */
export const buildshiftShop: ModeGeneratorPiece<BuildshiftParams> = {
  id: 'buildshift_shop',
  params: buildshiftParams,
  roles: ['player', 'target', 'collectible'],
  cost: () => ({ bodies: 6 + SPAWN_SLOTS, rules: 6 }),
  generate: () => ({ bodies: shopLevel(), length: 0, spawnSlots: SPAWN_SLOTS }),
  parts: (seed, params, health): ModeParts => {
    const level: ArcadeLevel = { bodies: shopLevel(), length: 0, spawnSlots: SPAWN_SLOTS };
    const arrivals = arrivalTicks(seed, customersFor(params.goal));
    const { keeper, customer } = BUILDSHIFT_BODIES;
    const rules: PieceRef[] = [
      { id: 'buildshift_build', params: { keeper } },
      { id: 'buildshift_shift', params: { keeper, customer, arrivals, points: BUILDSHIFT.points, rush: rushTicks(seed, rushFor(params.goal)) } },
      { id: 'buildshift_goal', params: { goal: params.goal } },
      { id: 'out_of_health', params: {} },
      { id: 'time_limit', params: { seconds: BUILDSHIFT.seconds } },
      { id: 'finish_collected', params: { need: params.goal } },
    ];
    return {
      control: { id: 'buildshift', params: { keeper } },
      bot: { id: 'buildshift_bot', params: { keeper, goal: params.goal } },
      level,
      rules,
      issues: checkShopLevel(level, arrivals, params.goal),
      health: health ?? BUILDSHIFT.walkouts,
    };
  },
};
