/**
 * Trať přeskákání silnice (P54C T9): mřížka, pásy provozu ze semínka a tvrzení „hratelné z konstrukce“.
 *
 * **Mřížka.** Devět sloupců (`HOP.cols`, pole `HOP.cell`), řady vpřed po +z. Řada 0 je start, řada `rows` cíl;
 * řady 0–2 a cíl jsou tráva, mezi nimi pásy: silnice (2–5 pruhů aut), řeka (1–3 pruhy klád), koleje (vlak
 * s varováním). Mezi pásy jedna řada trávy.
 *
 * **Provoz** je kinematický a periodický ze semínka: pás má jednu periodu, za kterou jeho řadami projede vzor vozidel
 * a pak se opakuje. Řada silnice je kolona aut (pod-pruhy téže řady s posunutou fází) s jedinou mezerou, kterou hrdina
 * projde; ostatní mezery jsou kratší, než kolik v pruhu stráví. Řeka má jednu kládu za periodu, koleje jeden vlak.
 * Fáze jsou zarovnané na jeden zaručený přechod za periodu prostředním sloupcem.
 *
 * **Hratelné z konstrukce** (`checkHopLevel`): z prostředního sloupce trávy před pásem (robot drží střed pole) jde
 * nejpozději `HOP.longestWait` tiků po příchodu vyrazit a pásem projít skoky vpřed nejvýš za `HOP.longestCross` tiků –
 * s rezervou robota, na řece bez čekání na kládě. Počítá to zpětný průchod po ticích jedné periody
 * (`bandCrossings`); pás, který to nesplní, generátor vylosuje znovu. Celou trať, kterou by robot světa prošel rychleji
 * než za `HOP.shortest` tiků (`predictedTicks`), generátor vylosuje znovu taky.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeLevel, type BodyInit } from '../contract';

export const HOP = {
  cell: 1200,
  cols: 9,
  /** Tiky jednoho skoku (0,27 s); `cell / hopTicks` je celé číslo. */
  hopTicks: 16,
  hero: { w: 600, h: 900, d: 600 },
  car: { w: 1500, h: 900, d: 700 },
  truck: { w: 2600, h: 1100, d: 750 },
  train: { w: 13200, h: 1300, d: 800 },
  log: { h: 250, d: 800 },
  logs: [2400, 3600, 4800],
  /** Vozidlo vjede tolik za hranou pole (od jeho konce). */
  margin: 600,
  trainSpeed: 300,
  /** Varování vlaku: tolik tiků před tím, než čelo dojede k hraně pole. */
  trainLead: 45,
  /** Orel: tolik tiků bez skoku = prohra (6 s). */
  eagle: 6 * 60,
  /** Životy: dva (Crossy Road má jeden) – náraz i voda je drahý. */
  lives: 2,
  rows: { min: 10, max: 50, default: 50 },
  points: 10,
  /** Řady 0–2 jsou tráva: robot vidí provoz (předjetý v tiku 0–7) dřív, než k první silnici doskáče. */
  startGrass: 3,
  /** Páska cíle za středem cílové řady: hrdina se jí dotkne až dopadem, když už je řada započtená. */
  goalAhead: 360,
  /** Pás po třetinách cíle: silnice, řeka, koleje (‰). */
  bandKinds: [
    [700, 200, 100],
    [650, 200, 150],
    [650, 200, 150],
  ],
  roadLanes: [
    [2, 4],
    [3, 5],
    [4, 5],
  ],
  riverLanes: [
    [1, 2],
    [2, 3],
    [2, 3],
  ],
  railLanes: [
    [1, 1],
    [1, 1],
    [1, 2],
  ],
  /** Rychlosti aut (j/tik): pomalá, střední, rychlá. */
  speeds: {
    slow: [45, 65],
    medium: [75, 105],
    fast: [220, 260],
  },
  /** Kolik pruhů silnice (‰) je rychlých a kolik ze zbytku středních, po třetinách. */
  fastShare: [300, 500, 650],
  mediumShare: [400, 500, 500],
  /** Kolik pomalých a středních pruhů (‰) vozí náklaďák místo auta. */
  truckShare: 250,
  /** Perioda pásu silnice (tiky), po třetinách: za ni projede pruhem kolona aut a pak se opakuje. */
  roadPeriod: [
    [260, 316],
    [280, 316],
    [290, 316],
  ],
  /** Mezera mezi auty (tiky nad obsazení s rezervou), kterou hrdina pruhem projde bez čekání. */
  passGap: 18,
  /** O kolik je mezera na přeskok delší než `passGap` (tiky), po třetinách. */
  passExtra: [
    [4, 12],
    [2, 8],
    [0, 6],
  ],
  /** Mezery mezi auty kolony (tiky nad obsazení s rezervou): kratší, než kolik hrdina v pruhu stráví. */
  convoyGap: [2, 14],
  /** Nejvíc aut v řadě za periodu pásu (sloty a efekty za tik). */
  carsPerRow: 10,
  /** Řeka: perioda pásu, rychlost klád (j/tik), délky po třetinách a voda mezi nimi (j, nejméně `minGap`). */
  river: {
    period: [170, 230],
    speed: [28, 60],
    minGap: 1200,
    lengths: [
      [2400, 3600],
      [2400, 3600],
      [2400],
    ],
    gaps: [
      [3000, 4400],
      [3400, 5000],
      [3800, 5600],
    ],
  },
  rail: { period: [240, 400] },
  /** Nejdéle, co robot na trávě před pásem čeká, než pásem projde (tiky); pod orlem, ať ho i hráč stihne. */
  longestWait: 320,
  /** Nejdelší zaručený přechod pásu od skoku z trávy po trávu za ním (tiky) – robot plánuje dál (`HORIZON`). */
  longestCross: 110,
  /** Kolikrát generátor pás vylosuje, než ho vzdá. */
  bandTries: 12,
  /** Nejkratší a nejdelší hra robota světa (odhad `predictedTicks`) a kolikrát generátor trať vylosuje. */
  shortest: 34 * ARCADE_HZ,
  longest: 80 * ARCADE_HZ,
  courseTries: 8,
  /** Řad, které pravidlo předjede v jednom tiku (strop efektů za tik). */
  rowsPerWarmTick: 5,
} as const;

