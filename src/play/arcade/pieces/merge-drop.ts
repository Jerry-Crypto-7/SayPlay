/**
 * Pouštění a slučování (P54C T11, Suika): nad nádobou jezdí dávkovač, osa ho posouvá a `TAP` pustí předmět.
 * Dva stejné předměty, které se dotknou, se sloučí ve větší (6 úrovní). Předměty jsou koule, se kterými hýbe
 * Rapier (`PhysicsSession`, kvantovaný stav); stěny nádoby jsou pevná tělesa jádra, v Rapieru kinematické překážky.
 *
 * **Ovládání `merge`.** Nenulová osa je cíl dávkovače nad nádobou (`targetOf`), dávkovač k němu jede nejvýš
 * `MERGE.speed` j/tik a na něm stojí; bez vstupu stojí. Tělo dávkovače je hráč (kinematické, vysoko nad víkem);
 * jádro ho posouvá jen jeho rychlostí.
 *
 * **Pravidla.**
 * - `merge_drop` (stisk): předmět je připravený, když hodiny `cooldown` doběhnou na nulu; od té chvíle počítají
 *   čekání do záporu. `TAP` pustí další předmět fronty pod dávkovačem. Kdo nepustí do trpělivosti (`patienceOf`,
 *   klesá s časem hry), tomu předmět zkamení a spadne sám jako kámen o úroveň větší, který se neslučuje.
 *   Fronta (`queue`, úrovně 1–3) je předem vylosovaná ze semínka vlastním streamem `merge`; index v ní je čítač `ammo`.
 * - `merge_join` (tik): dvojice stejných předmětů v kontaktu (vzdálenost středů ≤ součet poloměrů + `touch`) se
 *   sloučí – obě zmizí a uprostřed vznikne předmět o úroveň vyšší. **Pořadí je podle id těles** (`mergePairs`): pro
 *   každé tělo vzestupně jeho nejnižší ještě volný stejný soused, ne pořadí, ve kterém kontakty hlásí Rapier.
 *   Sloučení = čítač `items`, body úroveň × `points` × kombo; `need` sloučení vyhraje. Největší předmět (úroveň 6)
 *   se dál neslučuje: v HP odpočítá `popTicks`, praskne a uvolní nádobu (`popPoints`).
 * - `merge_lid` (tik): předmět nebo kámen se středem nad víkem, který nepadá, drží čítač `reserve`; vydrží-li tam
 *   něco déle než `MERGE.overTicks` (1 s), nádoba přeteče: co je nad víkem, se vysype a hráč ztratí život (s milostí).
 *   Poslední život = prohra (`out_of_health`); hodiny `time_limit` = prohra, když cíl nepřišel včas.
 *
 * Pravidla žánru leží tady, ne v `arcade/rules/` – ta složka je jazyk pravidel specu (P29A); nativní pravidla žánru
 * stojí u jeho ovládání a generátoru jako v `crowd.ts` a `hop.ts`.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeCounter,
  type ArcadeEffect,
  type ArcadeLevel,
  AXIS_MAX,
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
} from '../contract';
import { nextMultiplier } from './rules';

export const MERGE = {
  /** Vnitřní polovina šíře nádoby (x) a tloušťka stěn. */
  half: 2200,
  wall: 400,
  /** Výška víka: čára, nad kterou nic nesmí zůstat. */
  lid: 4800,
  /** Stěny přesahují víko, ať se nic nepřelije bokem. */
  wallOver: 1600,
  /** Průměry předmětů úrovní 1–6 (j). */
  sizes: [500, 650, 850, 1100, 1450, 1900],
  /** Spodek nového předmětu nad víkem a dávkovač (hráč) nad ním. */
  dropGap: 300,
  dropperY: 7200,
  dropper: { w: 700, h: 900, d: 700 },
  /** Rychlost dávkovače při plné ose (j/tik): 9 m/s. */
  speed: 150,
  /** Tiky od puštění do dalšího připraveného předmětu (0,75 s). */
  reload: 45,
  /** Trpělivost: tiky, než připravený předmět zkamení; každou sekundu hry o `patienceStep` méně, nejméně `patienceMin`. */
  patience: 120,
  patienceMin: 45,
  patienceStep: 3,
  /** Kámen je o tolik úrovní větší než předmět, ze kterého zkameněl. */
  stoneUp: 1,
  /**
   * Přebití po kameni (tiky): kratší než `reload`, ať nečinnému hráči nádoba přeteče dřív, než doběhnou hodiny. S plným
   * přebitím se po přetečení, které shodí úzkou věž koulí pod dávkovačem, plnila na 2 z 200 semínek až do konce hodin (s 15: nejpozději v tiku 2925 ze 4140).
   */
  stoneReload: 15,
  /** Tolerance dotyku (j): kvantování a měkký kontakt Rapieru. */
  touch: 30,
  /** Odraz předmětů a kamenů (‰). */
  restitution: 50,
  /** Jak dlouho smí něco zůstat nad víkem (tiky): 1 s. */
  overTicks: 60,
  /** Co padá rychleji (j/tik dolů), není „nad víkem“ – čerstvě puštěný předmět jen prolétá. */
  falling: 40,
  lives: 3,
  /** Sloučení, která vyhrají, a hodiny hry (s): robot je stihne za 53–60 s, začátečník jen tak tak. */
  need: 50,
  seconds: 69,
  /** Délka fronty: víc pustů hra za `seconds` neudělá (každý pust čeká aspoň `reload`). */
  queue: 120,
  /** Váhy úrovní 1–3 ve frontě. */
  weights: [450, 350, 200],
  /** Body za sloučení do úrovně L = L × `points` × kombo. */
  points: 10,
  /** Největší předmět po `popTicks` praskne a dá `popPoints`. */
  popTicks: 45,
  popPoints: 200,
  /** Volné sloty pro předměty a kameny. */
  slots: 120,
} as const;

