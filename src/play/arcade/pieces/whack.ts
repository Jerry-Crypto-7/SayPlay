/**
 * Bouchání (P54C T6): z pěti děr v řadě (pruhy `lanes.ts`) vykukují cíle a hrdina do nich bouchá.
 *
 * Každý cíl je kinematické tělo, které stálou rychlostí `vy` stoupá „pod zemí“ a jeho výška je
 * hodiny: díra je otevřená, dokud `0 ≤ y < WHACK.band`, tedy přesně `windowOf(vy)` tiků od tiku
 * vykouknutí (`up`), spočitatelného ze semínka. Ťuk do díry (`tappedIn`) v okně = zásah: krtek dá
 * body × kombo a čítač `items`, hodný cíl (zajíček) vezme život. Ťuk do prázdné díry shodí kombo.
 * Cíl, do kterého nikdo nebouchl, se po okně schová; prvních `free` schovaných krtků je bez trestu,
 * každý další stojí život. Výhra = rozbít `targets` krtků (`catch_goal`), prohra = životy došly.
 *
 * Hra jde po třetinách cíle: okno se zkracuje (46–60, 32–42 a 19–28 tiků), krtci chodí hustěji
 * a hodných cílů přibývá. Hodný cíl vykoukne vždy v témž tiku jako krtek, v jiné díře – kdo mačká
 * všechno, přijde o životy; nejvýš čtyři krtci za sebou jsou bez hodného souseda.
 *
 * **Hratelné z konstrukce** (`checkWhackLevel`): v díře je naráz nejvýš jeden cíl a robot světa
 * (`whack-bot.ts`, reakce `WHACK_BOT_REACTION`) stihne každého krtka, i když bouchá po jednom za tik.
 * Krtků je `targets + free + životy − 1`: kdo je všechny nerozbije, prohraje nejpozději posledním.
 * Nečinný hráč nebouchne nikdy, takže nic nerozbije a prohraje po `free + životy` schovaných krtcích.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  type BodyInit,
  FLAG,
  HEADER,
  type ModeGeneratorPiece,
  type ModeParts,
  ROLE,
  type RulePiece,
  START_LIVES,
  bodyBase,
  bodyHp,
  targetStateOf,
} from '../contract';
import { EVENT_MARK, LANE_EVENTS, laneEventCursor, laneEventRng, planLaneEvents } from './lane-events';
import { LANES, LANE_START, laneOfX, laneX, tappedIn } from './lanes';
import { nextMultiplier } from './rules';

export const WHACK = {
  /** Řada děr leží tolik před hrdinou (z); hrdiny se cíle nikdy nedotknou. */
  holeZ: 2400,
  hero: { w: 1200, h: 1600, d: 1000 },
  target: { w: 1000, h: 1000, d: 1000 },
  /** Výška, kterou cíl za okno vystoupá: díra je otevřená, dokud `0 ≤ y < band`. */
  band: 7200,
  /** Okno (tiky, ve kterých jde cíl zasáhnout) po třetinách cíle, los v mezích. */
  windows: [
    [46, 60],
    [32, 42],
    [19, 28],
  ],
  /** Rozestup vykouknutí po sobě jdoucích krtků po třetinách (tiky), před natažením pro malý cíl. */
  gaps: [
    [80, 110],
    [56, 76],
    [40, 54],
  ],
  /** Kolik krtků (‰) má v témž tiku hodného souseda v jiné díře, po třetinách. */
  decoys: [250, 400, 550],
  /** Nejvíc krtků za sebou bez hodného souseda; další ho dostane vždy. */
  plainRun: 4,
  /** První krtek vykoukne ve vteřině hry. */
  firstUp: 60,
  /** Tiky, kdy díra po schovaném cíli zůstane prázdná (scéna cíl zasouvá). */
  rest: 12,
  /** Schovaní krtci bez trestu; každý další stojí život. */
  free: 2,
  points: 10,
  targets: { min: 10, max: 50, default: 30 },
  /** Cíl, pod kterým se rozestupy natahují, ať hra trvá aspoň půl minuty. */
  pacedTargets: 30,
  /** Rezerva robota světa před koncem okna (tiky). */
  margin: 2,
} as const;

/** Reakce robota světa – generátor s ní počítá, ať robot stihne každého krtka. */
export const WHACK_BOT_REACTION = 8;