/** Prostřední sloupec (`x = 0`). */
export const HOP_MID = (HOP.cols - 1) / 2;
/** Polovina šíře pole: střed hrdiny dál = odvezen kládou. */
export const HOP_HALF = (HOP.cols * HOP.cell) / 2;
export const HOP_STEP = HOP.cell / HOP.hopTicks;

/** Reakce robota světa a jeho rezerva (tiky) kolem vozidel – kontrola úrovně s nimi počítá. */
export const HOP_BOT_REACTION = 8;
export const HOP_BOT_MARGIN = 1;
/** Robot dopadá na kládu aspoň tolik od jejího konce (j). */
export const HOP_LOG_INSET = 150;

export const ROW = { grass: 0, road: 1, river: 2, rail: 3 } as const;
export const DIR = { forward: 0, back: 1, left: 2, right: 3 } as const;

/** Indexy těl úrovně: hrdina 0, předlohy provozu, páska cíle, pak značky trávy (místa návratu). */
export const HOP_BODIES = { car: 1, truck: 2, log2: 3, log3: 4, log4: 5, train: 6, goal: 7, markers: 8 } as const;

const SALT = 0x40b0;

export const colX = (col: number): number => (col - HOP_MID) * HOP.cell;
/** Sloupec nejbližší `x` (krajní berou i to, co je za nimi). */
export const colOf = (x: number): number => Math.min(HOP.cols - 1, Math.max(0, Math.round(x / HOP.cell) + HOP_MID));
/** Řada, ve které hrdina je: přes polovinu skoku už ta další. */
export const rowOf = (z: number): number => Math.floor((z + HOP.cell / 2) / HOP.cell);

/** Pruh provozu jedné řady. `entry` a `exit` jsou vzdálenosti od středu pole (kladné) na straně vjezdu a výjezdu. */
export interface HopLane {
  readonly row: number;
  readonly kind: 1 | 2 | 3;
  readonly template: number;
  readonly w: number;
  readonly d: number;
  readonly dir: 1 | -1;
  readonly speed: number;
  readonly period: number;
  /** Vozidlo vyjede v tiku `phase + k · period`. */
  readonly phase: number;
  /** Tik, ve kterém pravidlo pruh předjede (vozidla vyslaná dřív postaví rovnou na jejich místa). */
  readonly warm: number;
  readonly entry: number;
  readonly exit: number;
}

/** Pás: řady jednoho druhu za sebou. */
export interface HopBand {
  readonly kind: 1 | 2 | 3;
  readonly first: number;
  readonly count: number;
}

export interface HopLayout {
  /** Druh každé řady 0..`rows` (`ROW`). */
  readonly kinds: readonly number[];
  readonly lanes: readonly HopLane[];
  readonly bands: readonly HopBand[];
}

export const hopParams = z
  .object({
    /** Kolik řad dojít (`paramBounds.rows` modulu `hop`). */
    rows: z.int().min(HOP.rows.min).max(HOP.rows.max).default(HOP.rows.default),
  })
  .strict();
export type HopParams = z.infer<typeof hopParams>;

const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** Tiky, kdy vozidlo zabírá sloupec hrdiny i s rezervou robota. */
export const occupancy = (w: number, speed: number): number => Math.ceil((w + HOP.hero.w) / speed) + 2 * HOP_BOT_MARGIN;

/** Kolik tiků je vozidlo pruhu naživu: od vyslání do kroku, ve kterém minulo výjezd. */
export const laneLife = (lane: Pick<HopLane, 'entry' | 'exit' | 'speed'>): number => Math.ceil((lane.entry + lane.exit) / lane.speed);

