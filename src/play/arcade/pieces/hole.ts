/**
 * Díra (P66 T6): hráč táhne díru joystickem po místě z věty, věci menší než díra do ní spadnou a díra roste po
 * stupních. Ovládání `hole`, generátor `hole_swallow`, pravidla `hole_eat` a `hole_round`, robot `hole_bot`.
 *
 * **Velikost je práh.** Díra má stupeň 0–4 (`HOLE.tiers`, průměr), věc třídu 0–4 (`HOLE.sizes`, hrana krychle, do
 * které scéna model vepíše – nejdelší strana modelu). Věc spadne, jen když je menší než díra (`size < průměr`)
 * a její střed leží v díře o půl svého poloměru (`swallows`). Stupeň `t` tak polkne právě třídy 0..t. Větší věc
 * díru zastaví: ovládání jí ubere rychlost směrem do věci a díra po ní sklouzne (`slide`), nikdy nezemře.
 *
 * **Růst z hmoty.** Polknutá věc dá hmotu = body třídy × vzácnost (`RARITY_SCORE`, háčky `rarity.ts`) do čítače
 * `ammo` a skóre = body třídy × kombo (`hole_eat` je zdroj komba; vzácnost skóre přinásobí háčky). Stupně 1–3
 * přijdou při podílu `HOLE.growth` ze součtu cílů všech kol (`rounds × need`); stupeň 4 jen v posledním kole, když
 * hráč v něm nasbíral celý cíl kola. Největší věc (finále, třída 4) jde proto spolknout jen v posledním kole a
 * v nejvyšším stupni – a tím hra končí výhrou. Kombo hmotu nemění: série ×5 by cíl kola přeskočila za pár vteřin.
 *
 * **Kola** (háčky `withHooks`, `clear: 'win'`): kolo končí výhrou `hole_round`, když hráč v kole nasbíral `need`
 * hmoty; před posledním kolem z ní háčky udělají vyčištěné kolo, přestávku a další kolo. Každé kolo má vlastní
 * hodiny `seconds` v ticích od svého začátku; doběhnou pod cílem = prohra. Kolo si nastaví ovládání v prvním tiku
 * kola (dřív než pravidla): tik začátku do `aux1` hráče, hmotu začátku do čítače `reserve`. Postup kola (oříznutý na
 * cíl) jde do čítače `items`, ať ho HUD ukáže proti `finish_collected.need` (tělo cíle svět nemá, nevystřelí).
 *
 * Stav: hráč (tělo 0) = díra, `w/d` = průměr stupně, `aux0` = připravené kolo + 1, `aux1` = tik začátku kola;
 * čítače `ammo` = hmota, `reserve` = hmota na začátku kola, `items` = postup kola.
 * Tělo 1 = největší věc (finále), od těla 2 věci pole. Náhoda jen při stavbě (`pure-rand`, stream kol háčků přes
 * `roundSeeds` → rozvržení), za běhu žádná. Pád do díry, couvání kamery a hodiny nad dírou jsou jen obraz.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  type ArcadeState,
  BODY,
  type BodyInit,
  COMBO,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  type RulePiece,
  UNIT,
  bodyBase,
} from '../contract';
import { rarityOf, roundOf, roundSeeds, withHooks } from '../hooks';
import { RARITY_SCORE } from '../hooks/contract';
import { DIRECTIONS, directionOfAxis } from './arena';
import { nextMultiplier } from './rules';

export const HOLE = {
  /** Polovina strany čtvercového pole. */
  half: 18 * UNIT,
  /** Průměr díry po stupních 0–4. */
  tiers: [1000, 1800, 3000, 4600, 7500],
  /** Velikost věci po třídách 0–4 (hrana krychle); třída 4 je největší věc finále. Třída `k` < stupeň `k` ≤ třída `k + 1`. */
  sizes: [600, 1300, 2400, 3800, 6500],
  /** Body za spolknutou věc po třídách. */
  points: [1, 3, 8, 20, 60],
  /** Rychlost díry po stupních (j/tik): větší díra jezdí po větším městě. */
  speeds: [70, 78, 86, 94, 102],
  accel: 12,
  brake: 12,
  /** Stupně 1–3 od tolika ‰ součtu cílů všech kol (`rounds × need`). */
  growth: [60, 200, 450],
  /** Větší věc díru zastaví, když by se středy přiblížily pod (díra + věc) / 2 × tohle ‰. */
  block: 800,
  rounds: { min: 1, max: 3, default: 3 },
  /** Hodiny jednoho kola (s). */
  seconds: { min: 60, max: 90, default: 60 },
  /** Věcí na poli (bez finále). */
  items: { min: 30, max: 120, default: 60 },
  /** Cíl všech kol dohromady = věci × tolik bodů; cíl kola = podíl na kolo. */
  needPerItem: 3,
  /** Start díry a místo největší věci (z, ‰ poloviny pole); x = 0. */
  startZ: -600,
  finaleZ: 450,
} as const;

