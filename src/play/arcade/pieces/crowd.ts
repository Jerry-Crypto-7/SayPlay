/**
 * Dav a brány (P54C T10, Count Masters): hrdina vede dav tratí, která běží sama po +z. Dvojice bran ve dvou
 * pruzích (+N, ×2, −N, ÷2) dav mění – hráč vybírá pruh. Překážka v pruhu dav zmenší a vezme život. Na konci trati
 * stojí obr: dav se s ním bije, dokud jeden z nich nedojde. Velikost davu je čítač (`CROWD_COUNTER`).
 *
 * **Ovládání `crowd`.** Hrdina běží stálou rychlostí `CROWD.speed`; vlevo/vpravo (tlačítka nebo znaménko osy) vybere
 * pruh bran (−1 / +1), kam hrdina přeběhne rychlostí `CROWD.lateral`. Začíná uprostřed (pruh 0) a tam se už nevrátí.
 * Na čáře souboje (`stop`) zastaví. Tělo hrdiny: `aux0` = pruh.
 *
 * **Pravidla.** `crowd_gate` (tik): hrdina, který tik přeběhl `z` dvojice bran, projde branou na své straně sloupku
 * (`CROWD.sep`); uprostřed neprojde žádnou. Brána přepočte dav, započte se do čítače `items`, růst dá body × kombo,
 * úbytek kombo shodí. `crowd_hit` (kontakt): překážka ubere `loss` davu a život (s milostí) a zmizí. `crowd_fight`
 * (tik): od čáry souboje ubírá dav i HP obra po `rate` za tik; obr na nule = výhra, dav na nule = prohra.
 * Dav na nule (brána, překážka, souboj) je prohra vždy.
 *
 * **Trať** (`crowdLayout`) je jako u běžce ze tří úseků, které houstnou: dvojice bran jsou po třetinách blíž u sebe
 * (`CROWD.gaps`), takže na přeběh mezi nimi zbývá méně času. Lepší brána je po pruzích střídaná ze semínka.
 * Síla obra plyne z délky trati (`bossStrength`). **Hratelné z konstrukce** (`checkCrowdLevel`): chamtivá cesta robota
 * (vždy brána s větším výsledkem) stihne každý přeběh s jeho reakcí, nikdy nevede přes překážku a dojde s davem nad
 * silou obra; nečinný hráč (střed) ani hráč, který drží jednu stranu, nevyhraje.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_LIMITS,
  type ArcadeCounter,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  BUTTON,
  type BodyInit,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  HIT_GRACE,
  HP_MAX,
  type ModeGeneratorPiece,
  type ModeParts,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
  bodyHp,
} from '../contract';
import { nextMultiplier } from './rules';

export const CROWD = {
  /** Běh vpřed (j/tik): 7,8 m/s. Brány stojí na celých ticích běhu (`z = tick × speed`). */
  speed: 130,
  /** Středy pruhů bran (±x) a boční rychlost přeběhu: z pruhu do pruhu za 13 tiků. */
  laneX: 1300,
  lateral: 200,
  /** Polovina sloupku mezi branami: hrdina blíž středu neprojde žádnou z nich. */
  sep: 300,
  /** Šíře jedné brány (scéna). */
  gateW: 2200,
  hero: { w: 600, h: 1600, d: 500 },
  /** Dav na startu. */
  start: 5,
  lives: 3,
  /** Dvojic bran na trati; po třetinách úseky. */
  pairs: 30,
  /** Rozběh před první dvojicí (tiky). */
  runUp: 150,
  /** Odstup dvojic bran (tiky) po úsecích: rozjezd, hustší, nejtěžší. */
  gaps: [
    [100, 130],
    [36, 52],
    [23, 31],
  ],
  /** Jak často (‰) je lepší brána v jiném pruhu než minulá – přeběh. */
  switchShare: [500, 600, 700],
  /** Jak často (‰) dostane mezera bez přeběhu překážku v pruhu, kterým robot neběží. */
  obstacleShare: [600, 600, 600],
  obstacle: { w: 2000, h: 1200, d: 600 },
  /** Kolik davu překážka ubere, po úsecích. */
  loss: [
    [3, 6],
    [5, 10],
    [8, 14],
  ],
  /** Obr: síla = délka trati v metrech × `perMetre` / 1000; čelo stojí `gap` za čárou souboje. */
  boss: { perMetre: 400, w: 4200, h: 3800, d: 2400, gap: 2500 },
  /** Dav chamtivé cesty míří na tolik ‰ síly obra (`goalOf`); kontrola chce aspoň `margin` ‰. */
  target: 1290,
  margin: 1200,
  /** Od poslední dvojice k čáře souboje (tiky). */
  runOut: 150,
  /** Souboj s obrem plné síly trvá tolik tiků (ubírá se `rate` za tik). */
  fightTicks: 60,
  points: 10,
  bossPoints: 50,
  /** Robot vyhraje nejdřív a nejpozději (tiky): pásmo 30–90 s s rezervou. */
  shortest: 32 * 60,
  longest: 80 * 60,
  /** Reakce robota světa a rezerva, se kterou kontrola počítá přeběh (tiky). */
  reaction: 8,
  reserve: 6,
} as const;