/** Kolik vozidel pruhu je naráz naživu (horní mez; vyslaná dřív, než pravidlo předjede, vzniknou až v tiku předjetí). */
export const laneSlots = (lane: Pick<HopLane, 'entry' | 'exit' | 'speed' | 'period'>): number => Math.floor(laneLife(lane) / lane.period) + 2;

type Rng = ReturnType<typeof createCompileRng>;

const pickWeighted = (rng: Rng, weights: readonly number[]): number => {
  let draw = rng.int(0, weights.reduce((sum, weight) => sum + weight, 0) - 1);
  for (let index = 0; index < weights.length; index += 1) {
    draw -= weights[index] as number;
    if (draw < 0) return index;
  }
  return weights.length - 1;
};

/** Pruhy pásu `band` (všechny pod-pruhy jeho řad). */
export const bandLanesOf = (layout: Pick<HopLayout, 'lanes'>, band: HopBand): HopLane[] => layout.lanes.filter((lane) => lane.row >= band.first && lane.row < band.first + band.count);

/**
 * Rozvržení ze semínka: druhy řad, pruhy provozu a pásy. Pás, kterým by robot neprošel včas, se losuje znovu; trať,
 * kterou by robot světa prošel mimo `HOP.shortest`–`HOP.longest` tiků, taky (jinak ta, která je mezím nejblíž).
 */
export function hopLayout(seed: number, params: HopParams): HopLayout {
  const rng = createCompileRng(seed ^ SALT);
  let best: HopLayout | null = null;
  let miss = Infinity;
  for (let tries = 0; tries < HOP.courseTries && miss > 0; tries += 1) {
    const layout = courseOf(rng, params);
    const ticks = predictedTicks(layout);
    const off = ticks < HOP.shortest ? HOP.shortest - ticks : ticks > HOP.longest ? ticks - HOP.longest : 0;
    if (off < miss) {
      best = layout;
      miss = off;
    }
  }
  return best as HopLayout;
}

function courseOf(rng: Rng, params: HopParams): HopLayout {
  const last = params.rows;
  const kinds: number[] = Array.from({ length: last + 1 }, () => ROW.grass);
  const lanes: HopLane[] = [];
  const bands: HopBand[] = [];
  let row: number = HOP.startGrass;
  let previous = -1;
  while (row < last) {
    const third = Math.min(2, Math.floor((3 * row) / last));
    const weights = [...(HOP.bandKinds[third] as readonly number[])];
    if (previous === ROW.rail) weights[2] = 0;
    const kind = (pickWeighted(rng, weights) + 1) as 1 | 2 | 3;
    const [low, high] = (kind === ROW.road ? HOP.roadLanes : kind === ROW.river ? HOP.riverLanes : HOP.railLanes)[third] as readonly [number, number];
    const count = Math.min(rng.int(low, high), last - row);
    let band = bandLanes(rng, kind, row, count, third);
    for (let tries = 1; tries < HOP.bandTries && bandWait(band) > HOP.longestWait; tries += 1) band = bandLanes(rng, kind, row, count, third);
    for (const lane of band) {
      kinds[lane.row] = kind;
      lanes.push(lane);
    }
    bands.push({ kind, first: row, count });
    previous = kind;
    // Za pásem jedna řada trávy.
    row += count + 1;
  }
  // Předjetí po řadách (všechny pod-pruhy řady v témže tiku).
  const order = [...new Set(lanes.map((lane) => lane.row))];
  return { kinds, lanes: lanes.map((lane) => ({ ...lane, warm: Math.floor(order.indexOf(lane.row) / HOP.rowsPerWarmTick) })), bands };
}

// ---------------------------------------------------------------------------
// Trať ze skriptu úrovně (P68 T13, pilot za `PLAY_SCRIPTS`)

/** Druhy řad, které smí skript `build(api)` položit (`api.place(kind, x, z)`). */
export const HOP_SCRIPT_KINDS = ['road', 'river', 'rail'] as const;
/** Odkud jede provoz řady: sloupec `x` v `api.place` pod středem = zleva, nad ním = zprava, střed = ze semínka. */
export const HOP_SCRIPT_SIDES = ['left', 'right', 'any'] as const;
const KIND_ROW = { road: ROW.road, river: ROW.river, rail: ROW.rail } as const;
/** Nejvíc řad jednoho pásu podle druhu (nejširší z třetin `roadLanes`, `riverLanes`, `railLanes`). */
export const HOP_SCRIPT_BAND_MAX = { road: 5, river: 3, rail: 2 } as const;

/**
 * Data úrovně, která skript vyrobí a hra uloží (`spec.scriptLevel.levelData`): kolik řad a které řady jsou silnice,
 * řeka nebo koleje, s nimi strana provozu. Pruhy (rychlosti, periody, fáze) dopočítá důvěryhodný kód ze semínka
 * (`hopScriptedLayout`), takže zaručený přechod pásu drží tatáž konstrukce jako u šablony.
 */