export const HOLE_TIERS = HOLE.tiers.length;
/** Tělo největší věci a první věci pole. */
export const HOLE_BODIES = { finale: 1, first: 2 } as const;
/** Druhů věcí v ladění (`k0`…): tři věci věty a nejvýš tři kulisy sady na třídu. */
export const HOLE_KINDS = 15;

const counter = (state: ArrayLike<number>, name: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[name]] as number;
const alive = (state: ArrayLike<number>, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Tvar hry, ze kterého se počítá stupeň díry: počítadlo háčků (kolo), počet kol a cíl kola. */
export interface HoleShape {
  readonly keeper: number;
  readonly rounds: number;
  readonly need: number;
}

/** Cíl jednoho kola z počtu věcí a kol. */
export const needOf = (items: number, rounds: number): number => Math.max(10, Math.round((items * HOLE.needPerItem) / rounds));

/** Hmota, od které díra dosáhne stupně 1–3 (pořadí jako `HOLE.growth`). */
export const growthAt = (shape: Pick<HoleShape, 'rounds' | 'need'>): readonly number[] => HOLE.growth.map((share) => Math.ceil((share * shape.rounds * shape.need) / 1000));

/**
 * Spolknutá hmota (čítač `ammo`, ovládání díry střelbu nemá): body třídy × vzácnost (`RARITY_SCORE`), bez komba.
 * Z ní roste díra a počítá se cíl kola; skóre (s kombem) je jen pro výsledek a výzvu.
 */
export const MASS_COUNTER = 'ammo' satisfies keyof typeof COUNTER;
/** Hmota na začátku běžícího kola. */
export const BASE_COUNTER = 'reserve' satisfies keyof typeof COUNTER;

export const massOf = (state: ArrayLike<number>): number => counter(state, MASS_COUNTER);

/** Postup běžícího kola: hmota od jeho začátku. */
export const progressOf = (state: ArrayLike<number>): number => massOf(state) - counter(state, BASE_COUNTER);

/** Je běžící kolo poslední? */
export const lastRound = (state: Int32Array, shape: HoleShape): boolean => roundOf(state, shape.keeper) >= shape.rounds - 1;

/**
 * Stupeň díry 0–4 ze stavu: 1–3 z hmoty (`growthAt`), 4 jen v posledním kole s celým cílem kola. Hmota neklesá a kolo
 * jen roste, takže stupeň taky.
 */
export function tierOf(state: Int32Array, shape: HoleShape): number {
  if (lastRound(state, shape) && progressOf(state) >= shape.need) return 4;
  const mass = massOf(state);
  let tier = 0;
  for (const at of growthAt(shape)) if (mass >= at) tier += 1;
  return tier;
}

/** Třída věci podle její velikosti (`HOLE.sizes`), nebo −1. */
export const classOf = (size: number): number => (HOLE.sizes as readonly number[]).indexOf(size);

/** Spadne věc velikosti `size` se středem `dx, dz` od středu díry průměru `hole`? Menší než díra a uvnitř o půl poloměru. */
export function swallows(hole: number, size: number, dx: number, dz: number): boolean {
  if (size >= hole) return false;
  const reach = hole - Math.trunc(size / 2);
  return 4 * (dx * dx + dz * dz) <= reach * reach;
}

/** Vzdálenost středů, pod kterou větší věc velikosti `size` díru průměru `hole` nepustí. */
export const blockDistance = (hole: number, size: number): number => Math.trunc(((hole + size) * HOLE.block) / 2000);

/** Věci pole (bez finále) a finále: index první, počet, index finále. */
export interface HoleBodies {
  readonly first: number;
  readonly count: number;
  readonly finale: number;
}

/** Těla věcí (pole i finále), která tik prochází. */
function thingsOf(params: HoleBodies): number[] {
  return [params.finale, ...Array.from({ length: params.count }, (_, k) => params.first + k)];
}

/**
 * Rychlost díry `vx, vz` z `x, z` po větších věcech: složka do věci, která by díru vpustila pod `blockDistance`,
 * se ubere (díra po věci klouže), a díru, která v ní už stojí (stupeň se nezmenšuje, takže jen po stavbě), věc
 * vytlačí ven. Dva průchody – roh mezi dvěma věcmi. Celá čísla; `Math.sqrt` je v IEEE 754 přesně zaokrouhlená.
 */
export function slide(state: Int32Array, things: readonly number[], hole: number, x: number, z: number, vx: number, vz: number): readonly [number, number] {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const body of things) {
      if (!alive(state, body)) continue;
      const base = bodyBase(body);
      const size = state[base + BODY.w] as number;
      if (size < hole) continue;
      const near = blockDistance(hole, size);
      const ox = x - (state[base + BODY.x] as number);
      const oz = z - (state[base + BODY.z] as number);
      const nx = ox + vx;
      const nz = oz + vz;
      if (nx * nx + nz * nz >= near * near) continue;
      const oo = ox * ox + oz * oz;
      if (oo === 0) {
        vx = 0;
        vz = 0;
        continue;
      }
      const dot = vx * ox + vz * oz;
      if (dot < 0) {
        vx -= Math.trunc((dot * ox) / oo);
        vz -= Math.trunc((dot * oz) / oo);
      }
      if (oo < near * near) {
        const gap = Math.floor(Math.sqrt(oo));
        const push = near - gap;
        vx += Math.trunc((ox * push) / Math.max(1, gap));
        vz += Math.trunc((oz * push) / Math.max(1, gap));
      }
    }
  }
  return [vx, vz];
}

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