/** Stav krtka, který se schoval celý (bity stavu cíle ve `flags`, `setTargetState`). */
export const ESCAPED = 1;

const SALT = 0x3a7c;

/** Kolik tiků je díra otevřená pro cíl, který stoupá rychlostí `vy`. */
export const windowOf = (vy: number): number => Math.ceil(WHACK.band / vy);

/** Rychlost, se kterou je cíl v díře právě `window` tiků. */
const riseFor = (window: number): number => Math.ceil(WHACK.band / window);

/** Výška v tiku 0, aby cíl vykoukl (y = 0) v kroku `up`. */
export const startY = (up: number, vy: number): number => -vy * (up + 1);

/** Tik vykouknutí cíle z výšky `y` ve stavu z tiku `tick` (stav po kroku `tick − 1`). */
export const upOf = (y: number, vy: number, tick: number): number => tick - 1 - Math.floor(y / vy);

/** Je cíl ve stavu otevřený (vykoukl a ještě se neschoval)? */
export function holeOpen(state: Int32Array, body: number): boolean {
  const base = bodyBase(body);
  if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) return false;
  const y = state[base + BODY.y] as number;
  return (state[base + BODY.vy] as number) > 0 && y >= 0 && y < WHACK.band;
}

/** Cíl v tiku 0, k dispozici pro rozbor (`checkWhackLevel`, testy). */
export interface Pop {
  readonly up: number;
  readonly hole: number;
  readonly window: number;
  readonly good: boolean;
  /** Bonus události (P55 T5, `EVENT_MARK`): body a kombo, do cíle se nepočítá a schovat se smí; 0 = běžný cíl. */
  readonly mark: number;
}

/** Kouká cíl z díry (hráč ho vidí)? Ohlášení události odsud počítá bonus jako ukázaný. */
export const whackInView = (state: Int32Array, body: number): boolean => holeOpen(state, body);

export const whackParams = z
  .object({
    /** Kolik krtků rozbít (`COUNT_PARAMS.whack.default.enemy`). */
    targets: z.int().min(WHACK.targets.min).max(WHACK.targets.max).default(WHACK.targets.default),
  })
  .strict();
export type WhackParams = z.infer<typeof whackParams>;

/** Natažení rozestupů (‰): cíl pod `pacedTargets` dostane delší mezery, ať hra nekončí za pár vteřin. */
const stretchOf = (targets: number): number => Math.max(1000, Math.round((WHACK.pacedTargets * 1000) / targets));

/** Třetina cíle, do které patří krtek `index` (krtci za cílem jsou ve třetí). */
const thirdOf = (index: number, targets: number): number => Math.min(2, Math.floor((3 * index) / targets));

/** Rozestup bonusů série a spěchu (tiky): vykukují rychle po sobě, takže jich kouká víc naráz. */
const BONUS_GAP = [8, 14] as const;
/** Okno bonusu série a spěchu (tiky): delší než okno krtka střední a poslední třetiny – kouká déle. */
const BONUS_WINDOW = [46, 60] as const;
/** Okno zlatého cíle (tiky): krátké, ale robot s reakcí ho stihne (`checkWhackLevel`). */
const GOLDEN_WINDOW = [18, 22] as const;
/** Nejkratší okno, které bonus v díře dostane, když se díra brzy otevře dalšímu cíli. */
const BONUS_MIN_WINDOW = 18;

/**
 * Rozpis ze semínka: krtci a hodní sousedé (`whackPlainPops`) a v dírách, které jsou zrovna volné, bonusy
 * událostí (P55 T5, `planLaneEvents`). Bonusy mají vlastní stream (`laneEventRng`) a berou jen díru, která
 * je volná po celé jejich okno i odpočinek – krtci a hodné cíle vykouknou přesně tam a tehdy jako bez událostí.
 */