export const hopScriptLevel = z
  .object({
    game: z.literal('hop'),
    rows: z.int().min(HOP.rows.min).max(HOP.rows.max),
    lanes: z
      .array(
        z
          .object({
            row: z.int().min(HOP.startGrass).max(HOP.rows.max - 1),
            kind: z.enum(HOP_SCRIPT_KINDS),
            side: z.enum(HOP_SCRIPT_SIDES),
          })
          .strict(),
      )
      .min(1)
      .max(HOP.rows.max - HOP.startGrass),
  })
  .strict();
export type HopScriptLevel = z.infer<typeof hopScriptLevel>;

/**
 * Pásy dat úrovně: souvislé řady jednoho druhu. `issues` = co trať poruší – řada mimo start a cíl, dvě položení téže
 * řady, dva pásy bez trávy mezi sebou, pás širší než `HOP_SCRIPT_BAND_MAX`.
 */
export function hopScriptBands(level: HopScriptLevel): { readonly bands: HopBand[]; readonly issues: string[] } {
  const issues: string[] = [];
  const lanes = [...level.lanes].sort((a, b) => a.row - b.row);
  const bands: HopBand[] = [];
  for (const [index, lane] of lanes.entries()) {
    if (lane.row >= level.rows) issues.push(`row ${lane.row} is the goal row or past it (the course has ${level.rows} rows, the goal row stays grass)`);
    const before = lanes[index - 1];
    if (before !== undefined && before.row === lane.row) {
      issues.push(`row ${lane.row} is placed twice`);
      continue;
    }
    const band = bands.at(-1);
    if (before !== undefined && band !== undefined && before.row === lane.row - 1) {
      if (before.kind !== lane.kind) issues.push(`rows ${before.row} (${before.kind}) and ${lane.row} (${lane.kind}) need a grass row between them`);
      else {
        bands[bands.length - 1] = { ...band, count: band.count + 1 };
        continue;
      }
    }
    bands.push({ kind: KIND_ROW[lane.kind], first: lane.row, count: 1 });
  }
  for (const band of bands) {
    const kind = HOP_SCRIPT_KINDS[band.kind - 1] as (typeof HOP_SCRIPT_KINDS)[number];
    if (band.count > HOP_SCRIPT_BAND_MAX[kind]) issues.push(`the ${kind} band at row ${band.first} has ${band.count} rows, at most ${HOP_SCRIPT_BAND_MAX[kind]}`);
  }
  return { bands, issues };
}

const SCRIPT_SALT = 0x5c41;

/**
 * Rozvržení z dat úrovně: druhy řad a pásy ze skriptu, pruhy každého pásu stejnou konstrukcí jako `courseOf`
 * (`bandLanes` ze semínka, znovu, dokud robot čeká déle než `HOP.longestWait`), strana provozu ze skriptu. Směr pruhu
 * zaručený přechod prostředním sloupcem nemění (`laneX` je v něm souměrné); `checkHopLevel` ho přesto ověří znovu.
 */
export function hopScriptedLayout(seed: number, level: HopScriptLevel): HopLayout {
  const rng = createCompileRng(seed ^ SCRIPT_SALT);
  const last = level.rows;
  const sides = new Map(level.lanes.map((lane) => [lane.row, lane.side]));
  const kinds: number[] = Array.from({ length: last + 1 }, () => ROW.grass);
  const lanes: HopLane[] = [];
  const { bands } = hopScriptBands(level);
  const sided = (band: HopLane[]): HopLane[] =>
    band.map((lane) => {
      const side = sides.get(lane.row);
      return side === 'left' ? { ...lane, dir: 1 } : side === 'right' ? { ...lane, dir: -1 } : lane;
    });
  for (const { kind, first, count } of bands) {
    const third = Math.min(2, Math.floor((3 * first) / last));
    let band = sided(bandLanes(rng, kind, first, count, third));
    for (let tries = 1; tries < HOP.bandTries && bandWait(band) > HOP.longestWait; tries += 1) band = sided(bandLanes(rng, kind, first, count, third));
    for (const lane of band) {
      kinds[lane.row] = kind;
      lanes.push(lane);
    }
  }
  const order = [...new Set(lanes.map((lane) => lane.row))];
  return { kinds, lanes: lanes.map((lane) => ({ ...lane, warm: Math.floor(order.indexOf(lane.row) / HOP.rowsPerWarmTick) })), bands };
}

/**
 * Pruhy jednoho pásu: směry se střídají a pás má jednu periodu, takže se jeho provoz po ní opakuje. Silnice: každá řada
 * je kolona aut (pod-pruhy téže řady s posunutou fází) s jedinou mezerou na přeskok; řeka: jedna kláda s vodou za
 * periodu; koleje: jeden vlak.
 *
 * Fáze jsou zarovnané na jeden zaručený přechod za periodu: hrdina, který z trávy prostředním sloupcem skočí v tiku
 * `start + k · period` a pak skáče bez čekání, má v každé řadě kolem sebe mezeru na přeskok (silnice, koleje), nebo
 * pod dopadem střed klády (řeka).
 */
