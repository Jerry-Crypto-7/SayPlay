/**
 * Krájení (P54C T8): věci vylétají zespodu pěti pruhů (`lanes.ts`) po obloucích a hrdina je švihem rozsekne.
 *
 * Každou věc vyhodí pravidlo `slice_cut` v tiku rozpisu ze semínka (efekt `spawn` z předlohy ovoce
 * nebo bomby) ze země svisle vzhůru; dál ji nese gravitace jádra (`GRAVITY`, celá čísla), takže její
 * výška v každém kroku je spočitatelná dopředu (`heightAfter`, jako `ballFlight`) a Rapier ji nehýbe.
 * Švih = ťuk v pruhu z osy: rozsekne všechny věci toho pruhu, které jsou právě ve výšce řezu
 * (`SLICE.cutY` a výš). Ovoce dá body a čítač `items`, víc ovoce jedním švihem zvedne kombo o stupeň
 * za každý kus navíc (×2, ×3 ze studeného začátku); bomba ve švihu vezme život. Ovoce, které dopadne
 * zpátky na zem, shodí kombo; prvních `free` propadlých je bez trestu, každé další stojí život.
 * Výhra = rozseknout `items` kusů ovoce (`catch_goal`), prohra = životy došly.
 *
 * Hra jde po třetinách cíle: hrsti chodí hustěji, létají níž (kratší okno ve výšce řezu) a jsou
 * větší (po dvou a po třech v jednom pruhu – jeden švih je rozsekne všechny). Bomby létají vedle
 * ovoce (návnada v jiném pruhu v témže tiku) a za ním (past: týmž pruhem o `trapLead` tiků později –
 * kdo švihne pozdě, rozsekne s ovocem i bombu). Kdo švihá do všech pruhů, rozsekne všechny bomby.
 *
 * **Hratelné z konstrukce** (`checkSliceLevel`): robot světa (`slice-bot.ts`, reakce
 * `SLICE_BOT_REACTION`) každou bombu uvidí dřív, než doletí do výšky řezu, a každou hrst stihne
 * rozseknout, dokud v jejím pruhu bomba není (rozvrh EDF, jeden švih za tik). Ovoce je
 * `items + free + životy − 1`: kdo ho všechno nerozsekne, prohraje nejpozději posledním.
 * Nečinný hráč nešvihne nikdy, takže nic nerozsekne a prohraje po `free + životy` propadlých kusech.
 *
 * **Události (P55 T5, `lane-events.ts`):** do mezer mezi hrstmi vylétají bonusy – série, zlatý cíl a spěch –
 * z vlastního streamu; hrsti a bomby letí přesně tam a tehdy, kdy bez nich. Bonus je kopie vlastní předlohy
 * se značkou v HP (`EVENT_MARK`): rozseknutý dá body (zlatý ×`goldenPoints`) a kombo, do cíle se nepočítá
 * a propadlý nic nestojí. Bonus přibude, jen když s ním robot pořád stihne všechny hrsti (`firstUncut`).
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  type BodyInit,
  COMBO,
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
} from '../contract';
import { GRAVITY } from '../kernel';
import { EVENT_MARK, LANE_EVENTS, laneEventCursor, laneEventRng, planLaneEvents, stepLane } from './lane-events';
import { LANES, LANE_START, laneOfX, laneX, tappedIn } from './lanes';
import { nextMultiplier } from './rules';

export const SLICE = {
  hero: { w: 1200, h: 1600, d: 1000 },
  thing: { w: 700, h: 700, d: 700 },
  /** Rovina letu (z): kousek za hrdinou, jeho tělo se věcí nedotkne. */
  z: 1500,
  /** Výška řezu: švih rozsekne věc, jejíž spodek je aspoň tady (j nad zemí). */
  cutY: 3000,
  /** Odstup kusů jedné hrsti v pruhu (x od středu); všechny zůstanou v témže pruhu (`laneOfX`). */
  spread: 600,
  /** Rychlost výhozu (j/tik) po třetinách cíle, los v mezích: okno ve výšce řezu ~43–51, ~33–41 a ~25–32 tiků. */
  speeds: [
    [284, 304],
    [260, 276],
    [244, 256],
  ],
  /** Rychlost hrsti s pastí: rychlá, do výšky řezu doletí za 12–13 tiků od výhozu. */
  trapSpeed: [296, 310],
  /** Bomba pasti vyletí tolik tiků po své hrsti (los v mezích). */
  trapLead: [6, 10],
  /** Rozestup hrstí po třetinách (tiky), před natažením pro malý cíl. */
  gaps: [
    [140, 175],
    [115, 140],
    [90, 112],
  ],
  /** Kolik hrstí (‰) je po dvou a kolik po třech, po třetinách. */
  pairs: [250, 350, 400],
  triples: [50, 150, 250],
  /**
   * Kolik hrstí (‰) má past, po třetinách. Past drží pásmo začátečníka: kdo hrst uvidí o 20 tiků po výhozu
   * (reakce začátečníka), švihne, až je bomba ve výšce řezu. Ladění 20. 10. (semínka 1–20 / 1–60, začátečník;
   * intermediate a robot světa 1,0 ve všech): 120/160/200 → 0,70; 110/170/220 → 0,65 / 0,58; 120/180/230 → 0,50 / 0,48;
   * 130/190/240 → 0,40 / 0,43; 150/220/280 → 0,35 / 0,38.
   */
  traps: [120, 180, 230],
  /** Kolik hrstí bez pasti (‰) má v témž tiku bombu v jiném pruhu, po třetinách. */
  decoys: [250, 400, 500],
  /** Nejvíc hrstí za sebou bez bomby; další ji dostane vždy (kdo švihá do všeho, prohraje). */
  plainRun: 3,
  /** První hrst vyletí v tomhle tiku. */
  firstLaunch: 40,
  /**
   * Propadlé ovoce bez trestu; každé další stojí život.
   */
  free: 3,
  points: 10,
  items: { min: 10, max: 50, default: 30 },
  /** Cíl, pod kterým se rozestupy natahují, ať hra trvá aspoň půl minuty. */
  pacedItems: 30,
  /** Volné sloty pro věci ve vzduchu. */
  spawnSlots: 16,
  /** Rezerva robota před koncem bezpečného okna (tiky). */
  margin: 2,
} as const;

