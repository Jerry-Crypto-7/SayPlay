/**
 * Chytání (P54C T5): věci padají v pěti pruzích (`lanes.ts`) a hrdina je chytá košem.
 *
 * Každá věc je kinematické tělo, které padá stálou rychlostí ze semínka a lapací čáru
 * (`CATCH.catchY`, výška koše) protne přesně v jednom tiku – „dopad“ (`landingTick`).
 * O věci rozhoduje jen ten tik: stojí-li hrdina v jejím pruhu, ovoce chytí (body, kombo,
 * čítač `items`) a bomba mu vezme život; jinak ovoce propadne (prvních `free` propadlých
 * je bez trestu, každé další stojí život) a bomba dopadne vedle. Propadlé ovoce i bomba
 * zmizí na zemi. Výhra = chytit `items` věcí (`catch_goal`), prohra = životy došly.
 *
 * Hra jde po třetinách cíle: věci padají rychleji (jsou vidět 90, 56 a 32 tiků) a hustěji,
 * bomb mezi ovocem přibývá. Bomba padá vždy v témž tiku jako ovoce, v jiném pruhu – často
 * v tom, kterým hráč na cestě k ovoci prochází: kdo přijde pozdě, chytí bombu.
 *
 * **Hratelné z konstrukce** (`checkCatchLevel`): robot světa (`catch-fall-bot.ts`, reakce
 * `CATCH_BOT_REACTION`) stihne do každého pruhu dojet, i když ovoce uvidí až po dopadu
 * předchozího. Prvních `free + životy` kusů ovoce nepadá do startovního pruhu, takže nečinný
 * hráč přijde o všechny životy dřív, než mu do koše něco spadne (čítač chycených stojí na 0).
 * Ovoce je `items + free + životy − 1`: kdo ho všechno nechytí, prohraje nejpozději posledním.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  type BodyInit,
  COUNTER,
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
import { EVENT_MARK, LANE_EVENTS, type LaneEvent, laneEventCursor, laneEventRng, planLaneEvents, stepLane } from './lane-events';
import { LANES, LANE_START, laneOfX, laneX } from './lanes';
import { nextMultiplier } from './rules';

export const CATCH = {
  /** Lapací čára: výška koše v rukou hrdiny (j nad zemí). */
  catchY: 1200,
  /** Výš visí věc nad obrazem – scéna ji nekreslí a robot ji nevidí. */
  viewTop: 8400,
  hero: { w: 1200, h: 1600, d: 1000 },
  thing: { w: 800, h: 800, d: 800 },
  /** Rychlost pádu po třetinách cíle (j/tik): věc je nad lapací čárou vidět 90, 56 a 32 tiků. */
  speeds: [80, 128, 225],
  /** Rozestup dopadů po třetinách (tiky), před natažením pro malý cíl (`stretchOf`). */
  gaps: [
    [80, 110],
    [55, 75],
    [38, 52],
  ],
  /** Kolik ovoce (‰) má v témž tiku bombu v jiném pruhu, po třetinách. */
  decoys: [250, 450, 600],
  /** Dopad prvního ovoce: je vidět od tiku 0. */
  firstLanding: 80,
  /**
   * Propadlé ovoce bez trestu; každé další stojí život. Ladění 20. 10. (20 / 60 semínek, začátečník):
   * 2 → 0,15, 3 → 0,35 / 0,43, 4 → 0,50 / 0,57; intermediate a robot světa 1,0 ve všech.
   * P55 T5: bonusy událostí na sebe berou chyby začátečníka (honí bonus, ne ovoce), se 4 vyhrával 0,8 – proto 3.
   */
  free: 3,
  points: 10,
  items: { min: 10, max: 50, default: 30 },
  /** Cíl, pod kterým se rozestupy natahují, ať hra trvá aspoň půl minuty. */
  pacedItems: 30,
  /** Rezerva robota světa nad nejkratší jízdou do pruhu (tiky). */
  margin: 2,
} as const;

/** Reakce robota světa – generátor s ní počítá, ať robot stihne každé ovoce. */
export const CATCH_BOT_REACTION = 8;

/** Stav ovoce, které propadlo (bity stavu cíle ve `flags`, `setTargetState`). */
export const MISSED = 1;

const SALT = 0xca7c;