function bandLanes(rng: Rng, kind: 1 | 2 | 3, first: number, count: number, third: number): HopLane[] {
  let dir: 1 | -1 = rng.int(0, 1) === 0 ? 1 : -1;
  const ticks = HOP.hopTicks;
  const [pLow, pHigh] = kind === ROW.road ? (HOP.roadPeriod[third] as readonly [number, number]) : kind === ROW.river ? HOP.river.period : HOP.rail.period;
  const period = rng.int(pLow, pHigh);
  const start = rng.int(0, period - 1);
  const lanes: HopLane[] = [];
  for (let j = 0; j < count; j += 1) {
    // Hrdina skočí do řady j v `start + j · hopTicks`; v řadě je do konce skoku z ní, uprostřed toho dopadá.
    const landing = start + (j + 1) * ticks - 1;
    const middle = start + j * ticks + Math.floor((touchesInto(HOP.car.d) - 1 + ticks + touchesFrom(HOP.car.d)) / 2);
    const lane = (shape: Pick<HopLane, 'template' | 'w' | 'd' | 'speed'>, extra = 0): Omit<HopLane, 'phase'> => ({
      row: first + j,
      kind,
      ...shape,
      dir,
      period,
      warm: 0,
      entry: HOP_HALF + shape.w / 2 + HOP.margin + extra,
      exit: HOP_HALF + shape.w / 2 + HOP.margin,
    });
    if (kind === ROW.road) {
      const fast = rng.int(0, 999) < (HOP.fastShare[third] as number);
      const medium = !fast && rng.int(0, 999) < (HOP.mediumShare[third] as number);
      const [low, high] = fast ? HOP.speeds.fast : medium ? HOP.speeds.medium : HOP.speeds.slow;
      const truck = !fast && rng.int(0, 999) < HOP.truckShare;
      const body = truck ? HOP.truck : HOP.car;
      const base = lane({ template: truck ? HOP_BODIES.truck : HOP_BODIES.car, w: body.w, d: body.d, speed: rng.int(low, high) });
      const occupied = occupancy(body.w, base.speed);
      // Kolona: jediná mezera na přeskok (`passGap` + trochu), ostatní mezery kratší, než hrdina pruhem projde.
      const [xLow, xHigh] = HOP.passExtra[third] as readonly [number, number];
      const wide = HOP.passGap + rng.int(xLow, xHigh);
      let cars = Math.max(1, Math.round((period - wide) / (occupied + HOP.convoyGap[1] / 2)));
      while (cars > 1 && period - wide - cars * occupied < (cars - 1) * HOP.convoyGap[0]) cars -= 1;
      while (cars < HOP.carsPerRow && period - wide - cars * occupied > (cars - 1) * HOP.convoyGap[1]) cars += 1;
      // Mezery kolony ze semínka (v mezích `convoyGap`); co zbude, dostane mezera na přeskok.
      const gaps = Array.from({ length: cars }, (_, car) => (car === 0 ? wide : HOP.convoyGap[0]));
      let left = period - wide - cars * occupied - (cars - 1) * HOP.convoyGap[0];
      for (let car = 1; car < cars && left > 0; car += 1) {
        const extra = Math.min(left, rng.int(0, HOP.convoyGap[1] - HOP.convoyGap[0]));
        gaps[car] = (gaps[car] as number) + extra;
        left -= extra;
      }
      gaps[0] = (gaps[0] as number) + Math.max(0, left);
      // Auto před mezerou na přeskok minulo prostřední sloupec tak, že střed mezery připadne na střed pobytu hrdiny v řadě.
      const lead = middle - Math.round(base.entry / base.speed) - Math.floor((occupied + (gaps[0] as number)) / 2);
      let offset = 0;
      for (let car = 0; car < cars; car += 1) {
        lanes.push({ ...base, phase: mod(lead + offset, period) });
        offset += occupied + (gaps[car] as number);
      }
    } else if (kind === ROW.river) {
      const length = rng.pick(HOP.river.lengths[third] as readonly number[]);
      const [gLow, gHigh] = HOP.river.gaps[third] as readonly [number, number];
      // Rychlost, se kterou kláda a voda za ní projedou za periodu; voda nejméně `minGap`.
      const speed = Math.max(Math.ceil((length + HOP.river.minGap) / period), Math.min(HOP.river.speed[1], Math.max(HOP.river.speed[0], Math.round((length + rng.int(gLow, gHigh)) / period))));
      const base = lane({ template: HOP_BODIES.log2 + HOP.logs.indexOf(length as (typeof HOP.logs)[number]), w: length, d: HOP.log.d, speed });
      // Střed klády pod prostředním sloupcem právě v tiku dopadu.
      lanes.push({ ...base, phase: mod(landing - Math.round(base.entry / speed), period) });
    } else {
      const base = lane({ template: HOP_BODIES.train, w: HOP.train.w, d: HOP.train.d, speed: HOP.trainSpeed }, HOP.trainLead * HOP.trainSpeed);
      // Vlak projede prostředním sloupcem půl periody od pobytu hrdiny v kolejích.
      lanes.push({ ...base, phase: mod(middle - Math.round(base.entry / base.speed) - Math.floor(period / 2), period) });
    }
    dir = dir === 1 ? -1 : 1;
  }
  return lanes;
}

