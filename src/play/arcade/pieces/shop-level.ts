/**
 * Obchod se součtem (P83E T2): věci z věty s číselnou cenovkou na polici, jedno odkládací místo (pult s pokladnou,
 * váha, kotel) a součet. Hráč klepne na věc, hrdina pro ni dojde, zvedne ji (`HEADER.held` – nese ji jádro, `follow`),
 * donese ji na pult a položí; součet přičte cenovku. Simulace běží v ovládání `shop` celými čísly, bez fyziky.
 *
 * **Dva cíle:**
 * - **polož N** (`target` 0): na polici je přesně N věcí z věty a všechny musí na pult, než doběhnou hodiny;
 * - **trefa do součtu** (`target` > 0): na polici je víc věcí, než je třeba. Věc, se kterou by součet přetekl nebo by
 *   se cíl už nedal přesně trefit zbytkem police, pult odmítne (vrátí se na polici) a stojí život. Cíl je součet
 *   skutečné podmnožiny police, takže řešení existuje vždy; `checkShopLevel` to při generování ještě ověří.
 *
 * **Těla:** hrdina (0), věci police (`first` … `first + count − 1`; HP = cenovka v jednotkách hry, stav cíle
 * `SHOP_STATE`, `aux1` = tik zařazení do fronty + 1, na pultu `aux0` = pořadí položení od 1 – účtenka), počítadlo
 * (mrtvá předloha, `KEEP`).
 *
 * **Jednotka:** cena po 0,50 (cenovka v půlkách: 1–18 = $0.50–$9.00), váha a prosté číslo 1–9.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeInput, type ArcadeLevel, BODY, BUTTON, type BodyInit, HEADER, bodyBase, bodyHp, setTargetState, targetStateOf } from '../contract';
import { cellOfAxis } from './lanes';

export const SHOP = {
  /** Věcí na polici v cíli „polož N“ (a nápověda počtu dílů trefy). */
  items: { min: 2, max: 8, default: 3 },
  /** Kolik věcí tvoří cílový součet trefy. */
  parts: { max: 6 },
  /** Cílový součet ve jednotkách věty (dolary, kila, body). */
  target: { min: 2, max: 50 },
  /** Věcí navíc na polici trefy. */
  decoys: 3,
  lives: 3,
  /** Rychlost hrdiny po každé ose (j/tik). */
  speed: 90,
  /** Hodiny: základ + za každou věc police (s). */
  clock: { base: 12, perItem: 5, min: 20, max: 90 },
  /** Tiky, než robot klepne na další věc (po startu a po položení). */
  botPace: 40,
} as const;

export const SHOP_UNITS = ['price', 'weight', 'plain'] as const;
export type ShopUnit = (typeof SHOP_UNITS)[number];

/** Kam věci padají (P83E T7, z věty): pult, mísa, tác, košík, váha, vozík. Jen obraz – jádro má jedno místo. */
export const SHOP_SPOTS = ['counter', 'bowl', 'tray', 'basket', 'scale', 'cart'] as const;
export type ShopSpot = (typeof SHOP_SPOTS)[number];
/** Jméno věci ze scény bez modelu (jmenovka na neutrálním tvaru): nejvýš tolik znaků. */
export const SHOP_NAME_MAX = 24;

/** Nejvyšší cenovka jednotky (v jednotkách hry). */
export const tagMax = (unit: ShopUnit): number => (unit === 'price' ? 18 : 9);
/** Jednotek hry na jednotku věty: cena je v půlkách dolaru. */
export const tagScale = (unit: ShopUnit): number => (unit === 'price' ? 2 : 1);

export const SHOP_LAYOUT = {
  /** Věcí v řadě police; víc věcí jde do horní řady. */
  cols: 4,
  colX: 1500,
  shelfZ: 6000,
  /** Výška spodní a horní police. */
  rowY: [400, 1300],
  /** Jak daleko před věcí nebo pultem hrdina stojí. */
  reach: 900,
  counterZ: 1500,
  counterY: 1000,
  counterSlot: 480,
  item: 600,
  hero: { w: 1000, h: 1600, d: 800 },
} as const;