/** Reakce robota světa – kontrola hratelnosti s ní počítá. */
export const SLICE_BOT_REACTION = 8;

/** Indexy těl úrovně: hrdina 0, předloha ovoce 1, předloha bomby 2, předlohy bonusů 3–5 v pořadí `EVENT_MARK` (série, spěch, zlatý). */
export const SLICE_BODIES = { fruit: 1, bomb: 2, bonus: 3 } as const;

/** Rozestup bonusů série a spěchu (tiky): rychle za sebou, každý na vlastní švih. */
const BONUS_GAP = [14, 20] as const;
/** Zlatý cíl letí nízko: ve výšce řezu jen ~19 tiků (kratší okno než ovoce). */
const GOLDEN_SPEED = 236;
/** Zlatý cíl vyletí tolik tiků po hrsti (los v mezích). */
const GOLDEN_LEAD = [24, 36] as const;

/** Je bonus události (P55 T5) v obraze? Věc je vidět od výhozu, dokud žije a neleží na zemi. */
export const sliceInView = (state: Int32Array, body: number): boolean => {
  const flags = state[bodyBase(body) + BODY.flags] as number;
  return (flags & FLAG.alive) !== 0 && (flags & FLAG.grounded) === 0 && bodyHp(state, body) > 0;
};

const SALT = 0x51ce;

/** Výška věci vyhozené rychlostí `speed` po `steps` krocích jádra (gravitace jádra, celá čísla). */
export const heightAfter = (speed: number, steps: number): number => steps * speed - (GRAVITY * steps * (steps + 1)) / 2;