/** Úroveň: hrdina na startu, předlohy provozu, páska cíle a značky trávy (místa návratu). */
export function hopLevel(layout: HopLayout): ArcadeLevel {
  const last = layout.kinds.length - 1;
  const template = (role: BodyInit['role'], kind: string, w: number, h: number, d: number): BodyInit => ({ role, kind, x: 0, y: 0, z: 0, w, h, d, solid: false, kinematic: true, template: true });
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: 0, y: 0, z: 0, ...HOP.hero, solid: false },
    template('obstacle', 'obstacle', HOP.car.w, HOP.car.h, HOP.car.d),
    template('obstacle', 'truck', HOP.truck.w, HOP.truck.h, HOP.truck.d),
    ...HOP.logs.map((length) => template('platform', 'log', length, HOP.log.h, HOP.log.d)),
    template('obstacle', 'train', HOP.train.w, HOP.train.h, HOP.train.d),
    { role: 'goal', kind: 'finish', x: 0, y: 0, z: last * HOP.cell + HOP.goalAhead, w: 2 * HOP_HALF + 4 * HOP.cell, h: 100, d: 200, solid: false },
    ...grassRows(layout).map((row): BodyInit => ({ role: 'checkpoint', kind: 'marker', x: 0, y: 0, z: row * HOP.cell, w: 0, h: 0, d: 0, solid: false, template: true })),
  ];
  return { bodies, length: last * HOP.cell, spawnSlots: trafficSlots(layout.lanes) };
}

/**
 * Kolik slotů provoz naráz potřebuje: nejvíc vozidel naživu v jednom tiku do horizontu, i s těmi, která v tom tiku
 * vyjíždějí a zanikají (pravidlo vyšle dřív, než uklidí).
 */
export function trafficSlots(lanes: readonly HopLane[]): number {
  const horizon = ARCADE_LIMITS.maxTicks;
  const load = new Int32Array(horizon + 2);
  for (const lane of lanes) {
    const life = laneLife(lane);
    for (let sent = lane.phase - lane.period * Math.ceil(life / lane.period); sent <= horizon; sent += lane.period) {
      const from = Math.max(sent, lane.warm);
      const to = Math.min(sent + life, horizon);
      if (from > to) continue;
      load[from] = (load[from] as number) + 1;
      load[to + 1] = (load[to + 1] as number) - 1;
    }
  }
  let alive = 0;
  let most = 0;
  for (let tick = 0; tick <= horizon; tick += 1) {
    alive += load[tick] as number;
    most = Math.max(most, alive);
  }
  return most;
}

/** Řady trávy, kam se hrdina vrací (start i cíl). */
export const grassRows = (layout: Pick<HopLayout, 'kinds'>): number[] => layout.kinds.flatMap((kind, row) => (kind === ROW.grass ? [row] : []));

/** Střed vozidla pruhu vyslaného v tiku `sent` po kroku `tick` (vyslané stojí v tiku vyslání na vjezdu). */
export const laneX = (lane: Pick<HopLane, 'dir' | 'entry' | 'speed'>, sent: number, tick: number): number => -lane.dir * lane.entry + lane.dir * lane.speed * (tick - sent);

/** Kolik efektů `spawn` vydá pravidlo provozu v tiku `tick` (předjetí i pravidelné výjezdy). */
export function spawnsAt(lanes: readonly HopLane[], tick: number): number {
  let count = 0;
  for (const lane of lanes) {
    if (tick < lane.warm) continue;
    if (tick === lane.warm) {
      for (let sent = tick - 1 - mod(tick - 1 - lane.phase, lane.period); lane.dir * laneX(lane, sent, tick) < lane.exit; sent -= lane.period) count += 1;
    }
    if (mod(tick - lane.phase, lane.period) === 0) count += 1;
  }
  return count;
}

/** Je sloupec `x` řady pruhu po kroku `tick` volný od vozidel pruhu i s rezervou robota? */
export function laneClear(lane: HopLane, x: number, tick: number): boolean {
  const reach = (lane.w + HOP.hero.w) / 2 + lane.speed * HOP_BOT_MARGIN;
  // Poslední vyslané do `tick` a pár předchozích; dál už jsou za výjezdem.
  for (let sent = tick - mod(tick - lane.phase, lane.period), n = 0; n < laneSlots(lane); sent -= lane.period, n += 1) {
    if (Math.abs(laneX(lane, sent, tick) - x) < reach) return false;
  }
  return true;
}