export const MERGE_LEVELS = MERGE.sizes.length;
/** Výchozí předmět, když ho věta nejmenuje: ovoce (scéna ho kreslí jako řadu ovoce z katalogu). */
export const MERGE_ITEM = 'fruit';
/** Úrovně, které přináší fronta (a velikosti kamenů). */
export const QUEUE_LEVELS = MERGE.weights.length;

/** Čítače: index fronty, hodiny pustu, tiky nad víkem; sloučení jsou `items`. */
export const QUEUE_COUNTER = 'ammo' satisfies ArcadeCounter;
export const CLOCK_COUNTER = 'cooldown' satisfies ArcadeCounter;
export const OVER_COUNTER = 'reserve' satisfies ArcadeCounter;

const counter = (state: ArrayLike<number>, name: ArcadeCounter): number => state[HEADER.counters + COUNTER[name]] as number;
export const dropsOf = (state: ArrayLike<number>): number => counter(state, QUEUE_COUNTER);
export const clockOf = (state: ArrayLike<number>): number => counter(state, CLOCK_COUNTER);
export const overOf = (state: ArrayLike<number>): number => counter(state, OVER_COUNTER);
export const mergesOf = (state: ArrayLike<number>): number => counter(state, 'items');

/** Průměr předmětu úrovně 1–6. */
export const sizeOf = (level: number): number => MERGE.sizes[Math.max(1, Math.min(MERGE_LEVELS, level)) - 1] as number;
/** Úroveň předmětu z jeho průměru; 0 = není předmět. */
export const levelOfSize = (w: number): number => MERGE.sizes.indexOf(w as (typeof MERGE.sizes)[number]) + 1;
/** Kámen z předmětu úrovně `level`. */
export const stoneSize = (level: number): number => sizeOf(level + MERGE.stoneUp);

/** Trpělivost v tiku `tick` (tiky). */
export const patienceOf = (tick: number): number => Math.max(MERGE.patienceMin, MERGE.patience - Math.floor(tick / ARCADE_HZ) * MERGE.patienceStep);

/** Kam smí střed tělesa průměru `w`, aby nevzniklo ve stěně. */
export const dropLimit = (w: number): number => MERGE.half - Math.ceil(w / 2) - 1;

/** Úroveň předmětu pustu `drop` (fronta se po konci opakuje). */
export const queued = (queue: readonly number[], drop: number): number => queue[drop % queue.length] as number;

// ---------------------------------------------------------------------------
// Fronta ze semínka