/** Stojí hrdina v pruhu věci? Vždy právě v jednom pruhu: ten s nejbližším středem. */
export const underThing = (state: Int32Array, player: number, body: number): boolean =>
  Math.abs((state[bodyBase(player) + BODY.x] as number) - (state[bodyBase(body) + BODY.x] as number)) * 2 < LANES.width;

/** Nejméně tiků jízdy přes `lanes` pruhů, než hrdina stojí v cílovém (ze středu výchozího). */
export const travelTicks = (lanes: number): number => (lanes === 0 ? 0 : Math.ceil((lanes * LANES.width - LANES.width / 2 + 1) / LANES.speed));

/** Kolik tiků je věc padající rychlostí `speed` vidět nad lapací čárou. */
export const visibleTicks = (speed: number): number => Math.floor((CATCH.viewTop - CATCH.catchY) / speed);

/**
 * Tik dopadu věci, kterou stav z tiku `tick` ukazuje ve výšce `y` při pádu `speed`: tik, v jehož
 * kroku protne lapací čáru. Menší než `tick` = už dopadla.
 */
export const landingTick = (y: number, speed: number, tick: number): number => tick - 1 + Math.ceil((y - CATCH.catchY) / speed);

/** Je věc v obraze (pod korunou)? Scéna ji kreslí až odsud, ohlášení události ji odsud počítá. */
export const catchInView = (state: Int32Array, body: number): boolean => (state[bodyBase(body) + BODY.y] as number) <= CATCH.viewTop;

/** Výška věci v tiku 0, aby lapací čáru protnula v tiku `landing`. */
const dropHeight = (landing: number, speed: number): number => CATCH.catchY + speed * (landing + 1);

/** Ovoce v tiku 0, k dispozici pro rozbor (`checkCatchLevel`, testy). */
export interface Drop {
  readonly landing: number;
  readonly lane: number;
  readonly speed: number;
  readonly bomb: boolean;
  /** Bonus události (P55 T5, `EVENT_MARK`): body a kombo, do cíle se nepočítá a propadnout smí; 0 = běžné ovoce. */
  readonly mark: number;
}

/** Rozestup bonusů série a spěchu (tiky): rychle za sebou, ale robot s reakcí je stihne. */
const BONUS_GAP = [14, 20] as const;
/** Zlatý cíl padá rychleji (‰ rychlosti třetiny), nejvýš tak, aby byl vidět aspoň `GOLDEN_MIN_VISIBLE` tiků. */
const GOLDEN_SPEED = 1500;
const GOLDEN_MIN_VISIBLE = 22;

export const catchParams = z
  .object({
    /** Kolik věcí chytit (`COUNT_PARAMS.catch.default.collectible`). */
    items: z.int().min(CATCH.items.min).max(CATCH.items.max).default(CATCH.items.default),
  })
  .strict();
export type CatchParams = z.infer<typeof catchParams>;

/** Natažení rozestupů (‰): cíl pod `pacedItems` dostane delší mezery, ať hra nekončí za pár vteřin. */
const stretchOf = (items: number): number => Math.max(1000, Math.round((CATCH.pacedItems * 1000) / items));

/** Třetina cíle, do které patří ovoce `index` (ovoce za cílem je ve třetí). */
const thirdOf = (index: number, items: number): number => Math.min(2, Math.floor((3 * index) / items));

/**
 * Rozpis dopadů ze semínka: ovoce v pořadí dopadu a bomby v témž tiku. Pruh ovoce je jiný
 * než předchozí; prvních `free + lives` kusů nepadá do startovního pruhu.
 */
export function catchDrops(seed: number, params: CatchParams, lives: number): Drop[] {
  // Osa událostí potřebuje délku hry: nejdřív rozpis bez nich (týž los rozvržení), pak s nimi.
  const plain = layDrops(seed, params, lives, null);
  return layDrops(seed, params, lives, planLaneEvents(seed, (plain.at(-1) as Drop).landing));
}

/**
 * Rozpis dopadů; s `events` padají do mezer mezi ovocem bonusy událostí (P55 T5). Los ovoce a bomb jde ze
 * streamu rozvržení v témž pořadí s událostmi i bez nich – bonusy mají vlastní stream (`laneEventRng`) a ovoce
 * jen posunou, když mezera na bonus nestačí.
 */