/**
 * Výška v kroku tiku `at` u věci, kterou stav z tiku `seenAt` (stav po kroku `seenAt − 1`) ukazuje ve výšce `y`
 * s rychlostí `vy`; dokud nedopadne. Robot a sonda tak vidí, kde věc bude, když jejich švih dopadne.
 */
export function heightAt(y: number, vy: number, seenAt: number, at: number): number {
  const steps = at - seenAt + 1;
  return y + steps * vy - (GRAVITY * steps * (steps + 1)) / 2;
}

/** Krok po výhozu, ve kterém věc dopadne zpátky na zem (jádro ji usadí a pravidlo ji odebere). */
export function landingStep(speed: number): number {
  let step = 1;
  while (heightAfter(speed, step) > 0) step += 1;
  return step;
}

/** Kroky po výhozu, ve kterých je věc ve výšce řezu (první a poslední); `null`, když tam nedoletí. */
export function cutWindow(speed: number): readonly [number, number] | null {
  let first = -1;
  let last = -1;
  for (let step = 1; heightAfter(speed, step) > 0; step += 1) {
    if (heightAfter(speed, step) < SLICE.cutY) continue;
    if (first < 0) first = step;
    last = step;
  }
  return first < 0 ? null : [first, last];
}

/** Jedna věc rozpisu: tik výhozu, x (pruh a místo v něm), rychlost, bomba a hrst, ke které patří. */
export interface Throw {
  readonly tick: number;
  readonly x: number;
  readonly speed: number;
  readonly bomb: boolean;
  /** Pořadí hrsti; bomba nese hrst, se kterou vyletěla nebo za kterou jde. */
  readonly group: number;
  /** Bomba pasti: týmž pruhem jako její hrst, o chvíli později. */
  readonly trap: boolean;
  /** Bonus události (`EVENT_MARK`): body a kombo, do cíle se nepočítá a propadnout smí; 0 = ovoce nebo bomba. */
  readonly mark: number;
}

export const sliceParams = z
  .object({
    /** Kolik kusů ovoce rozseknout (`COUNT_PARAMS.slice.default.collectible`). */
    items: z.int().min(SLICE.items.min).max(SLICE.items.max).default(SLICE.items.default),
  })
  .strict();
export type SliceParams = z.infer<typeof sliceParams>;

/** Natažení rozestupů (‰): cíl pod `pacedItems` dostane delší mezery, ať hra nekončí za pár vteřin. */
const stretchOf = (items: number): number => Math.max(1000, Math.round((SLICE.pacedItems * 1000) / items));

/** Třetina cíle, do které patří kus ovoce `index` (ovoce za cílem je ve třetí). */
const thirdOf = (index: number, items: number): number => Math.min(2, Math.floor((3 * index) / items));

/** Místa kusů hrsti v pruhu (x od středu). */
const OFFSETS: Readonly<Record<number, readonly number[]>> = { 1: [0], 2: [-SLICE.spread / 2, SLICE.spread / 2], 3: [-SLICE.spread, 0, SLICE.spread] };

/**
 * Rozpis ze semínka v pořadí výhozu: hrsti ovoce (pruh vždy jiný než předchozí hrsti), u některých
 * past (bomba týmž pruhem o `trapLead` později) nebo návnada (bomba v jiném pruhu v témže tiku).
 * Nejvýš `plainRun` hrstí za sebou je bez bomby. Do mezer mezi hrstmi přibudou bonusy událostí (`withLaneEvents`).
 */
export function sliceThrows(seed: number, params: SliceParams, lives: number): Throw[] {
  return withLaneEvents(seed, layThrows(seed, params, lives));
}