/** Stav cíle věci. */
export const SHOP_STATE = { shelf: 0, carried: 1, placed: 2 } as const;

/** Sloty počítadla: součet, položeno, tik položení, věc na cestě (+1), tik odmítnutí, odmítnutí, kurzor. */
export const KEEP = { total: BODY.x, placed: BODY.y, placedAt: BODY.z, walking: BODY.vx, refusedAt: BODY.vy, refused: BODY.vz, cursor: BODY.aux0 } as const;

const body = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);

/** Co o hře vědí ovládání, pravidlo i robot. */
export const shopGameSchema = z
  .object({
    first: body,
    count: z.int().min(1).max(SHOP.items.max),
    keeper: body,
    unit: z.enum(SHOP_UNITS),
    /** Cílový součet v jednotkách hry; 0 = polož všechny věci police. */
    target: z.int().min(0).max(SHOP.target.max * 2),
    /** Kam věci padají; chybí = pult. */
    spot: z.enum(SHOP_SPOTS).optional(),
    /** Jméno věci z věty (jmenovka, když katalog model nemá). */
    name: z.string().min(1).max(SHOP_NAME_MAX).optional(),
    /** Model kulisy po stranách police z kitu místa věty (lékárna, pošta); chybí = regál obchodu. */
    decor: z.string().min(1).max(40).optional(),
  })
  .strict();
export type ShopGame = z.infer<typeof shopGameSchema>;

export const shopParams = z
  .object({
    /** Věcí z věty („three items“ → 3); u trefy nápověda, z kolika věcí se součet skládá. */
    items: z.int().min(SHOP.items.min).max(SHOP.items.max).default(SHOP.items.default),
    unit: z.enum(SHOP_UNITS).default('price'),
    /** Cílový součet v jednotkách věty („exactly 12 dollars“ → 12); chybí = polož všechny. */
    target: z.int().min(SHOP.target.min).max(SHOP.target.max).optional(),
    spot: z.enum(SHOP_SPOTS).optional(),
    name: z.string().min(1).max(SHOP_NAME_MAX).optional(),
    decor: z.string().min(1).max(40).optional(),
  })
  .strict();
export type ShopParams = z.infer<typeof shopParams>;

// ---------------------------------------------------------------------------
// Rozvržení

/** Střed věci na místě police `slot` z `count` (řady po `cols`, kratší řada na středu). */
export function shelfSpot(slot: number, count: number): { readonly x: number; readonly y: number; readonly z: number } {
  const { cols, colX, rowY, shelfZ } = SHOP_LAYOUT;
  const row = Math.floor(slot / cols);
  const inRow = Math.min(cols, count - row * cols);
  const col = slot % cols;
  return { x: Math.round(((2 * col - (inRow - 1)) * colX) / 2), y: rowY[row] as number, z: shelfZ };
}

/** Kde hrdina stojí, když bere věc z místa `slot`. */
export const standAtShelf = (slot: number, count: number): { readonly x: number; readonly z: number } => ({ x: shelfSpot(slot, count).x, z: SHOP_LAYOUT.shelfZ - SHOP_LAYOUT.reach });
/** Kde hrdina stojí u pultu (a kde začíná). */
export const COUNTER_STAND = { x: 0, z: SHOP_LAYOUT.counterZ + SHOP_LAYOUT.reach } as const;

/** Místo `order`-té položené věci (od 0) na pultu pro `count` věcí. */
export const counterSpot = (order: number, count: number): number => Math.round(((2 * order - (count - 1)) * SHOP_LAYOUT.counterSlot) / 2);

// ---------------------------------------------------------------------------
// Součet