/** Velikost davu: čítač, který jiné hry pruhů nepoužívají a HUD ho neukazuje (dav kreslí scéna). */
export const CROWD_COUNTER = 'reserve' satisfies ArcadeCounter;
export const crowdOf = (state: Int32Array): number => state[HEADER.counters + COUNTER[CROWD_COUNTER]] as number;

// ---------------------------------------------------------------------------
// Brány

/** Operace brány: přičti, násob, odečti, děl. Čísla jsou součást parametrů světa, nepřečíslovat. */
export const OP = { add: 0, mul: 1, sub: 2, div: 3 } as const;
export type GateOp = (typeof OP)[keyof typeof OP];

export interface Gate {
  readonly op: GateOp;
  readonly n: number;
}

/** Dav za branou; nikdy pod nulu. */
export function applyGate(op: number, n: number, crowd: number): number {
  if (op === OP.add) return crowd + n;
  if (op === OP.mul) return crowd * n;
  if (op === OP.sub) return Math.max(0, crowd - n);
  return Math.floor(crowd / n);
}

/** Text brány, jak ho hráč vidí: „+10“, „×2“, „−5“, „÷2“. */
export const gateLabel = (op: number, n: number): string => `${op === OP.add ? '+' : op === OP.mul ? '×' : op === OP.sub ? '−' : '÷'}${String(n)}`;

/** Dvojice bran v parametrech: `[z, op vlevo, n vlevo, op vpravo, n vpravo]` (vlevo = −x jádra). */
export type GateRef = readonly [z: number, leftOp: number, leftN: number, rightOp: number, rightN: number];

/** Pruh, kterým hrdina v `x` projde branou: −1, +1, nebo 0 = sloupek mezi nimi. */
export const gateSide = (x: number): number => (x < -CROWD.sep ? -1 : x > CROWD.sep ? 1 : 0);

/** Dav za dvojicí `gate` na straně `side` (0 = sloupek, dav beze změny). */
export const throughGate = (gate: GateRef, side: number, crowd: number): number =>
  side < 0 ? applyGate(gate[1], gate[2], crowd) : side > 0 ? applyGate(gate[3], gate[4], crowd) : crowd;

/** Lepší strana dvojice pro dav `crowd` (větší výsledek); při shodě `keep`, ze středu levá. */
export function betterSide(gate: GateRef, crowd: number, keep: number): number {
  const left = throughGate(gate, -1, crowd);
  const right = throughGate(gate, 1, crowd);
  return left > right ? -1 : right > left ? 1 : keep !== 0 ? keep : -1;
}

// ---------------------------------------------------------------------------
// Ovládání

/** Pruh po vstupu: vlevo/vpravo tlačítkem nebo znaménkem osy; bez vstupu drží. */
export function laneAfter(lane: number, input: { readonly buttons: number; readonly axis: number }): number {
  if ((input.buttons & BUTTON.RIGHT) !== 0 || input.axis > 0) return 1;
  if ((input.buttons & BUTTON.LEFT) !== 0 || input.axis < 0) return -1;
  return lane;
}

const controlParams = z
  .object({
    /** Čára souboje (z): tady se dav zastaví a bije s obrem. */
    stop: z.int().min(0),
  })
  .strict();