export function whackPops(seed: number, params: WhackParams, lives: number): Pop[] {
  const plain = whackPlainPops(seed, params, lives);
  const end = Math.max(...plain.map((pop) => pop.up + pop.window));
  const cursor = laneEventCursor(planLaneEvents(seed, end));
  const rng = laneEventRng(seed);
  const pops = [...plain];
  /** Bonus vykoukne v `up` do volné díry; okno se zkrátí, když díru brzy potřebuje jiný cíl, a nevejde-li se ani nejkratší, bonus nebude. */
  const put = (mark: number, up: number, [shortest, longest]: readonly [number, number]): void => {
    const wanted = rng.int(shortest, longest);
    const room = (hole: number): number => {
      let free = wanted;
      for (const pop of pops) {
        if (pop.hole !== hole) continue;
        if (pop.up <= up && up < pop.up + pop.window + WHACK.rest) return 0;
        if (pop.up > up) free = Math.min(free, pop.up - WHACK.rest - up);
      }
      return free;
    };
    const holes = Array.from({ length: LANES.count }, (_, hole) => hole).filter((hole) => room(hole) >= Math.min(BONUS_MIN_WINDOW, shortest));
    if (holes.length === 0) return;
    const hole = rng.pick(holes);
    pops.push({ up, hole, window: room(hole), good: false, mark });
  };
  // Události se kotví k vykouknutí krtka: série a zlatý cíl začnou v mezeře po něm, spěch dá do každé mezery dva bonusy.
  const moles = plain.filter((pop) => !pop.good);
  for (const mole of moles) {
    const event = cursor.take(mole.up);
    let at = mole.up;
    if (event?.kind === 'series') {
      for (let n = rng.int(...LANE_EVENTS.series); n > 0; n -= 1) put(EVENT_MARK.series, (at += rng.int(...BONUS_GAP)), BONUS_WINDOW);
    } else if (event?.kind === 'golden') put(EVENT_MARK.golden, at + rng.int(...BONUS_GAP), GOLDEN_WINDOW);
    else if (cursor.inRush(mole.up)) {
      for (let n = 2; n > 0; n -= 1) put(EVENT_MARK.rush, (at += rng.int(...BONUS_GAP)), BONUS_WINDOW);
    }
  }
  return pops;
}

/**
 * Krtci v pořadí vykouknutí a hodní sousedé v témž tiku, bez událostí. Díra krtka je jiná než
 * předchozího a volná (předchozí cíl se v ní schoval aspoň před `rest` tiky); soused bere jinou volnou.
 */
export function whackPlainPops(seed: number, params: WhackParams, lives: number): Pop[] {
  const rng = createCompileRng(seed ^ SALT);
  const moles = params.targets + WHACK.free + lives - 1;
  const stretch = stretchOf(params.targets);
  const freeAt = Array.from({ length: LANES.count }, () => 0);
  const pops: Pop[] = [];
  let hole = -1;
  let up = 0;
  let plain = 0;
  for (let index = 0; index < moles; index += 1) {
    const third = thirdOf(index, params.targets);
    const [low, high] = WHACK.gaps[third] as readonly [number, number];
    up = index === 0 ? WHACK.firstUp : up + Math.round((rng.int(low, high) * stretch) / 1000);
    const holes = Array.from({ length: LANES.count }, (_, candidate) => candidate).filter((candidate) => candidate !== hole && freeAt[candidate]! <= up);
    hole = rng.pick(holes);
    const [shortest, longest] = WHACK.windows[third] as readonly [number, number];
    const window = rng.int(shortest, longest);
    pops.push({ up, hole, window, good: false, mark: 0 });
    freeAt[hole] = up + window + WHACK.rest;
    const drawn = rng.int(0, 999) < (WHACK.decoys[third] as number);
    if (index > 0 && (drawn || plain >= WHACK.plainRun)) {
      // Okno + odpočinek je kratší než nejmenší rozestup další třetiny o víc než dvě díry: volné jsou vždy aspoň tři.
      const beside = rng.pick(holes.filter((candidate) => candidate !== hole));
      pops.push({ up, hole: beside, window, good: true, mark: 0 });
      freeAt[beside] = up + window + WHACK.rest;
      plain = 0;
    } else plain += 1;
  }
  return pops;
}

/** Úroveň bouchání: hrdina ve startovním pruhu za řadou děr a cíle, které ještě nevykoukly. */
export function whackLevel(seed: number, params: WhackParams, lives: number): ArcadeLevel {
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: laneX(LANE_START), y: 0, z: 0, ...WHACK.hero, solid: false },
    ...whackPops(seed, params, lives).map((pop): BodyInit => {
      const vy = riseFor(pop.window);
      return {
        role: pop.good ? 'hazard' : 'target',
        kind: pop.good ? 'snag' : 'target',
        x: laneX(pop.hole),
        y: startY(pop.up, vy),
        z: WHACK.holeZ,
        ...WHACK.target,
        solid: false,
        vy,
        kinematic: true,
        ...(pop.mark > 0 ? { hp: pop.mark } : {}),
      };
    }),
  ];
  return { bodies, length: 0 };
}