// ---------------------------------------------------------------------------
// Ovládání

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const shapeParams = {
  keeper: index,
  rounds: z.int().min(HOLE.rounds.min).max(HOLE.rounds.max),
  need: z.int().min(1).max(9999),
  first: index,
  count: z.int().min(1).max(ARCADE_LIMITS.maxBodies),
  finale: index,
};

const controlParams = z.object({ half: z.int().min(UNIT).max(100 * UNIT), ...shapeParams }).strict();
export type HoleControlParams = z.infer<typeof controlParams>;

/**
 * Začátek kola: v prvním tiku nového kola (háčky zvedly kolo, nebo tik 0) si ovládání zapíše tik začátku (`aux1`),
 * skóre začátku (`reserve`) a vynuluje postup (`items`). Běží dřív než pravidla, takže `hole_round` v tom tiku
 * už vidí nové kolo s nulovým postupem.
 */
export function startRound(state: ArcadeState, player: number, shape: HoleShape): void {
  const base = bodyBase(player);
  const round = roundOf(state, shape.keeper);
  if (state[base + BODY.aux0] === round + 1) return;
  state[base + BODY.aux0] = round + 1;
  state[base + BODY.aux1] = state[HEADER.tick] as number;
  state[HEADER.counters + COUNTER[BASE_COUNTER]] = massOf(state);
  state[HEADER.counters + COUNTER.items] = 0;
}

/** Tik začátku běžícího kola. */
export const roundStartOf = (state: ArrayLike<number>, player: number): number => state[bodyBase(player) + BODY.aux1] as number;