export const crowdControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'crowd',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    const lane = laneAfter(state[base + BODY.aux0] as number, input);
    state[base + BODY.aux0] = lane;
    const dx = lane * CROWD.laneX - (state[base + BODY.x] as number);
    state[base + BODY.vx] = Math.max(-CROWD.lateral, Math.min(CROWD.lateral, dx));
    state[base + BODY.vz] = Math.max(0, Math.min(CROWD.speed, params.stop - (state[base + BODY.z] as number)));
  },
};

// ---------------------------------------------------------------------------
// Trať

export interface GatePair {
  /** Tik, ve kterém hrdina dvojici projde (`z = tick × speed`). */
  readonly tick: number;
  readonly left: Gate;
  readonly right: Gate;
}

export interface CrowdObstacle {
  readonly tick: number;
  readonly lane: -1 | 1;
  readonly loss: number;
}

export interface CrowdLayout {
  readonly pairs: readonly GatePair[];
  readonly obstacles: readonly CrowdObstacle[];
  /** Tik, ve kterém hrdina dojde na čáru souboje. */
  readonly stopTick: number;
  readonly boss: number;
}

const SALT = 0x6c0d;
type Rng = ReturnType<typeof createCompileRng>;

/** Úsek (0–2) dvojice `index` z `count`. */
export const sectionOf = (index: number, count: number): number => Math.min(2, Math.floor((3 * index) / count));

/** Síla obra z délky trati (metry k čáře souboje), nejvýš HP jádra. */
export const bossStrength = (stopTick: number): number => Math.min(HP_MAX, Math.round((stopTick * CROWD.speed * CROWD.boss.perMetre) / (UNIT * 1000)));

/** Dav, na který míří chamtivá cesta. */
export const goalOf = (boss: number): number => Math.round((boss * CROWD.target) / 1000);

/** Za kolik tiků od rozhodnutí přeběhne hrdina z jednoho pruhu za sloupek druhého. */
export const SWITCH_TICKS = Math.floor((CROWD.laneX + CROWD.sep) / CROWD.lateral) + 1;

/**
 * Nejmenší odstup dvou dvojic (tiky), mezi kterými stihne přeběh hráč s reakcí `reaction`: bránu `k` vidí
 * `reaction` tiků po průchodu, v tom tiku vyrazí a za `SWITCH_TICKS` je za sloupkem.
 */
export const switchNeed = (reaction: number): number => reaction + SWITCH_TICKS;

/** Brána, která dav chamtivé cesty posune k `want`: ×2, když se vejde, jinak +N. Výsledek je vždy větší než `crowd`. */
function goodGate(rng: Rng, crowd: number, want: number): Gate {
  const slack = Math.max(3, Math.floor(want / 4));
  if (crowd >= 2 && crowd <= 50 && 2 * crowd <= want + slack && rng.int(0, 999) < 600) return { op: OP.mul, n: 2 };
  return { op: OP.add, n: Math.min(99, Math.max(2, want - crowd)) };
}

/** Váhy druhů horší brány po úsecích: menší plus, ×2, mínus, ÷2. */
const ALT_WEIGHTS: readonly (readonly [add: number, mul: number, sub: number, div: number])[] = [
  [4, 3, 2, 1],
  [2, 2, 3, 2],
  [2, 1, 4, 1],
];

/** Horší brána dvojice: výsledek menší než dobré brány, dav nad nulou. */
function altGate(rng: Rng, crowd: number, good: Gate, section: number): Gate {
  const best = applyGate(good.op, good.n, crowd);
  const gain = best - crowd;
  const options: { gate: Gate; weight: number }[] = [];
  const [add, mul, sub, div] = ALT_WEIGHTS[section] as readonly [number, number, number, number];
  if (gain >= 3) options.push({ gate: { op: OP.add, n: rng.int(Math.max(1, Math.floor(gain / 3)), gain - 1) }, weight: add });
  if (good.op !== OP.mul && 2 * crowd < best) options.push({ gate: { op: OP.mul, n: 2 }, weight: mul });
  if (crowd >= 3) {
    const low = Math.min(crowd - 1, Math.max(2, Math.round(gain / 2)));
    options.push({ gate: { op: OP.sub, n: rng.int(low, Math.max(low, Math.min(crowd - 1, gain + 4))) }, weight: sub });
  }
  if (crowd >= 4) options.push({ gate: { op: OP.div, n: 2 }, weight: div });
  if (options.length === 0) return { op: OP.sub, n: 1 };
  let pick = rng.int(1, options.reduce((sum, option) => sum + option.weight, 0));
  for (const option of options) {
    pick -= option.weight;
    if (pick <= 0) return option.gate;
  }
  return (options.at(-1) as { gate: Gate }).gate;
}