/** Dá se z `values` vybrat podmnožina se součtem přesně `sum`? (podmnožinový součet, `sum` ≤ 100) */
export function reachable(values: readonly number[], sum: number): boolean {
  if (sum < 0) return false;
  const can = new Array<boolean>(sum + 1).fill(false);
  can[0] = true;
  for (const value of values) for (let s = sum; s >= value; s -= 1) if (can[s - value] === true) can[s] = true;
  return can[sum] === true;
}

/** Cenovky věcí, které ještě leží na polici. */
export function shelfValues(state: Int32Array, game: ShopGame): number[] {
  const values: number[] = [];
  for (let item = game.first; item < game.first + game.count; item += 1) if (targetStateOf(state, item) === SHOP_STATE.shelf) values.push(bodyHp(state, item));
  return values;
}

/** Vezme pult věc s cenovkou `value` při součtu `total`? Trefa: nepřeteče a zbytek police cíl ještě trefí. */
export function fits(game: ShopGame, total: number, value: number, rest: readonly number[]): boolean {
  if (game.target === 0) return true;
  return total + value <= game.target && reachable(rest, game.target - total - value);
}

export const totalOf = (state: Int32Array, game: ShopGame): number => state[bodyBase(game.keeper) + KEEP.total] as number;
export const placedOf = (state: Int32Array, game: ShopGame): number => state[bodyBase(game.keeper) + KEEP.placed] as number;

/** Hotovo: trefený součet, nebo všechny věci na pultu. */
export const shopDone = (state: Int32Array, game: ShopGame): boolean => (game.target > 0 ? totalOf(state, game) === game.target : placedOf(state, game) >= game.count);

/** Položené věci v pořadí položení (účtenka): tělo a cenovka. */
export function receiptOf(state: Int32Array, game: ShopGame): { readonly body: number; readonly value: number }[] {
  const lines: { body: number; value: number; order: number }[] = [];
  for (let item = game.first; item < game.first + game.count; item += 1) {
    if (targetStateOf(state, item) === SHOP_STATE.placed) lines.push({ body: item, value: bodyHp(state, item), order: state[bodyBase(item) + BODY.aux0] as number });
  }
  return lines.sort((a, b) => a.order - b.order).map(({ body: item, value }) => ({ body: item, value }));
}

// ---------------------------------------------------------------------------
// Krok (ovládání)

/** Další věc z fronty: nejdřív zařazená věc police, nebo −1. */
function nextQueued(state: Int32Array, game: ShopGame): number {
  let best = -1;
  let at = 0;
  for (let item = game.first; item < game.first + game.count; item += 1) {
    const queued = state[bodyBase(item) + BODY.aux1] as number;
    if (queued > 0 && targetStateOf(state, item) === SHOP_STATE.shelf && (best < 0 || queued < at)) {
      best = item;
      at = queued;
    }
  }
  return best;
}

function putHome(state: Int32Array, game: ShopGame, item: number): void {
  const base = bodyBase(item);
  const spot = shelfSpot(item - game.first, game.count);
  state[base + BODY.x] = spot.x;
  state[base + BODY.y] = spot.y;
  state[base + BODY.z] = spot.z;
  state[base + BODY.aux0] = 0;
  state[base + BODY.aux1] = 0;
  setTargetState(state, item, SHOP_STATE.shelf);
}