/**
 * Ovládání díry: kolo, stupeň (průměr do `w/d`), osa = směr z 32 (`arenaAxis`, tah i šipky), rozjezd a brzda,
 * větší věci díru zastaví (`slide`), pole ji nepustí ven.
 */
export const holeControl: ControlPiece<HoleControlParams> = {
  id: 'hole',
  params: controlParams,
  roles: ['player', 'collectible'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input, params) => {
    startRound(state, player, params);
    const base = bodyBase(player);
    const tier = tierOf(state, params);
    const size = HOLE.tiers[tier] as number;
    state[base + BODY.w] = size;
    state[base + BODY.d] = size;
    const direction = directionOfAxis(input.axis);
    const dir = direction < 0 ? null : (DIRECTIONS[direction] as { dx: number; dz: number });
    const speed = HOLE.speeds[tier] as number;
    const tx = dir === null ? 0 : Math.trunc((dir.dx * speed) / 1000);
    const tz = dir === null ? 0 : Math.trunc((dir.dz * speed) / 1000);
    const rate = dir === null ? HOLE.brake : HOLE.accel;
    const x = state[base + BODY.x] as number;
    const zz = state[base + BODY.z] as number;
    const limit = params.half - Math.ceil(size / 2);
    const clampX = (v: number): number => Math.max(-limit - x, Math.min(limit - x, v));
    const clampZ = (v: number): number => Math.max(-limit - zz, Math.min(limit - zz, v));
    const [vx, vz] = slide(state, thingsOf(params), size, x, zz, clampX(toward(state[base + BODY.vx] as number, tx, rate)), clampZ(toward(state[base + BODY.vz] as number, tz, rate)));
    state[base + BODY.vx] = clampX(vx);
    state[base + BODY.vz] = clampZ(vz);
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const eatParams = z
  .object({
    first: index,
    count: z.int().min(1).max(ARCADE_LIMITS.maxBodies),
    finale: index,
    /** Počítadlo komba (`withCombo` / `withScoring`, od `genre.v6` zdroj komba sám): rychlá série polknutí násobí body. */
    combo: index.optional(),
  })
  .strict();

/**
 * Polknutí (tik): každá živá věc, kterou díra polkne (`swallows`), dá body své třídy × kombo a zmizí – dvojice
 * `score` + `despawn`, podle které háčky poznají sebrání (vzácnost, létající skóre) – a hmotu: body třídy ×
 * vzácnost věci (`RARITY_SCORE`), bez komba. Polknutí téhož tiku jdou v kombu za sebou. Polknutá největší věc
 * (finále) = výhra.
 */
export const holeEatRule: RulePiece<z.infer<typeof eatParams>> = {
  id: 'hole_eat',
  params: eatParams,
  roles: ['player', 'collectible'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const hole = bodyBase(player);
    const size = state[hole + BODY.w] as number;
    const hx = state[hole + BODY.x] as number;
    const hz = state[hole + BODY.z] as number;
    const effects: ArcadeEffect[] = [];
    let multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo);
    for (const body of thingsOf(params)) {
      if (!alive(state, body)) continue;
      const base = bodyBase(body);
      const thing = state[base + BODY.w] as number;
      if (!swallows(size, thing, (state[base + BODY.x] as number) - hx, (state[base + BODY.z] as number) - hz)) continue;
      const points = HOLE.points[Math.max(0, classOf(thing))] as number;
      const rarity = rarityOf(state, body);
      effects.push({ kind: 'score', amount: points * multiplier }, { kind: 'despawn', body });
      if (params.combo !== undefined) {
        effects.push({ kind: 'combo', body: params.combo, multiplier });
        multiplier = Math.min(COMBO.max, multiplier + 1);
      }
      effects.push({ kind: 'count', counter: MASS_COUNTER, amount: points * (rarity === undefined ? 1 : RARITY_SCORE[rarity]) });
      if (body === params.finale) effects.push({ kind: 'win' });
    }
    return effects;
  },
};

const roundParams = z
  .object({
    keeper: index,
    rounds: z.int().min(HOLE.rounds.min).max(HOLE.rounds.max),
    need: z.int().min(1).max(9999),
    seconds: z.int().min(HOLE.seconds.min).max(HOLE.seconds.max),
  })
  .strict();

/**
 * Kolo (tik): postup kola (skóre od začátku, oříznutý na cíl) do `items` pro HUD; cíl kola před posledním kolem =
 * výhra (háčky z ní udělají vyčištěné kolo); hodiny kola doběhly = prohra. V posledním kole cíl kola dá stupeň 4
 * a vyhrává až polknutá největší věc (`hole_eat`).
 */
export const holeRoundRule: RulePiece<z.infer<typeof roundParams>> = {
  id: 'hole_round',
  params: roundParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const progress = progressOf(state);
    const effects: ArcadeEffect[] = [];
    const shown = Math.max(0, Math.min(progress, params.need));
    const items = counter(state, 'items');
    if (shown !== items) effects.push({ kind: 'count', counter: 'items', amount: shown - items });
    if (!lastRound(state, params) && progress >= params.need) effects.push({ kind: 'win' });
    if ((state[HEADER.tick] as number) - roundStartOf(state, player) >= params.seconds * ARCADE_HZ) effects.push({ kind: 'lose' });
    return effects;
  },
};