/** Jeden los trati: dvojice bran po úsecích, překážky v mezerách bez přeběhu, čára souboje a síla obra. */
function layoutOnce(rng: Rng): CrowdLayout {
  const count = CROWD.pairs;
  const ticks: number[] = [];
  let tick: number = CROWD.runUp;
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      const [low, high] = CROWD.gaps[sectionOf(index, count)] as readonly [number, number];
      tick += rng.int(low, high);
    }
    ticks.push(tick);
  }
  const stopTick = tick + CROWD.runOut;
  const boss = bossStrength(stopTick);
  const goal = goalOf(boss);
  const pairs: GatePair[] = [];
  const lanes: number[] = [];
  let crowd: number = CROWD.start;
  let lane = 0;
  ticks.forEach((at, index) => {
    const section = sectionOf(index, count);
    const want = CROWD.start + Math.round(((goal - CROWD.start) * (index + 1)) / count);
    const good = goodGate(rng, crowd, want);
    const alt = altGate(rng, crowd, good, section);
    const side = lane === 0 ? rng.pick([-1, 1] as const) : rng.int(0, 999) < (CROWD.switchShare[section] as number) ? -lane : lane;
    pairs.push({ tick: at, left: side < 0 ? good : alt, right: side < 0 ? alt : good });
    lanes.push(side);
    crowd = applyGate(good.op, good.n, crowd);
    lane = side;
  });
  const obstacles: CrowdObstacle[] = [];
  for (let index = 0; index + 1 < count; index += 1) {
    const section = sectionOf(index + 1, count);
    if (lanes[index] !== lanes[index + 1] || rng.int(0, 999) >= (CROWD.obstacleShare[section] as number)) continue;
    const [low, high] = CROWD.loss[section] as readonly [number, number];
    obstacles.push({ tick: Math.floor(((ticks[index] as number) + (ticks[index + 1] as number)) / 2), lane: -(lanes[index] as number) as -1 | 1, loss: rng.int(low, high) });
  }
  return { pairs, obstacles, stopTick, boss };
}

/** Trať ze semínka: los se opakuje, dokud neprojde kontrolou (nejvýš 64×; jinak poslední los a jeho nálezy). */
export function crowdLayout(seed: number): CrowdLayout {
  const rng = createCompileRng(seed ^ SALT);
  let layout = layoutOnce(rng);
  for (let attempt = 1; attempt < 64 && checkLayout(layout).length > 0; attempt += 1) layout = layoutOnce(rng);
  return layout;
}

/** Indexy těl úrovně: hrdina 0, překážky od 1 (podle `z`), obr za nimi. */
export const CROWD_BODIES = { firstObstacle: 1 } as const;

export const gateRefsOf = (layout: CrowdLayout): GateRef[] => layout.pairs.map((pair) => [pair.tick * CROWD.speed, pair.left.op, pair.left.n, pair.right.op, pair.right.n]);

/** Úroveň: hrdina uprostřed, překážky v pruzích, obr za čárou souboje; dav na startu v čítači. */
export function crowdLevel(layout: CrowdLayout): ArcadeLevel {
  const stop = layout.stopTick * CROWD.speed;
  const { obstacle, boss } = CROWD;
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: 0, y: 0, z: 0, ...CROWD.hero, solid: false },
    ...layout.obstacles.map((item): BodyInit => ({ role: 'obstacle', kind: 'obstacle', x: item.lane * CROWD.laneX, y: 0, z: item.tick * CROWD.speed, ...obstacle, solid: false })),
    { role: 'enemy', kind: 'boss', x: 0, y: 0, z: stop + boss.gap + boss.d / 2, w: boss.w, h: boss.h, d: boss.d, solid: false, hp: layout.boss },
  ];
  return { bodies, length: stop, counters: { [CROWD_COUNTER]: CROWD.start } };
}

/** Index těla obra v úrovni. */
export const bossIndex = (layout: Pick<CrowdLayout, 'obstacles'>): number => CROWD_BODIES.firstObstacle + layout.obstacles.length;