/** Položení na pult: přijatá věc přičte cenovku, odmítnutá (trefa) se vrátí na polici. */
function place(state: Int32Array, game: ShopGame, item: number): void {
  const keep = bodyBase(game.keeper);
  const tick = state[HEADER.tick] as number;
  state[HEADER.held] = 0;
  const value = bodyHp(state, item);
  const total = state[keep + KEEP.total] as number;
  // Nesená věc má stav „nese“, takže ve zbytku police není.
  if (!fits(game, total, value, shelfValues(state, game))) {
    putHome(state, game, item);
    state[keep + KEEP.refusedAt] = tick;
    state[keep + KEEP.refused] = (state[keep + KEEP.refused] as number) + 1;
    return;
  }
  const placed = state[keep + KEEP.placed] as number;
  const base = bodyBase(item);
  state[base + BODY.x] = counterSpot(placed, game.count);
  state[base + BODY.y] = SHOP_LAYOUT.counterY;
  state[base + BODY.z] = SHOP_LAYOUT.counterZ;
  state[base + BODY.aux0] = placed + 1;
  state[base + BODY.aux1] = 0;
  setTargetState(state, item, SHOP_STATE.placed);
  state[keep + KEEP.total] = total + value;
  state[keep + KEEP.placed] = placed + 1;
  state[keep + KEEP.placedAt] = tick;
}

const at = (state: Int32Array, player: number, spot: { readonly x: number; readonly z: number }): boolean => {
  const base = bodyBase(player);
  return state[base + BODY.x] === spot.x && state[base + BODY.z] === spot.z;
};

/**
 * Jeden tik obchodu: ťuk zařadí věc do fronty (osa = buňka `axisOfCell`, bez osy kurzor; šipky kurzor posunou),
 * hrdina u věci ji zvedne, u pultu ji položí, pak jde pro další věc z fronty nebo s nesenou věcí k pultu.
 */
export function stepShop(state: Int32Array, player: number, input: ArcadeInput, game: ShopGame): void {
  const keep = bodyBase(game.keeper);
  const tick = state[HEADER.tick] as number;
  let cursor = state[keep + KEEP.cursor] as number;
  if ((input.buttons & BUTTON.LEFT) !== 0) cursor -= 1;
  if ((input.buttons & BUTTON.RIGHT) !== 0) cursor += 1;
  if ((input.buttons & BUTTON.UP) !== 0 && cursor + SHOP_LAYOUT.cols < game.count) cursor += SHOP_LAYOUT.cols;
  if ((input.buttons & BUTTON.DOWN) !== 0 && cursor - SHOP_LAYOUT.cols >= 0) cursor -= SHOP_LAYOUT.cols;
  cursor = Math.min(game.count - 1, Math.max(0, cursor));
  if ((input.buttons & BUTTON.TAP) !== 0) {
    const slot = input.axis !== 0 ? cellOfAxis(input.axis) : cursor;
    if (slot >= 0 && slot < game.count) {
      cursor = slot;
      const item = game.first + slot;
      const base = bodyBase(item);
      if (targetStateOf(state, item) === SHOP_STATE.shelf && state[base + BODY.aux1] === 0) state[base + BODY.aux1] = tick + 1;
    }
  }
  state[keep + KEEP.cursor] = cursor;

  let held = (state[HEADER.held] as number) - 1;
  let walking = (state[keep + KEEP.walking] as number) - 1;
  if (held >= 0 && at(state, player, COUNTER_STAND)) {
    place(state, game, held);
    held = -1;
  } else if (held < 0 && walking >= 0 && at(state, player, standAtShelf(walking - game.first, game.count))) {
    setTargetState(state, walking, SHOP_STATE.carried);
    state[bodyBase(walking) + BODY.aux1] = 0;
    state[HEADER.held] = walking + 1;
    held = walking;
    walking = -1;
  }
  if (held < 0 && walking < 0) walking = nextQueued(state, game);
  state[keep + KEEP.walking] = held >= 0 ? 0 : walking + 1;

  const base = bodyBase(player);
  const goal = held >= 0 ? COUNTER_STAND : walking >= 0 ? standAtShelf(walking - game.first, game.count) : null;
  const toward = (delta: number): number => Math.max(-SHOP.speed, Math.min(SHOP.speed, delta));
  state[base + BODY.vx] = goal === null ? 0 : toward(goal.x - (state[base + BODY.x] as number));
  state[base + BODY.vz] = goal === null ? 0 : toward(goal.z - (state[base + BODY.z] as number));
}