export const HOLE_RULES: Readonly<Record<string, RulePiece>> = { hole_eat: holeEatRule as RulePiece, hole_round: holeRoundRule as RulePiece };

// ---------------------------------------------------------------------------
// Úroveň

/** Druh věci v ladění: třída a druh těla (`thing:<role>` = věc věty, jinak id modelu kulisy). */
export interface HoleKind {
  readonly cls: number;
  readonly kind: string;
}

const KIND = /^(?:thing:[A-Za-z][A-Za-z0-9_.]{0,30}|[a-z0-9][a-z0-9-]{0,36})$/;
const kindRef = z.string().max(40).regex(/^[0-3]:/).refine((value) => KIND.test(value.slice(2)), 'a kind: thing:<role> or a model id');

/** `"2:thing:item1"` → třída a druh. */
export const kindOf = (ref: string): HoleKind => ({ cls: Number(ref.slice(0, 1)), kind: ref.slice(2) });
export const kindRefOf = (kind: HoleKind): string => `${String(kind.cls)}:${kind.kind}`;

/** Bez ladění (ruční spec, režisér bez věcí): kulisy rušného města. */
export const DEFAULT_KINDS: readonly HoleKind[] = [
  { cls: 0, kind: 'gen3d-traffic-cone' },
  { cls: 1, kind: 'gen3d-street-mailbox' },
  { cls: 1, kind: 'cc0-car-sedan' },
  { cls: 2, kind: 'cc0-van' },
  { cls: 2, kind: 'gen3d-red-phone-booth' },
  { cls: 3, kind: 'townhouse' },
  { cls: 3, kind: 'gen3d-billboard-sign' },
];
export const DEFAULT_FINALE = 'gen3d-glass-office-tower';

/** Kolik věcí které třídy pole má (třída 3 aspoň dvě). */
export function classCounts(items: number): readonly [number, number, number, number] {
  const big = Math.max(2, Math.round(items * 0.07));
  const large = Math.round(items * 0.17);
  const medium = Math.round(items * 0.3);
  return [items - big - large - medium, medium, large, big];
}

/**
 * Druh pro `slot`-tou věc třídy `cls`: věci věty té třídy dostanou tři z pěti míst, kulisy sady zbytek; třída bez
 * vlastního druhu si vezme druh nejbližší třídy (vepíše se do velikosti své třídy).
 */
export function kindFor(kinds: readonly HoleKind[], cls: number, slot: number): string {
  for (let away = 0; away < 4; away += 1) {
    for (const at of away === 0 ? [cls] : [cls - away, cls + away]) {
      const own = kinds.filter((kind) => kind.cls === at);
      if (own.length === 0) continue;
      const said = own.filter((kind) => kind.kind.startsWith('thing:'));
      const kit = own.filter((kind) => !kind.kind.startsWith('thing:'));
      if (said.length > 0 && (kit.length === 0 || slot % 5 < 3)) return (said[slot % said.length] as HoleKind).kind;
      return (kit[slot % kit.length] as HoleKind).kind;
    }
  }
  return DEFAULT_KINDS[0]!.kind;
}