/** Za kolik tiků od čáry souboje padne obr síly `boss`, a kolik ubírá za tik. */
export const fightRate = (boss: number): number => Math.max(1, Math.ceil(boss / CROWD.fightTicks));

/** Tik výhry robota světa: čára souboje + souboj. */
export const predictedTicks = (layout: CrowdLayout): number => layout.stopTick + Math.ceil(layout.boss / fightRate(layout.boss));

/** Konec cesty, která na každé dvojici volí stranu `choose`: dav, ztracené životy a dav na konci trati. */
export interface PathEnd {
  readonly crowd: number;
  readonly lives: number;
  /** Dav došel na nulu dřív než k obrovi. */
  readonly wiped: boolean;
}

/** Projde trať cestou, která na dvojici `index` stojí v pruhu `choose(index, crowd)`; překážka v témže pruhu ubere dav a život. */
export function walkPath(layout: CrowdLayout, choose: (index: number, crowd: number) => number, lives: number = CROWD.lives): PathEnd {
  const refs = gateRefsOf(layout);
  let crowd: number = CROWD.start;
  let left = lives;
  let lane = 0;
  type Event = { readonly tick: number; readonly index: number } | { readonly tick: number; readonly item: CrowdObstacle };
  const events: Event[] = [...layout.pairs.map((pair, index): Event => ({ tick: pair.tick, index })), ...layout.obstacles.map((item): Event => ({ tick: item.tick, item }))].sort((a, b) => a.tick - b.tick);
  for (const event of events) {
    if ('item' in event) {
      if (event.item.lane !== lane) continue;
      crowd = Math.max(0, crowd - event.item.loss);
      left -= 1;
    } else {
      lane = choose(event.index, crowd);
      crowd = throughGate(refs[event.index] as GateRef, lane, crowd);
    }
    if (crowd <= 0 || left <= 0) return { crowd, lives: left, wiped: true };
  }
  return { crowd, lives: left, wiped: false };
}

/** Chamtivá cesta robota: na každé dvojici strana s větším výsledkem. */
export function greedyLanes(layout: CrowdLayout): number[] {
  const refs = gateRefsOf(layout);
  const lanes: number[] = [];
  let crowd: number = CROWD.start;
  let lane = 0;
  refs.forEach((gate) => {
    lane = betterSide(gate, crowd, lane);
    crowd = throughGate(gate, lane, crowd);
    lanes.push(lane);
  });
  return lanes;
}

/** Vyhraje cesta souboj? Dav musí po souboji zůstat nad nulou. */
export const beatsBoss = (end: PathEnd, boss: number): boolean => !end.wiped && end.crowd > boss;

/** Tvrzení „hratelné z konstrukce“ nad rozvržením; prázdné pole = hratelná. */
export function checkLayout(layout: CrowdLayout): string[] {
  const issues: string[] = [];
  const need = switchNeed(CROWD.reaction) + CROWD.reserve;
  const lanes = greedyLanes(layout);
  layout.pairs.forEach((pair, index) => {
    if (index === 0) {
      if (pair.tick < CROWD.reaction + SWITCH_TICKS) issues.push('the first pair comes before the bot can leave the middle');
      return;
    }
    const gap = pair.tick - (layout.pairs[index - 1] as GatePair).tick;
    if (gap <= 0) issues.push(`pair ${index} does not come after pair ${index - 1}`);
    else if (lanes[index] !== lanes[index - 1] && gap < need) issues.push(`pair ${index} needs a switch in ${gap} ticks, the bot needs ${need}`);
  });
  for (const item of layout.obstacles) {
    const after = layout.pairs.findIndex((pair) => pair.tick > item.tick);
    if (after <= 0) issues.push(`the obstacle at tick ${item.tick} is not between two pairs`);
    else if (lanes[after - 1] === item.lane || lanes[after] === item.lane) issues.push(`the obstacle at tick ${item.tick} stands in the bot's lane`);
  }
  const greedy = walkPath(layout, (index) => lanes[index] as number);
  if (greedy.wiped || greedy.lives < CROWD.lives) issues.push('the greedy path loses its crowd or a life');
  if (greedy.crowd * 1000 < layout.boss * CROWD.margin) issues.push(`the greedy crowd ${greedy.crowd} is under ${CROWD.margin / 1000}× the boss ${layout.boss}`);
  if (beatsBoss({ crowd: CROWD.start, lives: CROWD.lives, wiped: false }, layout.boss)) issues.push('an idle crowd beats the boss');
  for (const side of [-1, 1]) if (beatsBoss(walkPath(layout, () => side), layout.boss)) issues.push(`holding the ${side < 0 ? 'left' : 'right'} lane beats the boss`);
  const ticks = predictedTicks(layout);
  if (ticks < CROWD.shortest || ticks > CROWD.longest) issues.push(`the bot wins at tick ${ticks}, outside ${CROWD.shortest}–${CROWD.longest}`);
  if (layout.boss < 1 || layout.boss > HP_MAX) issues.push(`boss strength ${layout.boss} outside 1–${HP_MAX}`);
  return issues;
}