/** Fronta úrovní 1–3 z vlastního streamu `merge` (`src/sim/rng.ts`): žádný jiný los ji nepohne. */
export function mergeQueue(seed: number, length: number = MERGE.queue): number[] {
  const rng = createCompileRng(seed, 'merge');
  const total = MERGE.weights.reduce((sum, weight) => sum + weight, 0);
  return Array.from({ length }, () => {
    let pick = rng.int(1, total);
    for (let level = 1; level < QUEUE_LEVELS; level += 1) {
      pick -= MERGE.weights[level - 1] as number;
      if (pick <= 0) return level;
    }
    return QUEUE_LEVELS;
  });
}

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z
  .object({
    /** Kam až dávkovač dojede (|x|). */
    reach: z.int().min(0),
    speed: z.int().min(1).max(1000),
  })
  .strict();

/**
 * Kam dávkovač jede: nenulová osa je místo nad nádobou (−1000 levý okraj dosahu, +1000 pravý), nula = stát.
 * Prst tak drží cíl, ne rychlost – dávkovač na něm zastaví, i když se prst nehýbe.
 */
export const targetOf = (axis: number, reach: number, x: number): number => (axis === 0 ? x : Math.trunc((Math.max(-AXIS_MAX, Math.min(AXIS_MAX, axis)) * reach) / AXIS_MAX));
/** Osa pro cíl `x`; střed nádoby je osa 1, protože nula znamená „stát“. */
export function axisFor(x: number, reach: number): number {
  const axis = Math.round((Math.max(-reach, Math.min(reach, x)) * AXIS_MAX) / reach);
  return axis === 0 ? 1 : axis;
}
/** Krok dávkovače z `x` k cíli osy: nejvýš `speed`, na cíli stojí. */
export const dropperStep = (x: number, axis: number, reach: number, speed: number): number => Math.max(-speed, Math.min(speed, targetOf(axis, reach, x) - x));

export const mergeControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'merge',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    state[base + BODY.vx] = dropperStep(state[base + BODY.x] as number, input.axis, params.reach, params.speed);
    state[base + BODY.vy] = 0;
    state[base + BODY.vz] = 0;
  },
};

// ---------------------------------------------------------------------------
// Úroveň

/** Indexy těl úrovně: dávkovač 0, stěny 1–4, předlohy předmětů úrovní 1–6, předlohy kamenů. */
export const MERGE_BODIES = { walls: 1, items: 5, stones: 5 + MERGE_LEVELS } as const;
export const itemTemplate = (level: number): number => MERGE_BODIES.items + level - 1;
export const stoneTemplate = (level: number): number => MERGE_BODIES.stones + level - 1;

/** Hloubka nádoby (z): největší předmět a vůle; předměty zůstávají v rovině z = 0, stěny jsou pojistka. */
export const MERGE_DEPTH = (MERGE.sizes[MERGE_LEVELS - 1] as number) + 200;

export function mergeLevel(): ArcadeLevel {
  const { half, wall, lid, wallOver, dropperY, dropper, restitution } = MERGE;
  const height = lid + wallOver;
  const sideX = half + wall / 2;
  const sideZ = MERGE_DEPTH / 2 + wall / 2;
  const item = (level: number): BodyInit => {
    const size = sizeOf(level);
    // Největší předmět nese v HP odpočet do prasknutí (`merge_join`); ostatní HP nemají.
    const pop = level === MERGE_LEVELS ? { hp: MERGE.popTicks } : {};
    return { role: 'collectible', kind: 'item', x: 0, y: 0, z: 0, w: size, h: size, d: size, solid: false, physics: true, ball: true, restitution, template: true, ...pop };
  };
  const stone = (level: number): BodyInit => {
    const size = stoneSize(level);
    return { role: 'obstacle', kind: 'stone', x: 0, y: 0, z: 0, w: size, h: size, d: size, solid: false, physics: true, restitution, template: true };
  };
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: 0, y: dropperY, z: 0, ...dropper, solid: false, kinematic: true },
    { role: 'platform', kind: 'wall', x: -sideX, y: 0, z: 0, w: wall, h: height, d: MERGE_DEPTH + 2 * wall, solid: true },
    { role: 'platform', kind: 'wall', x: sideX, y: 0, z: 0, w: wall, h: height, d: MERGE_DEPTH + 2 * wall, solid: true },
    { role: 'platform', kind: 'glass', x: 0, y: 0, z: -sideZ, w: 2 * sideX + wall, h: height, d: wall, solid: true },
    { role: 'platform', kind: 'glass', x: 0, y: 0, z: sideZ, w: 2 * sideX + wall, h: height, d: wall, solid: true },
    ...Array.from({ length: MERGE_LEVELS }, (_, index) => item(index + 1)),
    ...Array.from({ length: QUEUE_LEVELS }, (_, index) => stone(index + 1)),
  ];
  // Hodiny začínají přebíjením: první předmět je připravený po `reload` tikách.
  return { bodies, length: 0, spawnSlots: MERGE.slots, counters: { [CLOCK_COUNTER]: MERGE.reload } };
}