/** Leží v pruhu řeky po kroku `tick` pod `x` kláda (aspoň `inset` od jejího konce)? */
export function logBelow(lane: HopLane, x: number, tick: number, inset = 0): boolean {
  for (let sent = tick - mod(tick - lane.phase, lane.period), n = 0; n < laneSlots(lane); sent -= lane.period, n += 1) {
    if (sent === tick) continue;
    if (Math.abs(laneX(lane, sent, tick) - x) * 2 < lane.w - 2 * inset) return true;
  }
  return false;
}

/** Kroky skoku (1..`hopTicks`), ve kterých hrdina ještě zasahuje do řady, ze které skáče, a už do té, kam skáče. */
export const touchesFrom = (d: number): number => Math.floor((HOP.hero.d + d - 1) / (2 * HOP_STEP));
export const touchesInto = (d: number): number => HOP.hopTicks - touchesFrom(d);

/** Přechod, který nedojde. */
export const NEVER = 1 << 30;

/**
 * Jak dlouho trvá přechod pásu hrdinovi, který z trávy před ním ve sloupci `x` skočí v tiku `from + i`
 * (`i < length`), na trávu za ním; `NEVER` = nedojde. Skoky vpřed tím sloupcem, čekání jen na silnici a kolejích
 * (ne na kládě), s rezervou robota kolem vozidel a dopadem na kládu aspoň `HOP_LOG_INSET` od jejího konce.
 * Zpětný průchod po ticích přes řady pásu počítá nejdřívější příchod; přechod delší než `HOP.longestCross` nehledá.
 */
export function bandCrossings(band: readonly HopLane[], x: number, from: number, length: number): Int32Array {
  // Řady pásu odspodu; řada silnice má víc pod-pruhů (kolona), každá řada jeden druh a hloubku vozidel.
  const rowsOf = [...new Set(band.map((lane) => lane.row))].sort((a, b) => a - b);
  const groups = rowsOf.map((row) => band.filter((lane) => lane.row === row));
  const lanes = groups.map((group) => group[0] as HopLane);
  const count = lanes.length;
  const ticks = HOP.hopTicks;
  const never = NEVER;
  // Za posledním startem ještě celý nejdelší přechod.
  const span = length + HOP.longestCross + 2 * ticks;
  // ok[j][i]: řada pásu j po kroku `from + i` – volná (silnice, koleje), nebo kláda pod dopadem (řeka).
  const ok = groups.map((group) => {
    const row = new Uint8Array(span + ticks);
    const river = (group[0] as HopLane).kind === ROW.river;
    for (let i = 0; i < row.length; i += 1) row[i] = (river ? group.some((lane) => logBelow(lane, x, from + i, HOP_LOG_INSET)) : group.every((lane) => laneClear(lane, x, from + i))) ? 1 : 0;
    return row;
  });
  // arrive[level][i]: nejdřívější krok příchodu na trávu za pásem z úrovně (1..count pruhy) v kroku i; `never` = nedojde.
  let next = new Int32Array(span + ticks + 1).map((_, i) => i);
  const crossings = new Int32Array(length).fill(never);
  for (let level = count; level >= 0; level -= 1) {
    const here = new Int32Array(span + ticks + 1).fill(never);
    const leave = level === 0 ? null : (lanes[level - 1] as HopLane);
    const into = level === count ? null : (lanes[level] as HopLane);
    const leaveOk = level === 0 ? null : (ok[level - 1] as Uint8Array);
    const intoOk = level === count ? null : (ok[level] as Uint8Array);
    const leaveTill = leave === null || leave.kind === ROW.river ? 0 : touchesFrom(leave.d);
    const intoFrom = into === null || into.kind === ROW.river ? ticks + 1 : touchesInto(into.d);
    for (let i = span - 1; i >= 0; i -= 1) {
      let hop = next[i + ticks] as number;
      for (let k = 1; k <= ticks && hop < never; k += 1) {
        if ((k <= leaveTill && leaveOk?.[i + k - 1] !== 1) || (k >= intoFrom && intoOk?.[i + k - 1] !== 1)) hop = never;
      }
      if (into !== null && into.kind === ROW.river && intoOk?.[i + ticks - 1] !== 1) hop = never;
      if (level === 0) {
        // Start z trávy: jen skok.
        if (i < length && hop < never && hop - i <= HOP.longestCross) crossings[i] = hop - i;
        continue;
      }
      const wait = (leave as HopLane).kind !== ROW.river && leaveOk?.[i] === 1 ? (here[i + 1] as number) : never;
      here[i] = Math.min(hop, wait);
    }
    next = here;
  }
  return crossings;
}