/** Odstup středů dvou věcí velikosti `a`, `b`: dvě velké věci nechají mezi sebou průjezd díry té menší třídy. */
const gapOf = (a: number, b: number): number => Math.trunc((a + b) / 2) + Math.max(400, Math.min(a, b));

/**
 * Výloha u startu (j od startu díry, x do stran, z dopředu): první věc věty třídy 1 a 2 stojí v záběru prvního snímku
 * kousek před dírou, mimo její přímou cestu – hráč hned vidí auta či lidi z věty, na které zatím nestačí.
 */
export const SHOWCASE: readonly (readonly [number, number])[] = [
  [-1300, 2400],
  [1500, 2900],
];

const thing = (kind: string, cls: number, x: number, z: number): BodyInit => {
  const size = HOLE.sizes[cls] as number;
  return { role: 'collectible', kind, x, y: 0, z, w: size, h: size, d: size, solid: false };
};

/** Místa věcí: ze semínka, od největších; třída 0 hustěji kolem startu, větší věci dál od něj a od finále. */
export function holeLayout(seed: number, items: number, kinds: readonly HoleKind[], finale: string): BodyInit[] {
  const rng = createCompileRng(roundSeeds(seed, 1)[0] as number, 'layout');
  const start = { x: 0, z: Math.trunc((HOLE.startZ * HOLE.half) / 1000) };
  const big = { x: 0, z: Math.trunc((HOLE.finaleZ * HOLE.half) / 1000), size: HOLE.sizes[4] as number };
  const placed: { x: number; z: number; size: number }[] = [big];
  const things: BodyInit[] = [];
  const counts = classCounts(items);
  // Výloha: věci věty třídy 1 a 2 (nejvýš dvě, každá jednou) na pevných místech u startu.
  const shown = [0, 0, 0, 0];
  const said = kinds.filter((kind) => kind.kind.startsWith('thing:') && (kind.cls === 1 || kind.cls === 2)).slice(0, SHOWCASE.length);
  said.forEach((kind, k) => {
    const [dx, dz] = SHOWCASE[k] as readonly [number, number];
    placed.push({ x: start.x + dx, z: start.z + dz, size: HOLE.sizes[kind.cls] as number });
    things.push(thing(kind.kind, kind.cls, start.x + dx, start.z + dz));
    shown[kind.cls] = (shown[kind.cls] as number) + 1;
  });
  for (let cls = 3; cls >= 0; cls -= 1) {
    const size = HOLE.sizes[cls] as number;
    const edge = HOLE.half - 1200 - Math.trunc(size / 2);
    const clear = cls === 0 ? 1200 : 3000 + Math.trunc(size / 2);
    for (let slot = shown[cls] as number; slot < (counts[cls] as number); slot += 1) {
      // Třetina drobných věcí ve věnci kolem startu: díra má co jíst hned od prvního tahu.
      const ring = cls === 0 && slot % 3 === 0;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const x = ring ? start.x + rng.int(-7000, 7000) : rng.int(-edge, edge);
        const z = ring ? start.z + rng.int(-4000, 7000) : rng.int(-edge, edge);
        if (Math.abs(x) > edge || Math.abs(z) > edge) continue;
        if ((x - start.x) ** 2 + (z - start.z) ** 2 < clear * clear) continue;
        if (placed.some((other) => (x - other.x) ** 2 + (z - other.z) ** 2 < gapOf(size, other.size) ** 2)) continue;
        placed.push({ x, z, size });
        things.push(thing(kindFor(kinds, cls, slot), cls, x, z));
        break;
      }
    }
  }
  return [thing(finale, 4, big.x, big.z), ...things];
}