function layDrops(seed: number, params: CatchParams, lives: number, events: readonly LaneEvent[] | null): Drop[] {
  const rng = createCompileRng(seed ^ SALT);
  const bonusRng = laneEventRng(seed);
  const cursor = events === null ? null : laneEventCursor(events);
  const fruit = params.items + CATCH.free + lives - 1;
  const guarded = CATCH.free + lives;
  const stretch = stretchOf(params.items);
  const drops: Drop[] = [];
  let lane = LANE_START;
  let landing = 0;
  for (let index = 0; index < fruit; index += 1) {
    const third = thirdOf(index, params.items);
    const speed = CATCH.speeds[third] as number;
    const options = Array.from({ length: LANES.count }, (_, candidate) => candidate).filter((candidate) => candidate !== lane && (index >= guarded || candidate !== LANE_START));
    const next = rng.pick(options);
    const [low, high] = CATCH.gaps[third] as readonly [number, number];
    const wanted = Math.round((rng.int(low, high) * stretch) / 1000);
    if (index === 0) landing = CATCH.firstLanding;
    else {
      // Bonusy v mezeře: od posledního ovoce směrem k dalšímu, každý dosažitelný z předchozího.
      // Ovoce dopadne tam, kde by dopadlo bez událostí: bonus přibude, jen když se do mezery vejde i s cestou
      // k dalšímu ovoci – obtížnost ovoce se nemění, honit bonus je riziko navíc.
      const due = landing + Math.max(wanted, travelTicks(Math.abs(next - lane)) + CATCH.margin);
      let at = landing;
      let atLane = lane;
      const put = (mark: number, gap: number, to: number, fall: number): void => {
        const when = at + Math.max(gap, travelTicks(Math.abs(to - atLane)) + CATCH.margin);
        if (when + travelTicks(Math.abs(next - to)) + CATCH.margin > due) return;
        const from = atLane;
        at = when;
        atLane = to;
        drops.push({ landing: at, lane: to, speed: fall, bomb: false, mark });
        // Jako u ovoce: kdo za bonusem jede pozdě, stojí v pruhu, odkud jel, a chytí bombu.
        // Zlatý cíl jde dvěma kroky a na kraji se vrátí do výchozího pruhu – tam bomba nepatří.
        if (from !== to) drops.push({ landing: at, lane: from, speed: fall, bomb: true, mark: 0 });
      };
      // Série a zlatý cíl vedou od cesty k dalšímu ovoci: kdo je honí, riskuje, že ovoce nestihne.
      const away = next >= LANE_START ? 0 : LANES.count - 1;
      const event = cursor?.take(landing) ?? null;
      if (event?.kind === 'series') {
        for (let n = bonusRng.int(...LANE_EVENTS.series); n > 0; n -= 1) put(EVENT_MARK.series, bonusRng.int(...BONUS_GAP), stepLane(atLane, away, LANES.count, bonusRng), speed);
      } else if (event?.kind === 'golden') {
        // Zlatý cíl padá rychleji a až dva pruhy stranou: odbočka za víc bodů.
        const fall = Math.min(Math.round((speed * GOLDEN_SPEED) / 1000), Math.floor((CATCH.viewTop - CATCH.catchY) / GOLDEN_MIN_VISIBLE));
        put(EVENT_MARK.golden, bonusRng.int(24, 36), stepLane(stepLane(atLane, away, LANES.count, bonusRng), away, LANES.count, bonusRng), fall);
      } else if (cursor?.inRush(landing) === true) {
        for (let n = 2; n > 0; n -= 1) put(EVENT_MARK.rush, bonusRng.int(...BONUS_GAP), stepLane(atLane, next, LANES.count, bonusRng), speed);
      }
      landing = due;
    }
    drops.push({ landing, lane: next, speed, bomb: false, mark: 0 });
    if (rng.int(0, 999) < (CATCH.decoys[third] as number)) {
      // Bomba na cestě: pruh, ve kterém stojí, kdo k ovoci nedojel (u sousedního pruhu ten, odkud jde).
      const path = Math.abs(next - lane) >= 2 ? next - Math.sign(next - lane) : lane;
      const others = Array.from({ length: LANES.count }, (_, candidate) => candidate).filter((candidate) => candidate !== next);
      const onPath = index > 0 && rng.int(0, 1) === 0;
      drops.push({ landing, lane: onPath ? path : rng.pick(others), speed, bomb: true, mark: 0 });
    }
    lane = next;
  }
  return drops;
}