/**
 * Nejdelší čekání na trávě před pásem (tiky): robot drží střed pole, takže vyráží prostředním sloupcem (ze sousedního,
 * kam ho před orlem odnesl krok stranou, o skok později – na to má `HOP.longestWait` rezervu pod orlem). Provoz pásu se
 * opakuje po jeho periodě, takže stačí nejdelší mezera mezi starty dokola jedné periody po předjetí. Bez startu `Infinity`.
 */
export function bandWait(lanes: readonly HopLane[]): number {
  const period = (lanes[0] as HopLane).period;
  const middle = bandCrossings(lanes, 0, HOP.startGrass * HOP.hopTicks, period);
  const good = (i: number): boolean => (middle[i % period] as number) <= HOP.longestCross;
  let first = 0;
  while (first < period && !good(first)) first += 1;
  if (first === period) return Infinity;
  let worst = 0;
  let last = first;
  for (let i = first + 1; i <= first + period; i += 1) {
    if (!good(i)) continue;
    worst = Math.max(worst, i - last - 1);
    last = i;
  }
  return worst;
}

/**
 * Kdy dojde na cíl robot světa (odhad délky hry v ticích): skáče prostředním sloupcem, po trávě rovnou, a před každým
 * pásem čeká na nejbližší přechod z `bandCrossings` (robot drží střed pole, takže jde právě tudy).
 */
export function predictedTicks(layout: HopLayout): number {
  const ticks = HOP.hopTicks;
  const from = HOP.startGrass * ticks;
  const last = layout.kinds.length - 1;
  const bands = new Map(layout.bands.map((band) => [band.first, band]));
  let tick = 0;
  let row = 0;
  while (row < last) {
    const band = bands.get(row + 1);
    if (band === undefined) {
      tick += ticks;
      row += 1;
      continue;
    }
    const lanes = bandLanesOf(layout, band);
    const period = (lanes[0] as HopLane).period;
    const crossings = bandCrossings(lanes, 0, from, period);
    let wait = 0;
    while (wait < period && (crossings[mod(tick + wait - from, period)] as number) > HOP.longestCross) wait += 1;
    if (wait === period) return Infinity;
    tick += wait + (crossings[mod(tick + wait - from, period)] as number);
    row = band.first + band.count;
  }
  return tick;
}

/**
 * Tvrzení „hratelné z konstrukce“ nad rozvržením; prázdné pole = hratelná. Každým pásem jde projít nejpozději
 * `HOP.longestWait` tiků po příchodu (kratší než orel), provoz se vejde do slotů a efektů za tik a předjetí robot
 * uvidí dřív, než k první silnici doskáče.
 */
export function checkHopLevel(level: ArcadeLevel, layout: HopLayout, params: HopParams): string[] {
  const issues: string[] = [];
  const last = layout.kinds.length - 1;
  if (last !== params.rows) issues.push(`the course has ${last} rows, the goal asks for ${params.rows}`);
  for (let row = 0; row < Math.min(HOP.startGrass, last); row += 1) if (layout.kinds[row] !== ROW.grass) issues.push(`row ${row} is not grass: the bot would meet traffic it cannot see yet`);
  if (layout.kinds[last] !== ROW.grass) issues.push('the goal row is not grass');
  for (const lane of layout.lanes) {
    if (layout.kinds[lane.row] !== lane.kind) issues.push(`row ${lane.row} has a lane of another kind`);
    if (lane.warm + HOP_BOT_REACTION + 1 > (HOP.startGrass - 1) * HOP.hopTicks) issues.push(`the lane in row ${lane.row} is pre-rolled too late for the bot to see it`);
  }
  for (let row = 1; row < last; row += 1) if (layout.kinds[row] !== ROW.grass && !layout.lanes.some((lane) => lane.row === row)) issues.push(`row ${row} has no traffic`);
  if (HOP.longestWait >= HOP.eagle - 2 * HOP.hopTicks) issues.push('the longest wait before a band reaches the eagle');
  for (const band of layout.bands) {
    if (band.first < 1 || layout.kinds[band.first - 1] !== ROW.grass) issues.push(`the band at row ${band.first} has no grass before it`);
    const wait = bandWait(bandLanesOf(layout, band));
    if (wait > HOP.longestWait) issues.push(`the band at row ${band.first} can keep the bot waiting ${wait} ticks`);
  }
  let effects = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks; tick += 1) effects = Math.max(effects, spawnsAt(layout.lanes, tick));
  // Efekty provozu + řada, skóre, kombo, místo návratu, náraz a návrat.
  if (effects + 8 > ARCADE_LIMITS.maxEffectsPerTick) issues.push(`${effects} vehicles start in one tick, over the effect limit`);
  // +1 = počítadlo komba, které svět přidá za tělesa úrovně.
  if (level.bodies.length + (level.spawnSlots ?? 0) + 1 > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length + (level.spawnSlots ?? 0)} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