/** Kontrola nad hotovou úrovní: rozvržení a těla, která z něj úroveň postavila. */
export function checkCrowdLevel(level: ArcadeLevel, layout: CrowdLayout): string[] {
  const issues = checkLayout(layout);
  const obstacles = level.bodies.filter((body) => body.role === 'obstacle');
  if (obstacles.length !== layout.obstacles.length) issues.push(`${obstacles.length} obstacle bodies for ${layout.obstacles.length} obstacles`);
  obstacles.forEach((body, index) => {
    const item = layout.obstacles[index];
    if (item === undefined || body.z !== item.tick * CROWD.speed || body.x !== item.lane * CROWD.laneX) issues.push(`obstacle body ${index + 1} is not where the layout puts it`);
  });
  const boss = level.bodies[bossIndex(layout)];
  if (boss?.role !== 'enemy' || boss.hp !== layout.boss) issues.push('the boss body does not carry the boss strength');
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Díly světa z hotového rozvržení (i ručního v testech). */
export function crowdWorldOf(layout: CrowdLayout, lives: number): Omit<ModeParts, 'issues'> {
  const stop = layout.stopTick * CROWD.speed;
  const gates = gateRefsOf(layout);
  const boss = bossIndex(layout);
  return {
    control: { id: 'crowd', params: { stop } },
    bot: { id: 'crowd_bot', params: { gates, stop } },
    level: crowdLevel(layout),
    rules: [
      { id: 'crowd_gate', params: { gates, points: CROWD.points } },
      { id: 'crowd_hit', params: { losses: layout.obstacles.map((item, index) => [CROWD_BODIES.firstObstacle + index, item.loss]) } },
      { id: 'crowd_fight', params: { boss, stop, rate: fightRate(layout.boss), points: CROWD.bossPoints } },
      { id: 'out_of_health', params: {} },
      // Pilulka postupu HUD (`collectNeed`) čte cíl z `finish_collected`: prošlé brány z dvojic. Tělo cíle svět nemá, nevystřelí.
      { id: 'finish_collected', params: { need: layout.pairs.length } },
    ],
    health: lives,
  };
}

const generatorParams = z.object({}).strict();
export type CrowdParams = z.infer<typeof generatorParams>;

export function crowdParts(seed: number, _params: CrowdParams, health: number | undefined): ModeParts {
  const layout = crowdLayout(seed);
  const parts = crowdWorldOf(layout, health ?? CROWD.lives);
  return { ...parts, issues: checkCrowdLevel(parts.level, layout) };
}

export const crowdTrack: ModeGeneratorPiece<CrowdParams> = {
  id: 'crowd_track',
  params: generatorParams,
  roles: ['player', 'obstacle', 'enemy'],
  cost: () => ({ bodies: 2 + CROWD.pairs, rules: 5 }),
  generate: (seed) => crowdLevel(crowdLayout(seed)),
  parts: crowdParts,
};

// ---------------------------------------------------------------------------
// Pravidla

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const op = z.int().min(0).max(3);
const gateN = z.int().min(1).max(99);
const gateRef = z.tuple([z.int().min(0), op, gateN, op, gateN]);

const gateParams = z
  .object({
    gates: z.array(gateRef).max(50),
    points: z.int().min(1).max(100),
    /** Počítadlo komba (P46C T3, `withCombo`); bez něj body bez násobiče. */
    combo: index.optional(),
  })
  .strict();

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Násobič série dobrých bran: bez časového okna, shodí ho špatná brána (zápis 0) a ztracený život. */
const gateMultiplier = (state: Int32Array, keeper: number): number =>
  (state[bodyBase(keeper) + BODY.aux0] as number) === 0 ? 1 : nextMultiplier(state, keeper, ARCADE_LIMITS.maxTicks);

/**
 * Průchod branou (tik): dvojice, jejíž `z` hrdina v tiku přeběhl, přepočte dav podle strany sloupku; za sloupkem
 * (uprostřed) se nic nestane. Brána se započte do `items`; růst dá body × kombo, úbytek kombo shodí; dav na nule prohra.
 */
export const crowdGateRule: RulePiece<z.infer<typeof gateParams>> = {
  id: 'crowd_gate',
  params: gateParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const base = bodyBase(player);
    const vz = state[base + BODY.vz] as number;
    if (vz <= 0) return [];
    const z = state[base + BODY.z] as number;
    const side = gateSide(state[base + BODY.x] as number);
    const effects: ArcadeEffect[] = [];
    for (const gate of params.gates) {
      if (gate[0] <= z - vz || gate[0] > z || side === 0) continue;
      const before = crowdOf(state);
      const after = throughGate(gate, side, before);
      effects.push({ kind: 'count', counter: CROWD_COUNTER, amount: after - before }, { kind: 'count', counter: 'items', amount: 1 });
      if (after > before) {
        const multiplier = params.combo === undefined ? 1 : gateMultiplier(state, params.combo);
        effects.push({ kind: 'score', amount: params.points * multiplier });
        if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
      } else if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier: 0 });
      if (after <= 0) effects.push({ kind: 'lose' });
    }
    return effects;
  },
};