/** Hrsti a bomby ze streamu rozvržení – s událostmi i bez nich tytéž. */
function layThrows(seed: number, params: SliceParams, lives: number): Throw[] {
  const rng = createCompileRng(seed ^ SALT);
  const total = params.items + SLICE.free + lives - 1;
  const stretch = stretchOf(params.items);
  const throws: Throw[] = [];
  const lanes = Array.from({ length: LANES.count }, (_, lane) => lane);
  let tick: number = SLICE.firstLaunch;
  let lane = -1;
  let plain = 0;
  let fruit = 0;
  for (let group = 0; fruit < total; group += 1) {
    const third = thirdOf(fruit, params.items);
    if (group > 0) {
      const [low, high] = SLICE.gaps[third] as readonly [number, number];
      tick += Math.round((rng.int(low, high) * stretch) / 1000);
    }
    const draw = rng.int(0, 999);
    const size = Math.min(total - fruit, draw < (SLICE.triples[third] as number) ? 3 : draw < (SLICE.triples[third] as number) + (SLICE.pairs[third] as number) ? 2 : 1);
    lane = rng.pick(lanes.filter((candidate) => candidate !== lane));
    const trap = group > 0 && rng.int(0, 999) < (SLICE.traps[third] as number);
    const [slow, fast] = trap ? SLICE.trapSpeed : (SLICE.speeds[third] as readonly [number, number]);
    const speed = rng.int(slow, fast);
    for (const offset of OFFSETS[size] as readonly number[]) throws.push({ tick, x: laneX(lane) + offset, speed, bomb: false, group, trap: false, mark: 0 });
    if (trap) {
      // Bomba jde po stejném oblouku o kus vedle, ať je za ovocem vidět.
      const side = rng.int(0, 1) === 0 ? -1 : 1;
      throws.push({ tick: tick + rng.int(SLICE.trapLead[0], SLICE.trapLead[1]), x: laneX(lane) + (side * SLICE.spread) / 2, speed, bomb: true, group, trap: true, mark: 0 });
    }
    const decoy = !trap && group > 0 && (rng.int(0, 999) < (SLICE.decoys[third] as number) || plain >= SLICE.plainRun);
    if (decoy) {
      const [low, high] = SLICE.speeds[third] as readonly [number, number];
      throws.push({ tick, x: laneX(rng.pick(lanes.filter((candidate) => candidate !== lane))), speed: rng.int(low, high), bomb: true, group, trap: false, mark: 0 });
    }
    plain = trap || decoy ? 0 : plain + 1;
    fruit += size;
  }
  return throws.sort((a, b) => a.tick - b.tick);
}

/**
 * Bonusy událostí (P55 T5) do mezer mezi hrstmi: série vede od pruhu hrsti ke vzdálenému kraji, zlatý cíl
 * letí dva pruhy stranou a nízko, ve spěchu přibudou do každé mezery dva. Los jde z `laneEventRng` (pořadí
 * tahů nezávisí na tom, co se vešlo), hrsti a bomby se nepohnou. Bonus vyletí před další hrstí a přibude,
 * jen když s ním robot pořád stihne všechno ovoce (`firstUncut` počítá i bonusy); jinak se vynechá.
 */