/** Cíle zpět z hotové úrovně (pořadí těl). */
export function popsOf(level: ArcadeLevel): Pop[] {
  return level.bodies.slice(1).map((body) => {
    const vy = body.vy ?? 0;
    return { up: vy > 0 ? upOf(body.y, vy, 0) : -1, hole: laneOfX(body.x), window: vy > 0 ? windowOf(vy) : 0, good: body.role === 'hazard', mark: body.hp ?? 0 };
  });
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou úrovní; prázdné pole = hratelná. */
export function checkWhackLevel(level: ArcadeLevel, params: WhackParams, lives: number): string[] {
  const issues: string[] = [];
  const pops = popsOf(level);
  const moles = pops.filter((pop) => !pop.good && pop.mark === 0);
  const need = params.targets + WHACK.free + lives - 1;
  if (moles.length < need) issues.push(`only ${moles.length} moles pop up – whacking ${params.targets} needs ${need}`);
  level.bodies.slice(1).forEach((body, index) => {
    const pop = pops[index] as Pop;
    if (body.kinematic !== true || (body.vy ?? 0) <= 0 || pop.up < 0 || body.y !== startY(pop.up, body.vy ?? 0) || body.x !== laneX(pop.hole) || body.z !== WHACK.holeZ) {
      issues.push(`target ${index + 1} does not pop out of a hole on a whole tick`);
    }
  });
  // V díře naráz nejvýš jeden cíl – ťuk tak vždy míří na jediný.
  for (let hole = 0; hole < LANES.count; hole += 1) {
    const here = pops.filter((pop) => pop.hole === hole).sort((a, b) => a.up - b.up);
    here.slice(1).forEach((pop, index) => {
      const before = here[index] as Pop;
      if (pop.up < before.up + before.window + WHACK.rest) issues.push(`hole ${hole} opens at tick ${pop.up} before the target from tick ${before.up} has hidden`);
    });
  }
  moles.forEach((mole, index) => {
    if (index > 0 && mole.up <= (moles[index - 1] as Pop).up) issues.push(`mole ${index + 1} pops up at tick ${mole.up}, not after the one before`);
  });
  // Robot vidí cíl o reakci později a bouchá po jednom za tik, nejstaršího první (i do bonusů – honí je);
  // každý krtek i bonus mu musí vyjít do konce okna.
  let lastTap = -1;
  const struck = pops.filter((pop) => !pop.good).sort((a, b) => a.up - b.up);
  struck.forEach((mole, index) => {
    const tap = Math.max(mole.up + 1 + WHACK_BOT_REACTION, lastTap + 1);
    if (tap > mole.up + mole.window - 1 - WHACK.margin) issues.push(`${mole.mark > 0 ? 'bonus' : 'mole'} ${index + 1} hides ${mole.window} ticks after it pops up, too soon for the bot`);
    lastTap = tap;
  });
  for (const good of pops.filter((pop) => pop.good)) {
    if (!moles.some((mole) => mole.up === good.up && mole.hole !== good.hole)) issues.push(`the good target at tick ${good.up} has no mole in another hole beside it`);
  }
  const end = Math.max(0, ...pops.map((pop) => pop.up + pop.window));
  if (end >= ARCADE_LIMITS.maxTicks) issues.push('the last target hides past the 90 s horizon');
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Díly světa: ovládání pruhů, robot, úroveň a pravidla bouchání. Bez životů ze specu hraje se třemi. */
export function whackParts(seed: number, params: WhackParams, health: number | undefined): ModeParts {
  const lives = health ?? START_LIVES;
  const level = whackLevel(seed, params, lives);
  return {
    control: { id: 'lanes', params: {} },
    bot: { id: 'whack_bot', params: {} },
    level,
    rules: [
      { id: 'whack_hit', params: { free: WHACK.free, points: WHACK.points } },
      // Cíl „rozbito N“ je týž čítač jako u chytání (`items`), pravidlo cíle sdílí.
      { id: 'catch_goal', params: { need: params.targets } },
      { id: 'out_of_health', params: {} },
      // Pilulka postupu HUD (`collectNeed`, kit `08-game-hud.md`) čte cíl z `finish_collected`; tělo cíle svět nemá, takže nevystřelí.
      { id: 'finish_collected', params: { need: params.targets } },
    ],
    issues: checkWhackLevel(level, params, lives),
    health: lives,
  };
}

export const whackHoles: ModeGeneratorPiece<WhackParams> = {
  id: 'whack_holes',
  params: whackParams,
  roles: ['player', 'target', 'hazard'],
  // Rezerva na bonusy událostí (P55 T5): série, zlaté cíle a spěch přes celou hru.
  cost: (params) => ({ bodies: 1 + 2 * (params.targets + WHACK.free + 8) + 80, rules: 4 }),
  generate: (seed, params) => whackLevel(seed, params, START_LIVES),
  parts: whackParts,
};

// ---------------------------------------------------------------------------
// Pravidla

const hitParams = z
  .object({
    /** Schovaní krtci bez trestu. */
    free: z.int().min(0).max(9),
    points: z.int().min(1).max(100),
    /** Počítadlo komba (P46C T3, `withCombo`); bez něj body bez násobiče. */
    combo: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1).optional(),
  })
  .strict();

/** Kolik krtků se už schovalo celých (stav `ESCAPED` zůstává i po zmizení). */
function escapedSoFar(state: Int32Array): number {
  const count = state[HEADER.bodyCount] as number;
  let escaped = 0;
  for (let body = 0; body < count; body += 1) {
    if (state[bodyBase(body) + BODY.role] === ROLE.target && targetStateOf(state, body) === ESCAPED) escaped += 1;
  }
  return escaped;
}

/**
 * Násobič zásahu: ťuk do prázdné díry zapíše do počítadla komba násobič 0 a série začne znovu od ×1;
 * jinak jako sebrání (`nextMultiplier` – v okně komba a bez ztráty života o stupeň výš).
 */
const whackMultiplier = (state: Int32Array, keeper: number): number => ((state[bodyBase(keeper) + BODY.aux0] as number) === 0 ? 1 : nextMultiplier(state, keeper));

/**
 * Úder (tik): cíl, jehož okno doběhlo, se schová (krtek nad kvótu stojí život); ťuk do díry
 * s otevřeným cílem ho zasáhne – krtek dá body, kombo a čítač `items`, hodný cíl vezme život.
 * Ťuk, který nic nezasáhl, shodí kombo.
 */
export const whackHitRule: RulePiece<z.infer<typeof hitParams>> = {
  id: 'whack_hit',
  params: hitParams,
  roles: ['player', 'target', 'hazard'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const effects: ArcadeEffect[] = [];
    const count = state[HEADER.bodyCount] as number;
    const tap = tappedIn(state, player);
    let struck = false;
    let escaped = -1;
    for (let body = 0; body < count; body += 1) {
      if (body === player) continue;
      const base = bodyBase(body);
      if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
      const role = state[base + BODY.role] as number;
      if ((role !== ROLE.target && role !== ROLE.hazard) || (state[base + BODY.vy] as number) <= 0) continue;
      const y = state[base + BODY.y] as number;
      if (y < 0) continue;
      // Bonus události (P55 T5): body a kombo, do cíle se nepočítá; schovaný nic nestojí.
      const mark = role === ROLE.target ? bodyHp(state, body) : 0;
      if (y >= WHACK.band) {
        if (role === ROLE.target && mark === 0) {
          if (escaped < 0) escaped = escapedSoFar(state);
          escaped += 1;
          effects.push({ kind: 'stateChange', body, state: ESCAPED });
          if (escaped > params.free) effects.push({ kind: 'damage', amount: 1 });
        }
        effects.push({ kind: 'despawn', body });
        continue;
      }
      if (tap === null || laneOfX(state[base + BODY.x] as number) !== tap) continue;
      struck = true;
      if (role === ROLE.hazard) {
        effects.push({ kind: 'damage', amount: 1 }, { kind: 'despawn', body });
        continue;
      }
      const multiplier = params.combo === undefined ? 1 : whackMultiplier(state, params.combo);
      if (mark > 0) effects.push({ kind: 'score', amount: params.points * (mark === EVENT_MARK.golden ? LANE_EVENTS.goldenPoints : 1) * multiplier }, { kind: 'despawn', body });
      else effects.push({ kind: 'score', amount: params.points * multiplier }, { kind: 'count', counter: 'items', amount: 1 }, { kind: 'despawn', body });
      if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
    }
    if (tap !== null && !struck && params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier: 0 });
    return effects;
  },
};

export const WHACK_RULES = { whack_hit: whackHitRule } as const;