const hitParams = z
  .object({
    /** `[tělo překážky, kolik davu ubere]`. */
    losses: z.array(z.tuple([index, z.int().min(1).max(99)])).max(CROWD.pairs),
  })
  .strict();

/** Překážka (kontakt): ubere dav, život (s vteřinou milosti) a zmizí; dav na nule prohra. */
export const crowdHitRule: RulePiece<z.infer<typeof hitParams>> = {
  id: 'crowd_hit',
  params: hitParams,
  roles: ['player', 'obstacle'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) => {
    if (state[bodyBase(other) + BODY.role] !== ROLE.obstacle) return [];
    const loss = params.losses.find(([body]) => body === other)?.[1] ?? 1;
    const crowd = crowdOf(state);
    const lost = Math.min(loss, crowd);
    const effects: ArcadeEffect[] = [{ kind: 'count', counter: CROWD_COUNTER, amount: -lost }, { kind: 'damage', amount: 1, grace: HIT_GRACE }, { kind: 'despawn', body: other }];
    if (crowd - lost <= 0) effects.push({ kind: 'lose' });
    return effects;
  },
};

const fightParams = z
  .object({
    boss: index,
    /** Čára souboje (z hrdiny). */
    stop: z.int().min(0),
    /** Kolik davu a HP obra ubude za tik. */
    rate: z.int().min(1).max(HP_MAX),
    points: z.int().min(1).max(500),
  })
  .strict();

/**
 * Souboj (tik): od čáry souboje ubírá dav i HP obra po `rate` (útočník je hrdina). Obr na nule padne – body a zbylý
 * dav do skóre a výhra; dav na nule je prohra, i když obr padl v témže tiku.
 */
export const crowdFightRule: RulePiece<z.infer<typeof fightParams>> = {
  id: 'crowd_fight',
  params: fightParams,
  roles: ['player', 'enemy'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    if ((state[bodyBase(player) + BODY.z] as number) < params.stop || !alive(state, params.boss)) return [];
    const hp = bodyHp(state, params.boss);
    const crowd = crowdOf(state);
    const blow = Math.min(params.rate, hp, crowd);
    const effects: ArcadeEffect[] = [];
    if (blow > 0) effects.push({ kind: 'hit', body: params.boss, by: player, amount: blow }, { kind: 'count', counter: CROWD_COUNTER, amount: -blow });
    if (crowd - blow <= 0) effects.push({ kind: 'lose' });
    else if (hp - blow <= 0) effects.push({ kind: 'despawn', body: params.boss }, { kind: 'score', amount: params.points + crowd - blow }, { kind: 'win' });
    return effects;
  },
};

export const CROWD_RULES = { crowd_gate: crowdGateRule, crowd_hit: crowdHitRule, crowd_fight: crowdFightRule } as const;