function withLaneEvents(seed: number, plain: readonly Throw[]): Throw[] {
  const starts = new Map<number, Throw>();
  for (const item of plain) if (!item.bomb && !starts.has(item.group)) starts.set(item.group, item);
  const heads = [...starts.values()].sort((a, b) => a.group - b.group);
  const last = heads.at(-1);
  if (last === undefined) return [...plain];
  const cursor = laneEventCursor(planLaneEvents(seed, last.tick));
  const rng = laneEventRng(seed);
  let out = [...plain];
  let bonuses = 0;
  // Série nebo zlatý cíl, ze kterého se do mezery nevešlo nic, zkusí další mezeru (událost nepropadne).
  let held: ReturnType<typeof cursor.take> = null;
  heads.slice(0, -1).forEach((head, index) => {
    const next = (heads[index + 1] as Throw).tick;
    let at = head.tick;
    let lane = laneOfX(head.x);
    const put = (mark: number, gap: number, to: number, speed: number): void => {
      const when = at + gap;
      if (when >= next) return;
      const bonus: Throw = { tick: when, x: laneX(to), speed, bomb: false, group: -1 - bonuses, trap: false, mark };
      const tried = [...out, bonus].sort((a, b) => a.tick - b.tick);
      if (firstUncut(tried) !== null) return;
      out = tried;
      bonuses += 1;
      at = when;
      lane = to;
    };
    const away = lane >= 2 ? 0 : LANES.count - 1;
    const event = held ?? cursor.take(head.tick);
    const before = bonuses;
    if (event?.kind === 'series') {
      for (let n = rng.int(...LANE_EVENTS.series); n > 0; n -= 1) put(EVENT_MARK.series, rng.int(...BONUS_GAP), stepLane(lane, away, LANES.count, rng), head.speed);
    } else if (event?.kind === 'golden') {
      put(EVENT_MARK.golden, rng.int(...GOLDEN_LEAD), stepLane(stepLane(lane, away, LANES.count, rng), away, LANES.count, rng), GOLDEN_SPEED);
    } else if (cursor.inRush(head.tick)) {
      for (let n = 2; n > 0; n -= 1) put(EVENT_MARK.rush, rng.int(...BONUS_GAP), stepLane(lane, away, LANES.count, rng), head.speed);
    }
    held = event !== null && bonuses === before ? event : null;
  });
  return out;
}

/** Úroveň krájení: hrdina ve startovním pruhu a předlohy ovoce, bomby a bonusů (věci vyhazuje pravidlo). */
export function sliceLevel(): ArcadeLevel {
  const thing = { y: 0, z: SLICE.z, ...SLICE.thing, solid: false, gravity: true, template: true } as const;
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: laneX(LANE_START), y: 0, z: 0, ...SLICE.hero, solid: false },
    { role: 'collectible', kind: 'coin', x: 0, ...thing },
    { role: 'hazard', kind: 'snag', x: 0, ...thing },
    // Předlohy bonusů: značka v HP se kopií výhozu přenese (`spawn` kopíruje příznaky).
    ...[EVENT_MARK.series, EVENT_MARK.rush, EVENT_MARK.golden].map((hp): BodyInit => ({ role: 'collectible', kind: 'coin', x: 0, ...thing, hp })),
  ];
  return { bodies, length: 0, spawnSlots: SLICE.spawnSlots };
}

/** Výhozy pro pravidlo: `[tik, x, rychlost, druh]` – druh 0 ovoce, 1 bomba, 1 + `EVENT_MARK` bonus. */
export type Launch = readonly [tick: number, x: number, speed: number, kind: number];

const kindOf = (item: Throw): number => (item.bomb ? 1 : item.mark > 0 ? 1 + item.mark : 0);

export const launchesOf = (throws: readonly Throw[]): Launch[] => throws.map((item) => [item.tick, item.x, item.speed, kindOf(item)]);

/** Rozpis zpět z výhozů pravidla (hrst se z výhozů nepozná). */
export const throwsOf = (launches: readonly Launch[]): Throw[] => launches.map(([tick, x, speed, kind]) => ({ tick, x, speed, bomb: kind === 1, group: -1, trap: false, mark: kind > 1 ? kind - 1 : 0 }));

/** Tiky (absolutní), ve kterých je věc ve výšce řezu, nebo `null`. */
const windowOf = (item: Pick<Throw, 'tick' | 'speed'>): readonly [number, number] | null => {
  const steps = cutWindow(item.speed);
  return steps === null ? null : [item.tick + steps[0], item.tick + steps[1]];
};

/**
 * Stihne robot všechny hrsti? Hrst (ovoce týmž pruhem v témže tiku) jde rozseknout od tiku, kdy ji robot
 * vidí a je ve výšce řezu, do posledního tiku před tím, než do výšky řezu v jejím pruhu vletí bomba
 * (nebo než sama klesne), bez `margin`. Švihy jednotkové délky rozvrhuje EDF. Vrací popis první hrsti,
 * kterou by nestihl, nebo `null`.
 */