/** Díly světa z fronty (i ruční v testech). */
export function mergeWorldOf(queue: readonly number[], lives: number, need: number = MERGE.need): Omit<ModeParts, 'issues'> {
  return {
    control: { id: 'merge', params: { reach: dropLimit(sizeOf(1)), speed: MERGE.speed } },
    bot: { id: 'merge_bot', params: { queue: [...queue] } },
    level: mergeLevel(),
    rules: [
      { id: 'merge_drop', params: { queue: [...queue] } },
      { id: 'merge_join', params: { need, points: MERGE.points } },
      { id: 'merge_lid', params: {} },
      { id: 'out_of_health', params: {} },
      { id: 'time_limit', params: { seconds: MERGE.seconds } },
      // Pilulka postupu HUD (`collectNeed`) čte cíl z `finish_collected`: sloučení. Tělo cíle svět nemá, nevystřelí.
      { id: 'finish_collected', params: { need } },
    ],
    health: lives,
  };
}

/**
 * Tvrzení „hratelné z konstrukce“: fronta stačí na celou hru a nese jen úrovně 1–3 (každou aspoň jednou), dávkovač
 * dojede nad každé místo nádoby, robot stihne každý pust dřív, než předmět zkamení, a sloty unesou plnou nádobu.
 */
export function checkMerge(queue: readonly number[]): string[] {
  const issues: string[] = [];
  const drops = Math.ceil((MERGE.seconds * ARCADE_HZ) / MERGE.reload);
  if (queue.length < drops) issues.push(`the queue has ${queue.length} items, a ${MERGE.seconds} s game drops up to ${drops}`);
  if (queue.some((level) => !Number.isInteger(level) || level < 1 || level > QUEUE_LEVELS)) issues.push(`the queue holds a level outside 1–${QUEUE_LEVELS}`);
  for (let level = 1; level <= QUEUE_LEVELS; level += 1) if (!queue.includes(level)) issues.push(`the queue never brings level ${level}`);
  // Robot vidí připravený předmět po reakci (8 tiků) a přejede celou nádobu; trpělivost na to musí stačit.
  const crossing = Math.ceil((2 * dropLimit(sizeOf(1))) / MERGE.speed);
  if (MERGE.patienceMin < 8 + crossing) issues.push(`a patience of ${MERGE.patienceMin} ticks is under the bot's ${8 + crossing}`);
  // Nejhustší vrstva nejmenších koulí (hustota 0,907) pod víkem se musí vejít do slotů, jinak by pust tiše zmizel.
  const densest = Math.ceil(((2 * MERGE.half * MERGE.lid) / (Math.PI * (sizeOf(1) / 2) ** 2)) * 0.907);
  if (MERGE.slots < densest) issues.push(`${MERGE.slots} slots cannot hold the ${densest} smallest items that fit under the lid`);
  return issues;
}

const generatorParams = z.object({}).strict();
export type MergeParams = z.infer<typeof generatorParams>;

export function mergeParts(seed: number, _params: MergeParams, health: number | undefined): ModeParts {
  const queue = mergeQueue(seed);
  return { ...mergeWorldOf(queue, health ?? MERGE.lives), issues: checkMerge(queue) };
}

export const mergeBox: ModeGeneratorPiece<MergeParams> = {
  id: 'merge_box',
  params: generatorParams,
  roles: ['player', 'collectible', 'obstacle', 'platform'],
  cost: () => ({ bodies: 5 + MERGE_LEVELS + QUEUE_LEVELS, rules: 6 }),
  generate: () => mergeLevel(),
  parts: mergeParts,
};

// ---------------------------------------------------------------------------
// Pravidla

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
export const queueSchema = z.array(z.int().min(1).max(QUEUE_LEVELS)).min(1).max(400);

const dropParams = z.object({ queue: queueSchema }).strict();