/** Úroveň chytání: hrdina ve startovním pruhu a věci, které ještě visí nad obrazem. */
export function catchLevel(seed: number, params: CatchParams, lives: number): ArcadeLevel {
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: laneX(LANE_START), y: 0, z: 0, ...CATCH.hero, solid: false },
    ...catchDrops(seed, params, lives).map(
      (drop): BodyInit => ({
        role: drop.bomb ? 'hazard' : 'collectible',
        kind: drop.bomb ? 'snag' : 'coin',
        x: laneX(drop.lane),
        y: dropHeight(drop.landing, drop.speed),
        z: 0,
        ...CATCH.thing,
        solid: false,
        vy: -drop.speed,
        kinematic: true,
        ...(drop.mark > 0 ? { hp: drop.mark } : {}),
      }),
    ),
  ];
  return { bodies, length: 0 };
}

/** Dopady zpět z hotové úrovně (pořadí těl). */
export function dropsOf(level: ArcadeLevel): Drop[] {
  return level.bodies.slice(1).map((body) => {
    const speed = -(body.vy ?? 0);
    return { landing: landingTick(body.y, speed, 0), lane: laneOfX(body.x), speed, bomb: body.role === 'hazard', mark: body.hp ?? 0 };
  });
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou úrovní; prázdné pole = hratelná. */
export function checkCatchLevel(level: ArcadeLevel, params: CatchParams, lives: number): string[] {
  const issues: string[] = [];
  const drops = dropsOf(level);
  // Dosažitelnost platí pro všechno, co se chytá (i bonusy – robot je honí); počet a nečinný hráč jen pro ovoce cíle.
  const fruit = drops.filter((drop) => !drop.bomb);
  const counted = fruit.filter((drop) => drop.mark === 0);
  if (counted.length < params.items + CATCH.free + lives - 1) issues.push(`only ${counted.length} things fall – catching ${params.items} needs ${params.items + CATCH.free + lives - 1}`);
  level.bodies.slice(1).forEach((body, index) => {
    const drop = drops[index] as Drop;
    if (body.kinematic !== true || drop.speed <= 0 || body.y !== dropHeight(drop.landing, drop.speed)) issues.push(`thing ${index + 1} does not cross the catch line on a whole tick`);
  });
  let lane = LANE_START;
  let previous = -1;
  fruit.forEach((drop, index) => {
    const lanes = Math.abs(drop.lane - lane);
    if (drop.landing <= previous) issues.push(`fruit ${index + 1} lands at tick ${drop.landing}, not after the one before`);
    // Robot vyjede po dopadu předchozího, nebo až ovoce uvidí (o reakci později); obojí musí stačit na jízdu.
    const from = Math.max(previous + 1, drop.landing + 1 - visibleTicks(drop.speed) + CATCH_BOT_REACTION);
    if (drop.landing - from + 1 < travelTicks(lanes) + CATCH.margin) issues.push(`fruit ${index + 1} in lane ${drop.lane} lands ${drop.landing - previous} ticks after the last, too soon to cross ${lanes} lanes`);
    lane = drop.lane;
    previous = drop.landing;
  });
  counted.forEach((drop, index) => {
    if (index < CATCH.free + lives && drop.lane === LANE_START) issues.push(`fruit ${index + 1} falls into the start lane, where an idle player would catch it`);
  });
  for (const bomb of drops.filter((drop) => drop.bomb)) {
    if (!fruit.some((drop) => drop.landing === bomb.landing && drop.lane !== bomb.lane)) issues.push(`the bomb at tick ${bomb.landing} has no fruit in another lane beside it`);
  }
  if ((fruit.at(-1)?.landing ?? 0) >= ARCADE_LIMITS.maxTicks) issues.push('the last fruit lands past the 90 s horizon');
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Díly světa: ovládání pruhů, robot, úroveň a pravidla chytání. Bez životů ze specu hraje se třemi. */
export function catchParts(seed: number, params: CatchParams, health: number | undefined): ModeParts {
  const lives = health ?? START_LIVES;
  const level = catchLevel(seed, params, lives);
  return {
    control: { id: 'lanes', params: {} },
    bot: { id: 'catch_bot', params: {} },
    level,
    rules: [
      { id: 'catch_fall', params: { free: CATCH.free, points: CATCH.points } },
      { id: 'catch_goal', params: { need: params.items } },
      { id: 'out_of_health', params: {} },
      // Pilulka postupu HUD (`collectNeed`, kit `08-game-hud.md`) čte cíl z `finish_collected`; tělo cíle svět nemá, takže nevystřelí.
      { id: 'finish_collected', params: { need: params.items } },
    ],
    issues: checkCatchLevel(level, params, lives),
    health: lives,
  };
}

export const catchFall: ModeGeneratorPiece<CatchParams> = {
  id: 'catch_fall',
  params: catchParams,
  roles: ['player', 'collectible', 'hazard'],
  // Rezerva na bonusy událostí (P55 T5): série, zlaté cíle a spěch přes celou hru.
  cost: (params) => ({ bodies: 1 + 2 * (params.items + CATCH.free + 8) + 80, rules: 4 }),
  generate: (seed, params) => catchLevel(seed, params, START_LIVES),
  parts: catchParts,
};

// ---------------------------------------------------------------------------
// Pravidla

const fallParams = z
  .object({
    /** Propadlé ovoce bez trestu. */
    free: z.int().min(0).max(9),
    points: z.int().min(1).max(100),
    /** Počítadlo komba (P46C T3, `withCombo`); bez něj body bez násobiče. */
    combo: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1).optional(),
  })
  .strict();

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Kolik ovoce už propadlo (stav `MISSED` zůstává i po zmizení na zemi). */
function missedSoFar(state: Int32Array): number {
  const count = state[HEADER.bodyCount] as number;
  let missed = 0;
  for (let body = 0; body < count; body += 1) {
    if (state[bodyBase(body) + BODY.role] === ROLE.collectible && targetStateOf(state, body) === MISSED) missed += 1;
  }
  return missed;
}

/**
 * Dopad (tik): věc, která v tomhle kroku protnula lapací čáru, rozhodne podle pruhu hrdiny.
 * Věc pod lapací čárou, která dopadla na zem, zmizí.
 */
export const catchFallRule: RulePiece<z.infer<typeof fallParams>> = {
  id: 'catch_fall',
  params: fallParams,
  roles: ['player', 'collectible', 'hazard'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, rests }, params) => {
    // Tik odpočinku férového startu (P70A T3): nic nespadlo, průchod čárou z `y − vy` by se započetl podruhé.
    if (rests === true) return [];
    const effects: ArcadeEffect[] = [];
    const count = state[HEADER.bodyCount] as number;
    let missed = -1;
    for (let body = 0; body < count; body += 1) {
      if (body === player || !alive(state, body)) continue;
      const base = bodyBase(body);
      const role = state[base + BODY.role] as number;
      if (role !== ROLE.collectible && role !== ROLE.hazard) continue;
      const y = state[base + BODY.y] as number;
      const vy = state[base + BODY.vy] as number;
      if (vy >= 0) continue;
      if (y <= 0) {
        effects.push({ kind: 'despawn', body });
        continue;
      }
      if (y > CATCH.catchY || y - vy <= CATCH.catchY) continue;
      const caught = underThing(state, player, body);
      if (role === ROLE.hazard) {
        if (caught) effects.push({ kind: 'damage', amount: 1 }, { kind: 'despawn', body });
        continue;
      }
      // Bonus události (P55 T5): body a kombo, do cíle se nepočítá; propadlý nic nestojí.
      const mark = bodyHp(state, body);
      if (mark > 0) {
        if (!caught) continue;
        const multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo);
        const points = params.points * (mark === EVENT_MARK.golden ? LANE_EVENTS.goldenPoints : 1);
        effects.push({ kind: 'score', amount: points * multiplier }, { kind: 'despawn', body });
        if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
        continue;
      }
      if (caught) {
        const multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo);
        effects.push({ kind: 'score', amount: params.points * multiplier }, { kind: 'count', counter: 'items', amount: 1 }, { kind: 'despawn', body });
        if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
        continue;
      }
      if (missed < 0) missed = missedSoFar(state);
      missed += 1;
      effects.push({ kind: 'stateChange', body, state: MISSED });
      if (missed > params.free) effects.push({ kind: 'damage', amount: 1 });
    }
    return effects;
  },
};

const goalParams = z.object({ need: z.int().min(1).max(ARCADE_LIMITS.maxBodies) }).strict();

/** Chyceno `need` věcí → výhra (průchod čítačů, až po započtení dopadů tiku). */
export const catchGoalRule: RulePiece<z.infer<typeof goalParams>> = {
  id: 'catch_goal',
  params: goalParams,
  roles: ['player'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => ((state[HEADER.counters + COUNTER.items] as number) >= params.need ? [{ kind: 'win' }] : []),
};

export const CATCH_RULES = { catch_fall: catchFallRule, catch_goal: catchGoalRule } as const;