export function firstUncut(throws: readonly Throw[], reaction = SLICE_BOT_REACTION): string | null {
  const bombs = throws.filter((item) => item.bomb).map((item) => ({ lane: laneOfX(item.x), window: windowOf(item) }));
  const groups = new Map<string, Pick<Throw, 'tick' | 'speed'> & { readonly lane: number }>();
  for (const item of throws) if (!item.bomb) groups.set(`${item.tick}:${laneOfX(item.x)}:${item.speed}`, { tick: item.tick, speed: item.speed, lane: laneOfX(item.x) });
  const jobs: { release: number; deadline: number; label: string }[] = [];
  for (const group of groups.values()) {
    const window = windowOf(group);
    if (window === null) return `the fruit thrown at tick ${group.tick} never reaches the cut height`;
    const release = Math.max(window[0], group.tick + reaction + 1);
    let end = window[1];
    for (const bomb of bombs) {
      if (bomb.lane !== group.lane || bomb.window === null || bomb.window[1] < release || bomb.window[0] > end) continue;
      end = Math.min(end, bomb.window[0] - 1);
    }
    jobs.push({ release, deadline: end - SLICE.margin, label: `the fruit thrown at tick ${group.tick} in lane ${group.lane}` });
  }
  jobs.sort((a, b) => a.release - b.release || a.deadline - b.deadline);
  const ready: typeof jobs = [];
  let next = 0;
  let tick = 0;
  while (next < jobs.length || ready.length > 0) {
    if (ready.length === 0) tick = Math.max(tick, (jobs[next] as (typeof jobs)[number]).release);
    while (next < jobs.length && (jobs[next] as (typeof jobs)[number]).release <= tick) ready.push(jobs[next++] as (typeof jobs)[number]);
    ready.sort((a, b) => a.deadline - b.deadline);
    const job = ready.shift() as (typeof jobs)[number];
    if (tick > job.deadline) return job.label;
    tick += 1;
  }
  return null;
}