/** Efekt `spawn` tělesa průměru `w` pod dávkovačem v `x`, spodkem `dropGap` nad víkem a uvnitř nádoby. */
const dropAt = (template: number, w: number, x: number): ArcadeEffect => {
  const limit = dropLimit(w);
  return { kind: 'spawn', template, x: Math.max(-limit, Math.min(limit, x)), y: MERGE.lid + MERGE.dropGap, z: 0, vx: 0, vy: 0, vz: 0 };
};

/**
 * Pust (stisk): s připraveným předmětem `TAP` pustí další předmět fronty pod dávkovačem (poloha před pohybem tiku);
 * připravený předmět, který hráč nepustí do trpělivosti, zkamení a spadne sám. Hodiny: kladné = přebíjení,
 * ≤ 0 = připraveno (−tiky čekání).
 */
export const mergeDropRule: RulePiece<z.infer<typeof dropParams>> = {
  id: 'merge_drop',
  params: dropParams,
  roles: ['player', 'collectible', 'obstacle'],
  trigger: 'press',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, input }, params) => {
    const clock = clockOf(state);
    if (clock > 0) return [{ kind: 'count', counter: CLOCK_COUNTER, amount: -1 }];
    const level = queued(params.queue, dropsOf(state));
    const x = state[bodyBase(player) + BODY.x] as number;
    const reload = (ticks: number): ArcadeEffect[] => [{ kind: 'count', counter: QUEUE_COUNTER, amount: 1 }, { kind: 'count', counter: CLOCK_COUNTER, amount: ticks - clock }];
    if ((input.buttons & BUTTON.TAP) !== 0) return [dropAt(itemTemplate(level), sizeOf(level), x), ...reload(MERGE.reload)];
    if (-clock >= patienceOf(state[HEADER.tick] as number)) return [dropAt(stoneTemplate(level), stoneSize(level), x), ...reload(MERGE.stoneReload)];
    return [{ kind: 'count', counter: CLOCK_COUNTER, amount: -1 }];
  },
};

/** Úroveň živého předmětu (koule role sbírané věci); 0 = není předmět (kámen, stěna, předloha). */
export function itemLevel(state: ArrayLike<number>, body: number): number {
  const base = bodyBase(body);
  if (((state[base + BODY.flags] as number) & (FLAG.alive | FLAG.physics | FLAG.ball)) !== (FLAG.alive | FLAG.physics | FLAG.ball)) return 0;
  if (state[base + BODY.role] !== ROLE.collectible) return 0;
  return levelOfSize(state[base + BODY.w] as number);
}

/** Střed tělesa (y je spodek AABB). */
export const centerY = (state: ArrayLike<number>, body: number): number => (state[bodyBase(body) + BODY.y] as number) + (state[bodyBase(body) + BODY.h] as number) / 2;

/** Dotýkají se dva předměty? Vzdálenost středů nejvýš součet poloměrů a tolerance `touch`. */
export function touching(state: ArrayLike<number>, a: number, b: number): boolean {
  const pa = bodyBase(a);
  const pb = bodyBase(b);
  const dx = (state[pa + BODY.x] as number) - (state[pb + BODY.x] as number);
  const dy = centerY(state, a) - centerY(state, b);
  const dz = (state[pa + BODY.z] as number) - (state[pb + BODY.z] as number);
  const reach = ((state[pa + BODY.w] as number) + (state[pb + BODY.w] as number)) / 2 + MERGE.touch;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}

/**
 * Dvojice ke sloučení v pořadí id těles: pro každé tělo vzestupně jeho nejnižší ještě volný stejný soused v kontaktu.
 * Každé tělo je nejvýš v jedné dvojici; největší úroveň se neslučuje.
 */
export function mergePairs(state: ArrayLike<number>): [number, number][] {
  const count = state[HEADER.bodyCount] as number;
  const levels: number[] = [];
  for (let body = 0; body < count; body += 1) levels.push(itemLevel(state, body));
  const used = new Set<number>();
  const pairs: [number, number][] = [];
  for (let a = 0; a < count; a += 1) {
    const level = levels[a] as number;
    if (level === 0 || level >= MERGE_LEVELS || used.has(a)) continue;
    for (let b = a + 1; b < count; b += 1) {
      if (levels[b] !== level || used.has(b) || !touching(state, a, b)) continue;
      used.add(a);
      used.add(b);
      pairs.push([a, b]);
      break;
    }
  }
  return pairs;
}