const generatorParams = z
  .object({
    items: z.int().min(HOLE.items.min).max(HOLE.items.max).optional(),
    rounds: z.int().min(HOLE.rounds.min).max(HOLE.rounds.max).optional(),
    seconds: z.int().min(HOLE.seconds.min).max(HOLE.seconds.max).optional(),
    finale: z.string().max(40).regex(KIND).optional(),
    ...(Object.fromEntries(Array.from({ length: HOLE_KINDS }, (_, k) => [`k${String(k)}`, kindRef.optional()])) as Record<`k${number}`, z.ZodOptional<typeof kindRef>>),
  })
  .strict();
export type HoleParams = z.infer<typeof generatorParams>;

/** Druhy věcí z ladění v pořadí `k0`…; bez nich `DEFAULT_KINDS`. */
export function kindsOfParams(params: HoleParams): readonly HoleKind[] {
  const listed = Array.from({ length: HOLE_KINDS }, (_, k) => (params as Record<string, string | undefined>)[`k${String(k)}`]).filter((ref): ref is string => ref !== undefined);
  return listed.length === 0 ? DEFAULT_KINDS : listed.map(kindOf);
}

/** Tvrzení „hratelné z konstrukce“: pole uneslo aspoň tři čtvrtiny věcí a jejich body s rezervou pokryjí cíle kol. */
export function checkHole(level: ArcadeLevel, items: number, rounds: number, need: number): string[] {
  const issues: string[] = [];
  const things = level.bodies.slice(HOLE_BODIES.first).filter((body) => body.role === 'collectible');
  if (things.length * 4 < items * 3) issues.push(`hole: only ${String(things.length)} of ${String(items)} things fit on the field`);
  const points = things.reduce((sum, body) => sum + (HOLE.points[Math.max(0, classOf(body.w))] as number), 0);
  if (points < rounds * need) issues.push(`hole: the things are worth ${String(points)} points, the rounds want ${String(rounds * need)}`);
  return issues;
}

/** Díly světa díry (i ruční v testech): pole z `parts` a háčky s koly a vzácností. */
export function holeParts(seed: number, params: HoleParams): ModeParts {
  const items = params.items ?? HOLE.items.default;
  const rounds = params.rounds ?? HOLE.rounds.default;
  const seconds = params.seconds ?? HOLE.seconds.default;
  const need = needOf(items, rounds);
  const field = holeLayout(seed, items, kindsOfParams(params), params.finale ?? DEFAULT_FINALE);
  const start = Math.trunc((HOLE.startZ * HOLE.half) / 1000);
  const hero: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: start, w: HOLE.tiers[0] as number, h: 200, d: HOLE.tiers[0] as number, solid: false };
  const level: ArcadeLevel = { bodies: [hero, ...field], length: 0 };
  const keeper = level.bodies.length;
  const bodies = { first: HOLE_BODIES.first, count: field.length - 1, finale: HOLE_BODIES.finale };
  const shape = { keeper, rounds, need };
  const rules: PieceRef[] = [
    { id: 'hole_eat', params: { ...bodies } },
    { id: 'hole_round', params: { ...shape, seconds } },
    // Pilulka postupu HUD (`collectNeed`) čte cíl kola z `finish_collected`; tělo cíle svět nemá, nevystřelí.
    { id: 'finish_collected', params: { need } },
  ];
  const hooked = withHooks({ level, rules, bot: { id: 'hole_bot', params: { half: HOLE.half, ...shape, ...bodies } } }, seed, { rounds, clear: 'win', rarity: true });
  return {
    control: { id: 'hole', params: { half: HOLE.half, ...shape, ...bodies } },
    bot: hooked.bot,
    level: hooked.level,
    rules: hooked.rules,
    issues: [...(hooked.keeper === keeper ? [] : ['hole: the hooks counter moved']), ...checkHole(level, items, rounds, need)],
  };
}

export const holeSwallow: ModeGeneratorPiece<HoleParams> = {
  id: 'hole_swallow',
  params: generatorParams,
  roles: ['player', 'collectible'],
  cost: (params) => ({ bodies: 3 + (params.items ?? HOLE.items.default), rules: 4 }),
  generate: (seed, params) => holeParts(seed, params).level,
  parts: (seed, params) => holeParts(seed, params),
};