/** Tvrzení „hratelné z konstrukce“ nad rozpisem; prázdné pole = hratelná. */
export function checkSliceLevel(level: ArcadeLevel, throws: readonly Throw[], params: SliceParams, lives: number): string[] {
  const issues: string[] = [];
  // Bonusy událostí se do cíle nepočítají; robot je ale stíhá taky, takže dosažitelnost (`firstUncut`) je počítá.
  const fruit = throws.filter((item) => !item.bomb && item.mark === 0);
  const need = params.items + SLICE.free + lives - 1;
  if (fruit.length < need) issues.push(`only ${fruit.length} pieces of fruit fly – slicing ${params.items} needs ${need}`);
  throws.forEach((item, index) => {
    const lane = laneOfX(item.x);
    if (!Number.isInteger(item.tick) || item.tick < 1 || (index > 0 && item.tick < (throws[index - 1] as Throw).tick)) issues.push(`throw ${index + 1} is not on a whole tick after the one before`);
    if (Math.abs(item.x - laneX(lane)) * 2 >= LANES.width) issues.push(`throw ${index + 1} flies between two lanes`);
    const window = cutWindow(item.speed);
    // Robot (reakce `reaction`) musí každou věc uvidět aspoň dva tiky předtím, než doletí do výšky řezu.
    if (window === null || window[0] < SLICE_BOT_REACTION + 1 + SLICE.margin) issues.push(`throw ${index + 1} reaches the cut height before the bot can see it`);
  });
  const uncut = firstUncut(throws);
  if (uncut !== null) issues.push(`${uncut} cannot be sliced before a bomb flies into its lane`);
  const lands = fruit.map((item) => item.tick + landingStep(item.speed));
  if (Math.max(0, ...lands) >= ARCADE_LIMITS.maxTicks) issues.push('the last fruit lands past the 90 s horizon');
  // Ve vzduchu naráz nejvýš tolik věcí, kolik má svět volných slotů (počítáno pro nečinného hráče: nic nezmizí dřív než na zemi).
  const airborne = Math.max(0, ...throws.map((item) => throws.filter((other) => other.tick <= item.tick && other.tick + landingStep(other.speed) >= item.tick).length));
  if (airborne > (level.spawnSlots ?? 0)) issues.push(`${airborne} things fly at once, the world has ${level.spawnSlots ?? 0} slots`);
  if (level.bodies.length + (level.spawnSlots ?? 0) + 1 > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Díly světa: ovládání pruhů, robot, úroveň a pravidla krájení. Bez životů ze specu hraje se třemi. */
export function sliceParts(seed: number, params: SliceParams, health: number | undefined): ModeParts {
  const lives = health ?? START_LIVES;
  const level = sliceLevel();
  const throws = sliceThrows(seed, params, lives);
  return {
    control: { id: 'lanes', params: {} },
    bot: { id: 'slice_bot', params: {} },
    level,
    rules: [
      { id: 'slice_cut', params: { fruit: SLICE_BODIES.fruit, bomb: SLICE_BODIES.bomb, bonus: SLICE_BODIES.bonus, launches: launchesOf(throws), free: SLICE.free, points: SLICE.points } },
      // Cíl „rozseknuto N“ je týž čítač jako u chytání (`items`), pravidlo cíle sdílí.
      { id: 'catch_goal', params: { need: params.items } },
      { id: 'out_of_health', params: {} },
      // Pilulka postupu HUD (`collectNeed`, kit `08-game-hud.md`) čte cíl z `finish_collected`; tělo cíle svět nemá, takže nevystřelí.
      { id: 'finish_collected', params: { need: params.items } },
    ],
    issues: checkSliceLevel(level, throws, params, lives),
    health: lives,
  };
}

export const sliceArcs: ModeGeneratorPiece<SliceParams> = {
  id: 'slice_arcs',
  params: sliceParams,
  roles: ['player', 'collectible', 'hazard'],
  cost: () => ({ bodies: 6 + SLICE.spawnSlots, rules: 4 }),
  generate: () => sliceLevel(),
  parts: sliceParts,
};

// ---------------------------------------------------------------------------
// Pravidlo

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);

const cutParams = z
  .object({
    /** Předloha ovoce a bomby. */
    fruit: index,
    bomb: index,
    /** První ze tří předloh bonusů (série, spěch, zlatý – pořadí `EVENT_MARK`); bez ní svět bonusy nemá. */
    bonus: index.optional(),
    /** Výhozy seřazené podle tiku: `[tik, x, rychlost, druh]` – 0 ovoce, 1 bomba, 1 + `EVENT_MARK` bonus. */
    launches: z
      .array(z.tuple([z.int().min(0).max(ARCADE_LIMITS.maxTicks), z.int().min(-LANES.count * LANES.width).max(LANES.count * LANES.width), z.int().min(1).max(1000), z.int().min(0).max(1 + EVENT_MARK.golden)]))
      .max(ARCADE_LIMITS.maxBodies),
    /** Propadlé ovoce bez trestu. */
    free: z.int().min(0).max(9),
    points: z.int().min(1).max(100),
    /** Počítadlo komba (P46C T3, `withCombo`); bez něj kombo jen z kusů jednoho švihu. */
    combo: index.optional(),
  })
  .strict();

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Kolik ovoce už propadlo: vyhozené před tímhle tikem, které není rozseknuté ani ve vzduchu. */
function droppedSoFar(state: Int32Array, launches: readonly Launch[]): number {
  const tick = state[HEADER.tick] as number;
  let thrown = 0;
  for (const [at, , , kind] of launches) {
    if (at >= tick) break;
    if (kind === 0) thrown += 1;
  }
  let flying = 0;
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    if (alive(state, body) && state[bodyBase(body) + BODY.role] === ROLE.collectible && bodyHp(state, body) === 0) flying += 1;
  }
  return thrown - (state[HEADER.counters + COUNTER.items] as number) - flying;
}