/** Kde vznikne sloučený předmět úrovně `level` z dvojice `a`, `b`: uprostřed, nad dnem a uvnitř nádoby. */
export function mergedAt(state: ArrayLike<number>, a: number, b: number, level: number): { readonly x: number; readonly y: number; readonly z: number } {
  const size = sizeOf(level);
  const limit = dropLimit(size);
  const x = Math.round(((state[bodyBase(a) + BODY.x] as number) + (state[bodyBase(b) + BODY.x] as number)) / 2);
  const cy = Math.round((centerY(state, a) + centerY(state, b)) / 2);
  return { x: Math.max(-limit, Math.min(limit, x)), y: Math.max(0, cy - size / 2), z: 0 };
}

const joinParams = z
  .object({
    /** Kolik sloučení vyhraje. */
    need: z.int().min(1).max(ARCADE_LIMITS.maxBodies),
    points: z.int().min(1).max(100),
    /** Počítadlo komba (P46C T3, `withCombo`); bez něj body bez násobiče. */
    combo: index.optional(),
  })
  .strict();

/**
 * Sloučení (tik): každá dvojice zmizí a uprostřed vznikne předmět o úroveň vyšší; `need`-té sloučení vyhraje.
 * Sloučení téhož tiku jdou v kombu za sebou. Největší předmět odpočítává v HP a pak praskne.
 */
export const mergeJoinRule: RulePiece<z.infer<typeof joinParams>> = {
  id: 'merge_join',
  params: joinParams,
  roles: ['collectible'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    const effects: ArcadeEffect[] = [];
    let multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo);
    let merges = mergesOf(state);
    for (const [a, b] of mergePairs(state)) {
      const level = itemLevel(state, a) + 1;
      effects.push(
        { kind: 'despawn', body: a },
        { kind: 'despawn', body: b },
        { kind: 'spawn', template: itemTemplate(level), ...mergedAt(state, a, b, level), vx: 0, vy: 0, vz: 0 },
        { kind: 'count', counter: 'items', amount: 1 },
        { kind: 'score', amount: level * params.points * multiplier },
      );
      if (params.combo !== undefined) {
        effects.push({ kind: 'combo', body: params.combo, multiplier });
        multiplier = Math.min(COMBO.max, multiplier + 1);
      }
      merges += 1;
      if (merges >= params.need) effects.push({ kind: 'win' });
    }
    for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
      if (itemLevel(state, body) !== MERGE_LEVELS) continue;
      if (bodyHp(state, body) > 1) effects.push({ kind: 'hit', body, by: body, amount: 1 });
      else effects.push({ kind: 'despawn', body }, { kind: 'score', amount: MERGE.popPoints });
    }
    return effects;
  },
};

/** Předmět nebo kámen nad víkem, který nepadá: střed nad víkem a rychlost dolů menší než `MERGE.falling`. */
export function overLid(state: ArrayLike<number>, body: number): boolean {
  const base = bodyBase(body);
  if (((state[base + BODY.flags] as number) & (FLAG.alive | FLAG.physics)) !== (FLAG.alive | FLAG.physics)) return false;
  return centerY(state, body) > MERGE.lid && (state[base + BODY.vy] as number) > -MERGE.falling;
}

const lidParams = z.object({}).strict();

/**
 * Víko (tik): je-li něco nad víkem, čítač `reserve` + 1, jinak na nulu. Vydrží-li to déle než `MERGE.overTicks`,
 * nádoba přeteče: co je nad víkem, se vysype (zmizí), hráč ztratí život s vteřinou milosti a čítač začne znovu.
 */
export const mergeLidRule: RulePiece<z.infer<typeof lidParams>> = {
  id: 'merge_lid',
  params: lidParams,
  roles: ['collectible', 'obstacle'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }) => {
    const over: number[] = [];
    for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (overLid(state, body)) over.push(body);
    const ticks = overOf(state);
    if (over.length === 0) return ticks === 0 ? [] : [{ kind: 'count', counter: OVER_COUNTER, amount: -ticks }];
    if (ticks < MERGE.overTicks) return [{ kind: 'count', counter: OVER_COUNTER, amount: 1 }];
    return [...over.map((body): ArcadeEffect => ({ kind: 'despawn', body })), { kind: 'count', counter: OVER_COUNTER, amount: -ticks }, { kind: 'damage', amount: 1, grace: HIT_GRACE }];
  },
};

export const MERGE_RULES = { merge_drop: mergeDropRule, merge_join: mergeJoinRule, merge_lid: mergeLidRule } as const;