// ---------------------------------------------------------------------------
// Generátor

/** Součet `sum` rozdělený na `parts` dílů v 1..`max` (díly po jednom navrch, náhodně). */
function split(rng: ReturnType<typeof createCompileRng>, sum: number, parts: number, max: number): number[] {
  const values = new Array<number>(parts).fill(1);
  for (let left = sum - parts; left > 0; left -= 1) {
    const open = values.flatMap((value, index) => (value < max ? [index] : []));
    const index = rng.pick(open);
    values[index] = (values[index] as number) + 1;
  }
  return values;
}

export interface ShopLevel {
  readonly level: ArcadeLevel;
  readonly game: ShopGame;
  /** Hodiny hry (s). */
  readonly seconds: number;
}

/** Hodiny podle počtu věcí police. */
export const shopClock = (count: number): number => Math.min(SHOP.clock.max, Math.max(SHOP.clock.min, SHOP.clock.base + SHOP.clock.perItem * count));

/** Cenovky police: „polož N“ = N náhodných, trefa = díly cíle a věci navíc, zamíchané. */
export function shopValues(seed: number, params: ShopParams): { readonly values: number[]; readonly target: number } {
  const rng = createCompileRng(seed, 'layout');
  const max = tagMax(params.unit);
  if (params.target === undefined) return { values: Array.from({ length: params.items }, () => rng.int(1, max)), target: 0 };
  const target = params.target * tagScale(params.unit);
  const parts = Math.min(Math.min(SHOP.parts.max, target), Math.max(Math.ceil(target / max), params.items));
  const count = Math.min(SHOP.items.max, parts + SHOP.decoys);
  const values = [...split(rng, target, parts, max), ...Array.from({ length: count - parts }, () => rng.int(1, max))];
  return { values: rng.shuffle(values), target };
}

/** Tvrzení o hotové úrovni: cenovky v mezích jednotky, trefa má řešení, svět se vejde do mezí jádra. */
export function checkShopLevel(level: ArcadeLevel, game: ShopGame): string[] {
  const issues: string[] = [];
  const values = level.bodies.slice(game.first, game.first + game.count).map((item) => item.hp ?? 0);
  if (values.some((value) => value < 1 || value > tagMax(game.unit))) issues.push(`shop: a tag is outside 1..${tagMax(game.unit)}`);
  if (game.target > 0 && !reachable(values, game.target)) issues.push(`shop: no set of shelf items adds up to ${game.target}`);
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Úroveň: hrdina u pultu, věci police s cenovkou v HP, počítadlo za nimi. */
export function generateShop(seed: number, params: ShopParams): ShopLevel {
  const { values, target } = shopValues(seed, params);
  const { item: size, hero } = SHOP_LAYOUT;
  const bodies: BodyInit[] = [{ role: 'player', kind: 'player', x: COUNTER_STAND.x, y: 0, z: COUNTER_STAND.z, ...hero, solid: false }];
  values.forEach((value, slot) => {
    const spot = shelfSpot(slot, values.length);
    bodies.push({ role: 'collectible', kind: 'shop-item', ...spot, w: size, h: size, d: size, solid: false, hp: value });
  });
  const keeper = bodies.length;
  bodies.push({ role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true });
  const game: ShopGame = {
    first: 1,
    count: values.length,
    keeper,
    unit: params.unit,
    target,
    ...(params.spot === undefined || params.spot === 'counter' ? {} : { spot: params.spot }),
    ...(params.name === undefined ? {} : { name: params.name }),
    ...(params.decor === undefined ? {} : { decor: params.decor }),
  };
  return { level: { bodies, length: 0 }, game, seconds: shopClock(values.length) };
}

/** Tiky hodin. */
export const shopTicks = (seconds: number): number => seconds * ARCADE_HZ;