/**
 * Násobič série: propadlé ovoce zapíše do počítadla komba násobič 0 a série začne znovu od ×1;
 * jinak jako sebrání (`nextMultiplier` – v okně komba a bez ztráty života o stupeň výš).
 */
const sliceChain = (state: Int32Array, keeper: number): number => ((state[bodyBase(keeper) + BODY.aux0] as number) === 0 ? 1 : nextMultiplier(state, keeper));

/**
 * Krájení (tik): vyhodí věci rozpisu, odebere věci, které dopadly (propadlé ovoce shodí kombo a nad kvótu
 * vezme život), a švih rozsekne všechno v pruhu ťuku ve výšce řezu – ovoce dá body × kombo a čítač `items`
 * (každý kus navíc v témže švihu kombo o stupeň zvedne), bomba vezme život.
 */
export const sliceCutRule: RulePiece<z.infer<typeof cutParams>> = {
  id: 'slice_cut',
  params: cutParams,
  roles: ['player', 'collectible', 'hazard'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const effects: ArcadeEffect[] = [];
    const tick = state[HEADER.tick] as number;
    // Výhozy první: nová věc vezme slot mrtvý už před tímhle tikem, ne ten, který se uvolní teď (scéna je nezamění).
    for (const [at, x, speed, kind] of params.launches) {
      if (at > tick) break;
      if (at !== tick) continue;
      // Svět bez předloh bonusů (ruční, starší) bonusy vynechá.
      const template = kind === 0 ? params.fruit : kind === 1 ? params.bomb : params.bonus === undefined ? -1 : params.bonus + kind - 2;
      if (template >= 0) effects.push({ kind: 'spawn', template, x, y: 0, z: SLICE.z, vx: 0, vy: speed, vz: 0 });
    }
    const tap = tappedIn(state, player);
    const sliced: number[] = [];
    let dropped = -1;
    for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
      if (!alive(state, body)) continue;
      const base = bodyBase(body);
      const role = state[base + BODY.role] as number;
      if (role !== ROLE.collectible && role !== ROLE.hazard) continue;
      if (((state[base + BODY.flags] as number) & FLAG.grounded) !== 0) {
        effects.push({ kind: 'despawn', body });
        // Propadlý bonus události nic nestojí: ani život, ani kombo.
        if (role !== ROLE.collectible || bodyHp(state, body) > 0) continue;
        if (dropped < 0) dropped = droppedSoFar(state, params.launches);
        dropped += 1;
        if (dropped > params.free) effects.push({ kind: 'damage', amount: 1 });
        if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier: 0 });
        continue;
      }
      if (tap === null || (state[base + BODY.y] as number) < SLICE.cutY || laneOfX(state[base + BODY.x] as number) !== tap) continue;
      if (role === ROLE.hazard) effects.push({ kind: 'damage', amount: 1 }, { kind: 'despawn', body });
      else sliced.push(body);
    }
    if (sliced.length > 0) {
      // Propadlé ovoce v témže tiku sérii přerušilo: švih začíná od ×1.
      const chain = params.combo === undefined || dropped >= 0 ? 1 : sliceChain(state, params.combo);
      const multiplier = Math.min(COMBO.max, chain + sliced.length - 1);
      for (const body of sliced) {
        // Bonus události: body (zlatý ×`goldenPoints`) a kombo, do cíle se nepočítá.
        const mark = bodyHp(state, body);
        if (mark > 0) effects.push({ kind: 'score', amount: params.points * multiplier * (mark === EVENT_MARK.golden ? LANE_EVENTS.goldenPoints : 1) }, { kind: 'despawn', body });
        else effects.push({ kind: 'score', amount: params.points * multiplier }, { kind: 'count', counter: 'items', amount: 1 }, { kind: 'despawn', body });
      }
      if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
    }
    return effects;
  },
};

export const SLICE_RULES = { slice_cut: sliceCutRule } as const;
