/**
 * Obrana pruhů (P54C T7): vlny nepřátel jdou pěti pruhy (`lanes.ts`) k hradbě a hrdina za ní je zastaví.
 *
 * Každý nepřítel je kinematické tělo, které stálou rychlostí jde po −z; do obrazu vejde (`DEFENSE.far`)
 * v tiku spočitatelném ze semínka a hradbu (`DEFENSE.wall`) prolomí v tiku `breachStep`. Ťuk vystřelí
 * šíp do pruhu z osy (přebíjení `reload` tiků, čítač `cooldown`); šíp letí po +z a zasáhne nejbližšího
 * nepřítele v pruhu – ubere mu HP, na nule nepřítel padne (body × kombo, čítač `items`). Držení
 * `hold` tiků postaví v pruhu obránce (strop 1 na pruh), který každých `volley` tiků střílí na nepřítele
 * blíž než `reach` od hradby. Nepřítel u hradby ubere život; boss poslední vlny prolomí bránu
 * a vezme všechny. Výhra = žádný nepřítel už nejde (`defense_goal`), prohra = životy došly.
 *
 * Vlny (`DEFENSE.waves`) houstnou, zrychlují (`waveSpeedStep` z `waves.ts`) a nesou tužší nepřátele;
 * pořadí běžící vlny je v čítači `WAVE_COUNTER` (`waveOf`). Poslední nepřítel poslední vlny je boss
 * (finále P51 pro `genre.v5`: hrozba s ≥ 3 zásahy, která padne – telemetrie `finale.why = 'boss'`).
 *
 * **Hratelné z konstrukce** (`checkDefenseLevel`): v pruhu se nepřátelé nepřekrývají a sám hrdina
 * (bez obránců) stihne každého sestřelit dřív, než dojde k hradbě, i když nepřítele vidí o reakci
 * robota později (rozvrh EDF nad jedním lukem). Nečinný hráč nevystřelí: první nepřátelé u hradby
 * mu vezmou všechny životy dřív, než dojde boss.
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
} from '../contract';
import { EVENT_MARK, LANE_EVENTS, laneEventRng, planLaneEvents, stepLane } from './lane-events';
import { LANES, LANE_START, heldTicks, laneOf, laneOfX, laneX, tappedIn } from './lanes';
import { nextMultiplier } from './rules';
import { WAVE_COUNTER, waveSpeedStep } from './waves';

export const DEFENSE = {
  hero: { w: 1200, h: 1600, d: 1000 },
  /** Přední líc hradby (z): nepřítel, jehož čelo ho dosáhne, prolomil bránu. */
  wall: 2500,
  /** Hradba přes všech pět pruhů (tělo nese popisek bráněné věci); hrdina stojí za ní. */
  castle: { w: LANES.count * LANES.width, h: 1000, d: 1200 },
  /** Kde nepřítel vyjde z mlhy do obrazu: odsud ho robot vidí a šíp ho ještě dolétne. */
  far: 16000,
  enemy: { w: 1000, h: 1400, d: 1000 },
  boss: { w: 1800, h: 2400, d: 1600, hp: 14, speed: 45 },
  /** Vln na hru; poslední končí bossem. */
  waves: 4,
  /** Podíl vln na nepřátelích (hranice vln po zaokrouhlení součtů). */
  shares: [3, 4, 5, 6],
  /** Rozestupy vstupů po sobě jdoucích nepřátel po vlnách (tiky). */
  gaps: [
    [80, 110],
    [44, 60],
    [28, 38],
    [18, 26],
  ],
  /** Přestávka mezi vlnami (tiky od posledního vstupu vlny): nejméně, a nejvíc, než se natáhnou rozestupy. */
  pause: { min: 240, max: 600 },
  /** Rychlost první vlny (jednotky za tik); každá další o `waveSpeedStep(waves) × rise` víc. */
  speed: 50,
  rise: 10,
  /** Kolik nepřátel (‰) má po vlnách dvě HP místo jedné. */
  tough: [0, 200, 400, 500],
  /**
   * Útok ve dvojici: dva útočníci (jedno HP) vyběhnou z mlhy v témže tiku ve dvou pruzích a k hradbě
   * doběhnou za `ticks`. Kolik dvojic má vlna, je los v mezích `pairs`. Robot s reakcí 8 tiků sestřelí oba,
   * kdo reaguje o půl vteřiny později, stihne jen prvního – na útoky platí reakce.
   */
  charge: {
    pairs: [
      [0, 0],
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    ticks: 30,
  },
  /** První nepřítel vejde do obrazu ve vteřině hry. */
  firstUp: 60,
  /** Boss vejde tolik tiků po posledním nepříteli vlny. */
  bossGap: 90,
  /** Boss vejde nejdřív v tomhle tiku: malý počet nepřátel prodlouží přestávky (a pak rozestupy), ať hra trvá aspoň 45 s. */
  bossAt: 2700,
  bolt: { w: 300, h: 300, d: 800, speed: 1500, lifetime: 11, y: 1200 },
  arrow: { w: 250, h: 250, d: 700, speed: 1200, lifetime: 13, y: 1600 },
  defender: { w: 900, h: 1400, d: 900 },
  /** Hrdina vystřelí jednou za tolik tiků. */
  reload: 12,
  /** Tiky držení, po kterých v pruhu stojí obránce (0,5 s). */
  hold: 30,
  /** Obránce vystřelí jednou za tolik tiků; pruhy se střídají po `stagger`. */
  volley: 150,
  stagger: 30,
  /** Obránce střílí jen na nepřítele, jehož čelo je blíž než tohle od hradby. */
  reach: 7000,
  points: 10,
  bossPoints: 50,
  enemies: { min: 10, max: 50, default: 30 },
  /** Volné sloty pro šípy ve vzduchu a obránce. */
  spawnSlots: 24,
  /** Rezerva robota před průlomem (tiky) v kontrole hratelnosti. */
  margin: 3,
  /**
   * Bonusové cíle událostí (P55 T5): jdou pruhem jako nepřítel, ale padnou jen šípu hrdiny, do cíle se
   * nepočítají a kdo je nesestřelí, nic neztratí – projdou hradbou a zmizí z obrazu. Série a spěch jdou
   * `speed`, zlatý cíl `goldenSpeed` (kratší okno). Rozestupy vstupů: série `series`, spěch `rush`,
   * série v přestávce mezi vlnami `breaks` (tiky).
   */
  bonus: { w: 900, h: 900, d: 900, speed: 100, goldenSpeed: 200, series: [30, 45], rush: [20, 30], breaks: [60, 90] },
} as const;

/** Reakce robota světa – kontrola hratelnosti s ní počítá. */
export const DEFENSE_BOT_REACTION = 8;

/** Scéna kreslí, co má čelo nejvýš tolik za `far` (vykukuje zpoza plotu). */
export const SHOWN_BEYOND = 600;

const SALT = 0x5d3f;

/** Jeden nepřítel rozpisu: tik vstupu do obrazu, pruh, rychlost, HP a vlna. */
export interface March {
  readonly enter: number;
  readonly lane: number;
  readonly speed: number;
  readonly hp: number;
  readonly wave: number;
  readonly boss: boolean;
}

export const defenseParams = z
  .object({
    /** Kolik nepřátel přijde ve všech vlnách včetně bosse (`COUNT_PARAMS.defense.default.enemy`). */
    enemies: z.int().min(DEFENSE.enemies.min).max(DEFENSE.enemies.max).default(DEFENSE.enemies.default),
  })
  .strict();
export type DefenseParams = z.infer<typeof defenseParams>;

/** Hloubka těla nepřítele (boss je větší). */
const depthOf = (boss: boolean): number => (boss ? DEFENSE.boss.d : DEFENSE.enemy.d);

/** Výchozí z nepřítele, který do obrazu (`far`) vejde po kroku `enter − 1`. */
export const startZ = (enter: number, speed: number): number => DEFENSE.far + speed * enter;

/** Krok (od 0), ve kterém čelo nepřítele z výšky `z` dosáhne hradby; `now` = tik stavu, ve kterém je v `z`. */
export const breachStep = (z: number, speed: number, depth: number, now = 0): number => now + Math.ceil((z - depth / 2 - DEFENSE.wall) / speed) - 1;

/** Velikosti vln: hranice po zaokrouhlených součtech podílů, ať každá vlna má aspoň jednoho. */
export function waveSizes(enemies: number): number[] {
  const total = DEFENSE.shares.reduce((sum, share) => sum + share, 0);
  let cumulative = 0;
  let before = 0;
  return DEFENSE.shares.map((share) => {
    cumulative += share;
    const edge = Math.max(before + 1, Math.round((enemies * cumulative) / total));
    const size = edge - before;
    before = edge;
    return size;
  });
}

/** Rychlost útočníka, který z mlhy k hradbě doběhne za `ticks`. */
const chargeSpeed = (ticks: number): number => Math.ceil((DEFENSE.far - DEFENSE.enemy.d / 2 - DEFENSE.wall) / ticks);

/** Výška `z` nepřítele rozpisu po `tick` krocích. */
const zAt = (step: Pick<March, 'enter' | 'speed'>, tick: number): number => startZ(step.enter, step.speed) - step.speed * tick;

/** Krok průlomu nepřítele rozpisu. */
const breachOf = (step: Pick<March, 'enter' | 'speed' | 'boss'>): number => breachStep(startZ(step.enter, step.speed), step.speed, depthOf(step.boss));

/** Nedoběhne pozdější nepřítel v pruhu dřívějšího do něj (od vstupu pozdějšího po průlom prvního z nich)? */
function keepsApart(earlier: Pick<March, 'enter' | 'speed' | 'boss'>, later: Pick<March, 'enter' | 'speed' | 'boss'>): boolean {
  const gap = (depthOf(earlier.boss) + depthOf(later.boss)) / 2;
  const end = Math.min(breachOf(earlier), breachOf(later));
  return later.enter > end || [later.enter, end].every((tick) => zAt(later, tick) - zAt(earlier, tick) >= gap);
}

/**
 * Rozpis ze semínka: nepřátelé v pořadí vstupu, po vlnách, pruh vždy jiný než předchozího a takový,
 * kde útočník nedoběhne nepřítele před sebou. Poslední je boss. Aby vešel nejdřív v `bossAt`,
 * prodlouží se přestávky mezi vlnami (do `pause.max`) a teprve pak rozestupy uvnitř vln – hustota vln,
 * a tedy obtížnost, na počtu nepřátel nezávisí.
 */
export function defenseMarch(seed: number, params: DefenseParams): March[] {
  const rng = createCompileRng(seed ^ SALT);
  const sizes = waveSizes(params.enemies);
  const step = waveSpeedStep(DEFENSE.waves) * DEFENSE.rise;
  const raw: Omit<March, 'enter' | 'lane'>[] = [];
  // Odstupy od předchozího nepřítele; přestávky (první nepřítel vlny od druhé) se dopočtou nakonec.
  const gaps: number[] = [];
  sizes.forEach((size, wave) => {
    // Dvojice útočníků: první z dvojice na losovaném místě vlny (ne první ani boss), druhý hned za ním v témže tiku.
    const [fewest, most] = DEFENSE.charge.pairs[wave] as readonly [number, number];
    const slots = Array.from({ length: Math.max(0, Math.floor((size - 2) / 3)) }, (_, k) => 1 + 3 * k);
    const pairs = new Set(rng.shuffle(slots).slice(0, Math.min(slots.length, rng.int(fewest, most))));
    for (let index = 0; index < size; index += 1) {
      const boss = wave === sizes.length - 1 && index === size - 1;
      const second = pairs.has(index - 1);
      const charge = pairs.has(index) || second;
      const [low, high] = DEFENSE.gaps[wave] as readonly [number, number];
      gaps.push(raw.length === 0 || index === 0 || second ? 0 : boss ? DEFENSE.bossGap : rng.int(low, high));
      const tough = !boss && !charge && rng.int(0, 999) < (DEFENSE.tough[wave] as number);
      raw.push({ wave, boss, speed: boss ? DEFENSE.boss.speed : charge ? chargeSpeed(DEFENSE.charge.ticks) : DEFENSE.speed + wave * step, hp: boss ? DEFENSE.boss.hp : tough ? 2 : 1 });
    }
  });
  const breaks = DEFENSE.waves - 1;
  const within = gaps.reduce((sum, gap) => sum + gap, 0);
  const want = DEFENSE.bossAt - DEFENSE.firstUp;
  const pause = Math.min(DEFENSE.pause.max, Math.max(DEFENSE.pause.min, Math.ceil((want - within) / breaks)));
  const stretch = Math.max(1000, Math.ceil(((want - pause * breaks) * 1000) / Math.max(1, within)));
  let tick: number = DEFENSE.firstUp;
  const timed = raw.map((draft, index): March => {
    if (index > 0) tick += draft.wave !== (raw[index - 1] as Omit<March, 'enter' | 'lane'>).wave ? pause : Math.round(((gaps[index] as number) * stretch) / 1000);
    return { ...draft, enter: tick, lane: 0 };
  });
  // Útočník, kterého by sám hrdina s reakcí robota nestihl (dva naráz), jde jako pěšák své vlny.
  for (let overrun = firstOverrun(timed); overrun >= 0 && (timed[overrun] as March).speed > DEFENSE.speed + (timed[overrun] as March).wave * step; overrun = firstOverrun(timed)) {
    const slow = timed[overrun] as March;
    timed[overrun] = { ...slow, speed: DEFENSE.speed + slow.wave * step };
  }
  const lanes = Array.from({ length: LANES.count }, (_, lane) => lane);
  const lastIn: (March | undefined)[] = lanes.map(() => undefined);
  let previous = -1;
  return timed.map((draft) => {
    const others = lanes.filter((lane) => lane !== previous);
    const open = others.filter((lane) => lastIn[lane] === undefined || keepsApart(lastIn[lane] as March, draft));
    const lane = rng.pick(open.length > 0 ? open : others);
    const march: March = { ...draft, lane };
    lastIn[lane] = march;
    previous = lane;
    return march;
  });
}

/** Bonusový cíl události (P55 T5): tik vstupu do obrazu, pruh, rychlost a značka (`EVENT_MARK`). */
export interface Bonus {
  readonly enter: number;
  readonly lane: number;
  readonly speed: number;
  readonly mark: number;
}

/** Krok, ve kterém čelo bonusu dojde k hradbě: od něj už ho šíp netrefí. */
const leaveOf = (bonus: Pick<Bonus, 'enter' | 'speed'>): number => breachStep(startZ(bonus.enter, bonus.speed), bonus.speed, DEFENSE.bonus.d);

/** Rezerva (tiky) mezi oknem bonusu a oknem čehokoli jiného v témže pruhu. */
const BONUS_CLEAR = 12;

/**
 * Bonusy událostí (P55 T5) nad hotovým rozpisem nepřátel: série a zlaté cíle podle osy `planLaneEvents`,
 * spěch v poslední třetině a série v každé přestávce mezi vlnami (tam by hra jinak osm vteřin mlčela).
 * Tahá jen z vlastního streamu (`laneEventRng`), takže nepřátelé jdou s bonusy i bez nich stejně. Bonus
 * jde jen do pruhu, kde po celé jeho okno (vstup → hradba) nejde nikdo jiný: šíp na bonus netrefí
 * nepřítele, šíp na nepřítele netrefí bonus. Kam se nevejde, tam nepřijde.
 */
export function defenseBonuses(seed: number, march: readonly March[]): Bonus[] {
  const rng = laneEventRng(seed);
  const { speed, goldenSpeed } = DEFENSE.bonus;
  const length = (march.at(-1) as March).enter;
  const busy = march.map((step) => ({ lane: step.lane, from: step.enter - 1, to: breachOf(step) }));
  const bonuses: Bonus[] = [];
  const clear = (lane: number, from: number, to: number): boolean => !busy.some((other) => other.lane === lane && other.from <= to + BONUS_CLEAR && from <= other.to + BONUS_CLEAR);
  /** Položí bonus do pruhu `lane`, nebo do nejbližšího volného; vrátí pruh, kam šel (`null` = nikam). */
  const put = (mark: number, enter: number, lane: number, pace: number): number | null => {
    if (enter >= length) return null;
    const to = leaveOf({ enter, speed: pace });
    const order = Array.from({ length: LANES.count }, (_, k) => k).sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane) || a - b);
    const chosen = order.find((candidate) => clear(candidate, enter - 1, to));
    if (chosen === undefined) return null;
    bonuses.push({ enter, lane: chosen, speed: pace, mark });
    busy.push({ lane: chosen, from: enter - 1, to });
    return chosen;
  };
  /** Série `count` bonusů od tiku `at`, pruh po pruhu přes pole. */
  const series = (mark: number, at: number, count: number, gaps: readonly [number, number]): void => {
    let lane = rng.int(0, LANES.count - 1);
    const away = lane >= LANE_START ? 0 : LANES.count - 1;
    for (let n = 0, tick = at; n < count; n += 1, tick += rng.int(...gaps)) {
      lane = put(mark, tick, lane, speed) ?? lane;
      lane = stepLane(lane, away, LANES.count, rng);
    }
  };
  // Přestávky mezi vlnami napřed: od posledního vstupu vlny do prvního vstupu další jde série po celou dobu.
  march.forEach((step, index) => {
    const before = march[index - 1];
    if (before === undefined || before.wave === step.wave) return;
    const [low, high] = DEFENSE.bonus.breaks;
    series(EVENT_MARK.series, before.enter + rng.int(low, high), Math.floor((step.enter - before.enter) / low), [low, high]);
  });
  // Pak osa událostí do volných pruhů.
  for (const event of planLaneEvents(seed, length)) {
    if (event.kind === 'series') series(EVENT_MARK.series, event.at, rng.int(...LANE_EVENTS.series), DEFENSE.bonus.series);
    else if (event.kind === 'golden') put(EVENT_MARK.golden, event.at, rng.int(0, LANES.count - 1), goldenSpeed);
    else {
      const [low, high] = DEFENSE.bonus.rush;
      series(EVENT_MARK.rush, event.at, Math.ceil((event.until - event.at) / low), [low, high]);
    }
  }
  return bonuses.sort((a, b) => a.enter - b.enter || a.lane - b.lane);
}

/** Indexy těl úrovně obrany: hrdina 0, hradba 1, nepřátelé od 2, za nimi bonusy událostí a předlohy šípu, šípu obránce a obránce. */
export const DEFENSE_BODIES = { castle: 1, firstEnemy: 2 } as const;

/** Úroveň obrany: hrdina za hradbou ve startovním pruhu, nepřátelé a bonusy za obrazem a předlohy. */
export function defenseLevel(seed: number, params: DefenseParams): ArcadeLevel {
  const march = defenseMarch(seed, params);
  const { wall, castle, enemy, boss, bolt, arrow, defender } = DEFENSE;
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: laneX(LANE_START), y: 0, z: 0, ...DEFENSE.hero, solid: false },
    { role: 'platform', kind: 'castle', x: 0, y: 0, z: wall - castle.d / 2, ...castle, solid: false },
    ...march.map((step): BodyInit => {
      const size = step.boss ? { w: boss.w, h: boss.h, d: boss.d } : enemy;
      return { role: 'chaser', kind: 'chaser', x: laneX(step.lane), y: 0, z: startZ(step.enter, step.speed), ...size, solid: false, vz: -step.speed, kinematic: true, hp: step.hp };
    }),
    // Bonusy událostí: značka v HP (`EVENT_MARK`) – role `collectible`, takže HP tu zdraví nepřítele nenese.
    ...defenseBonuses(seed, march).map((bonus): BodyInit => {
      const { w, h, d } = DEFENSE.bonus;
      return { role: 'collectible', kind: 'bonus', x: laneX(bonus.lane), y: 0, z: startZ(bonus.enter, bonus.speed), w, h, d, solid: false, vz: -bonus.speed, kinematic: true, hp: bonus.mark };
    }),
    { role: 'projectile', kind: 'bolt', x: 0, y: bolt.y, z: wall, w: bolt.w, h: bolt.h, d: bolt.d, solid: false, template: true, lifetime: bolt.lifetime },
    { role: 'projectile', kind: 'arrow', x: 0, y: arrow.y, z: wall, w: arrow.w, h: arrow.h, d: arrow.d, solid: false, template: true, lifetime: arrow.lifetime },
    { role: 'platform', kind: 'defender', x: 0, y: castle.h, z: wall - castle.d / 2, ...defender, solid: false, template: true },
  ];
  return { bodies, length: 0, spawnSlots: DEFENSE.spawnSlots };
}

/** Předlohy úrovně (indexy těl): šíp hrdiny, šíp obránce, obránce a boss. */
export function defenseTemplates(level: ArcadeLevel): { readonly bolt: number; readonly arrow: number; readonly defender: number; readonly boss: number } {
  const index = (kind: string): number => level.bodies.findIndex((body) => body.kind === kind && body.template === true);
  const enemies = level.bodies.flatMap((body, at) => (body.role === 'chaser' ? [at] : []));
  return { bolt: index('bolt'), arrow: index('arrow'), defender: index('defender'), boss: enemies.at(-1) ?? -1 };
}

/** Nepřátelé zpět z hotové úrovně (pořadí těl). */
export function marchOf(level: ArcadeLevel): March[] {
  return level.bodies.flatMap((body): March[] => {
    if (body.role !== 'chaser') return [];
    const speed = -(body.vz ?? 0);
    return [{ enter: speed > 0 ? (body.z - DEFENSE.far) / speed : -1, lane: laneOfX(body.x), speed, hp: body.hp ?? 0, wave: -1, boss: body.w === DEFENSE.boss.w }];
  });
}

/** Bonusy událostí zpět z hotové úrovně (pořadí těl). */
export function bonusesOf(level: ArcadeLevel): Bonus[] {
  return level.bodies.flatMap((body): Bonus[] => {
    if (body.role !== 'collectible') return [];
    const speed = -(body.vz ?? 0);
    return [{ enter: speed > 0 ? (body.z - DEFENSE.far) / speed : -1, lane: laneOfX(body.x), speed, mark: body.hp ?? 0 }];
  });
}

/** Je bonus (role `collectible`) živý a v obraze – vyšel zpoza plotu a ještě nedošel k hradbě? Scéna i ohlášení události. */
export const defenseInView = (state: Int32Array, body: number): boolean => {
  const base = bodyBase(body);
  if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.collectible) return false;
  const front = frontOf(state, body);
  return front > DEFENSE.wall && front <= DEFENSE.far + SHOWN_BEYOND;
};

/**
 * Stihne sám hrdina všechny? Každé HP je jedna rána luku (přebíjení `reload`), uvolněná, když robot
 * nepřítele uvidí, a splatná `margin` tiků před průlomem; rány jednotkové délky rozvrhuje EDF, který je
 * pro ně optimální. Vrací první nepřítele, kterého by hrdina nestihl, nebo −1.
 * simplified: robot rány plánuje podle nejdřívějšího průlomu, ne přesně jako EDF, a obránce nepočítá – rezervu dává jejich palba.
 */
export function firstOverrun(march: readonly March[], reaction = DEFENSE_BOT_REACTION): number {
  const jobs = march.flatMap((step, index) => Array.from({ length: step.hp }, () => ({ index, release: step.enter + reaction + 1, deadline: breachOf(step) - DEFENSE.margin })));
  jobs.sort((a, b) => a.release - b.release || a.deadline - b.deadline);
  const ready: (typeof jobs)[number][] = [];
  let next = 0;
  let tick = 0;
  while (next < jobs.length || ready.length > 0) {
    if (ready.length === 0) tick = Math.max(tick, (jobs[next] as (typeof jobs)[number]).release);
    while (next < jobs.length && (jobs[next] as (typeof jobs)[number]).release <= tick) ready.push(jobs[next++] as (typeof jobs)[number]);
    ready.sort((a, b) => a.deadline - b.deadline);
    const job = ready.shift() as (typeof jobs)[number];
    if (tick > job.deadline) return job.index;
    tick += DEFENSE.reload;
  }
  return -1;
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou úrovní; prázdné pole = hratelná. */
export function checkDefenseLevel(level: ArcadeLevel, params: DefenseParams): string[] {
  const issues: string[] = [];
  const march = marchOf(level);
  if (march.length !== params.enemies) issues.push(`${march.length} enemies march, the waves promise ${params.enemies}`);
  const bosses = march.filter((step) => step.boss);
  if (bosses.length !== 1 || march.at(-1)?.boss !== true) issues.push('the last wave does not end with exactly one boss');
  level.bodies.filter((body) => body.role === 'chaser').forEach((body, order) => {
    const step = march[order] as March;
    if (body.kinematic !== true || step.speed <= 0 || !Number.isInteger(step.enter) || step.enter < 0 || body.x !== laneX(step.lane) || body.y !== 0 || (body.hp ?? 0) < 1) {
      issues.push(`enemy ${order + 1} does not march down a lane into view on a whole tick`);
    }
  });
  // V pruhu se nepřátelé nepřekrývají: pozdější nedoběhne dřívějšího, dokud jeden z nich neprolomí hradbu.
  for (let lane = 0; lane < LANES.count; lane += 1) {
    const here = march.filter((step) => step.lane === lane).sort((a, b) => a.enter - b.enter);
    here.forEach((later, index) => {
      for (const earlier of here.slice(0, index)) if (!keepsApart(earlier, later)) issues.push(`lane ${lane}: an enemy from tick ${later.enter} walks into the one from tick ${earlier.enter}`);
    });
  }
  // Bonus jde pruhem sám: po celé jeho okno v něm nejde nepřítel ani jiný bonus.
  const bonuses = bonusesOf(level);
  const windows = [...march.map((step) => ({ lane: step.lane, from: step.enter - 1, to: breachOf(step) })), ...bonuses.map((bonus) => ({ lane: bonus.lane, from: bonus.enter - 1, to: leaveOf(bonus) }))];
  bonuses.forEach((bonus, order) => {
    const own = windows[march.length + order] as (typeof windows)[number];
    if (bonus.speed <= 0 || !Number.isInteger(bonus.enter) || bonus.enter < 0) issues.push(`bonus ${order + 1} does not walk down a lane into view on a whole tick`);
    if (windows.some((other) => other !== own && other.lane === own.lane && other.from <= own.to && own.from <= other.to)) issues.push(`bonus ${order + 1} shares lane ${bonus.lane} with another target`);
  });
  const overrun = firstOverrun(march);
  if (overrun >= 0) issues.push(`enemy ${overrun + 1} reaches the wall before the hero alone could shoot it down`);
  const last = Math.max(0, ...march.map(breachOf));
  if (last >= ARCADE_LIMITS.maxTicks) issues.push('the boss reaches the wall past the 90 s horizon');
  if (level.bodies.length + (level.spawnSlots ?? 0) > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Tiky (stav `HEADER.tick` v kroku), kdy do obrazu vejde první nepřítel vln od druhé: čítač vlny se zvedne. */
function waveStarts(march: readonly March[]): number[] {
  const firsts: number[] = [];
  march.forEach((step, index) => {
    if (index > 0 && step.wave !== (march[index - 1] as March).wave) firsts.push(step.enter - 1);
  });
  return firsts;
}

/** Díly světa: ovládání pruhů, robot, úroveň a pravidla obrany. Bez životů ze specu hraje se třemi. */
export function defenseParts(seed: number, params: DefenseParams, health: number | undefined): ModeParts {
  const lives = health ?? START_LIVES;
  const level = defenseLevel(seed, params);
  const { bolt, arrow, defender, boss } = defenseTemplates(level);
  return {
    control: { id: 'lanes', params: {} },
    bot: { id: 'defense_bot', params: { bolt, arrow, defender } },
    level,
    rules: [
      { id: 'defense_shot', params: { bolt, arrow, defender, waves: waveStarts(defenseMarch(seed, params)) } },
      { id: 'defense_hit', params: { bolt, boss, points: DEFENSE.points, bossPoints: DEFENSE.bossPoints } },
      { id: 'defense_goal', params: {} },
      { id: 'out_of_health', params: {} },
      // Pilulka postupu HUD (`collectNeed`, kit `08-game-hud.md`) čte cíl z `finish_collected`: padlí nepřátelé z počtu vln. Tělo cíle svět nemá, nevystřelí.
      { id: 'finish_collected', params: { need: params.enemies } },
    ],
    issues: checkDefenseLevel(level, params),
    health: lives,
  };
}

export const laneDefense: ModeGeneratorPiece<DefenseParams> = {
  id: 'lane_defense',
  params: defenseParams,
  roles: ['player', 'chaser'],
  // Rezerva na bonusy událostí (P55 T5): série, zlaté cíle, spěch a série v přestávkách.
  cost: (params) => ({ bodies: 5 + params.enemies + DEFENSE.spawnSlots + 80, rules: 5 }),
  generate: (seed, params) => defenseLevel(seed, params),
  parts: defenseParts,
};

// ---------------------------------------------------------------------------
// Pravidla

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);

const shotParams = z
  .object({
    bolt: index,
    arrow: index,
    defender: index,
    /** Tiky, kdy čítač vlny (`WAVE_COUNTER`) stoupne o 1. */
    waves: z.array(z.int().min(0).max(ARCADE_LIMITS.maxTicks)).max(DEFENSE.waves),
  })
  .strict();

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const kindOf = (state: Int32Array, body: number): number => state[bodyBase(body) + BODY.kind] as number;

/** Živá těla druhu předlohy `template` (obránci, šípy). */
export function copiesOf(state: Int32Array, template: number): number[] {
  const kind = kindOf(state, template);
  const role = state[bodyBase(template) + BODY.role] as number;
  const found: number[] = [];
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    if (alive(state, body) && kindOf(state, body) === kind && state[bodyBase(body) + BODY.role] === role) found.push(body);
  }
  return found;
}

/** Živí nepřátelé v pruhu `lane` (role `chaser`). */
function marchersIn(state: Int32Array, lane: number): number[] {
  const found: number[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] === ROLE.chaser && alive(state, body) && laneOfX(state[base + BODY.x] as number) === lane) found.push(body);
  }
  return found;
}

/** Živé bonusy událostí v pruhu `lane`, které ještě nedošly k hradbě. */
function bonusesIn(state: Int32Array, lane: number): number[] {
  const found: number[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] === ROLE.collectible && alive(state, body) && laneOfX(state[base + BODY.x] as number) === lane && frontOf(state, body) > DEFENSE.wall) found.push(body);
  }
  return found;
}

/** Čelo nepřítele (z jeho strany ke hradbě). */
const frontOf = (state: Int32Array, body: number): number => (state[bodyBase(body) + BODY.z] as number) - (state[bodyBase(body) + BODY.d] as number) / 2;

/**
 * Střelba a stavba (tik): ťuk s nabitým lukem vystřelí šíp do pruhu ťuku, jinak luk přebíjí;
 * držení dlouhé právě `hold` tiků postaví obránce v pruhu, kde ještě žádný nestojí. Obránce
 * vystřelí ve svém taktu, je-li v pruhu nepřítel na dostřel. Začátek vlny zvedne čítač vlny.
 */
export const defenseShotRule: RulePiece<z.infer<typeof shotParams>> = {
  id: 'defense_shot',
  params: shotParams,
  roles: ['player', 'projectile'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const effects: ArcadeEffect[] = [];
    const tick = state[HEADER.tick] as number;
    const cooldown = state[HEADER.counters + COUNTER.cooldown] as number;
    const tap = tappedIn(state, player);
    if (tap !== null && cooldown === 0) {
      effects.push({ kind: 'spawn', template: params.bolt, x: laneX(tap), y: DEFENSE.bolt.y, z: DEFENSE.wall, vx: 0, vy: 0, vz: DEFENSE.bolt.speed });
      effects.push({ kind: 'count', counter: 'cooldown', amount: DEFENSE.reload - 1 });
    } else if (cooldown > 0) effects.push({ kind: 'count', counter: 'cooldown', amount: -1 });
    const defenders = copiesOf(state, params.defender);
    if (heldTicks(state, player) === DEFENSE.hold) {
      const lane = laneOf(state, player);
      if (!defenders.some((body) => laneOfX(state[bodyBase(body) + BODY.x] as number) === lane)) {
        effects.push({ kind: 'spawn', template: params.defender, x: laneX(lane), y: DEFENSE.castle.h, z: DEFENSE.wall - DEFENSE.castle.d / 2, vx: 0, vy: 0, vz: 0 });
      }
    }
    for (const body of defenders) {
      const lane = laneOfX(state[bodyBase(body) + BODY.x] as number);
      if ((tick + lane * DEFENSE.stagger) % DEFENSE.volley !== 0) continue;
      if (!marchersIn(state, lane).some((foe) => frontOf(state, foe) <= DEFENSE.wall + DEFENSE.reach)) continue;
      effects.push({ kind: 'spawn', template: params.arrow, x: laneX(lane), y: DEFENSE.arrow.y, z: DEFENSE.wall, vx: 0, vy: 0, vz: DEFENSE.arrow.speed });
    }
    if (params.waves.includes(tick)) effects.push({ kind: 'count', counter: WAVE_COUNTER, amount: 1 });
    return effects;
  },
};

const hitParams = z
  .object({
    /** Předloha šípu hrdiny: jen jeho zásah násobí kombo. */
    bolt: index,
    /** Boss (index těla): u hradby vezme všechny životy. */
    boss: index,
    points: z.int().min(1).max(100),
    bossPoints: z.int().min(1).max(500),
    /** Počítadlo komba (P46C T3, `withCombo`); bez něj body bez násobiče. */
    combo: index.optional(),
  })
  .strict();

/**
 * Zásah a průlom (tik): každý šíp ve vzduchu, jehož hrot dosáhl čela nejbližšího nepřítele v pruhu,
 * mu ubere HP (`hit`, útočník = šíp) a zmizí; nepřítel na nule padne – body (šíp hrdiny × kombo),
 * čítač `items`. Nepřítel, jehož čelo dosáhlo hradby, zmizí a vezme život, boss všechny.
 */
export const defenseHitRule: RulePiece<z.infer<typeof hitParams>> = {
  id: 'defense_hit',
  params: hitParams,
  roles: ['player', 'chaser', 'projectile'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const effects: ArcadeEffect[] = [];
    const count = state[HEADER.bodyCount] as number;
    const damage = new Map<number, number>();
    const taken = new Set<number>();
    const hp = (body: number): number => bodyHp(state, body) - (damage.get(body) ?? 0);
    for (let shot = state[HEADER.spawnBase] as number; shot < count; shot += 1) {
      const base = bodyBase(shot);
      if (!alive(state, shot) || state[base + BODY.role] !== ROLE.projectile) continue;
      const tip = (state[base + BODY.z] as number) + (state[base + BODY.d] as number) / 2;
      let foe = -1;
      for (const body of marchersIn(state, laneOfX(state[base + BODY.x] as number))) {
        if (hp(body) > 0 && frontOf(state, body) <= tip && (foe < 0 || (state[bodyBase(body) + BODY.z] as number) < (state[bodyBase(foe) + BODY.z] as number))) foe = body;
      }
      // Bonus události (P55 T5) padne jen šípu hrdiny, a to jen před hradbou: body × kombo, do cíle se nepočítá.
      const own = kindOf(state, shot) === kindOf(state, params.bolt);
      let bonus = -1;
      if (own) {
        for (const body of bonusesIn(state, laneOfX(state[base + BODY.x] as number))) {
          if (!taken.has(body) && frontOf(state, body) <= tip && (bonus < 0 || (state[bodyBase(body) + BODY.z] as number) < (state[bodyBase(bonus) + BODY.z] as number))) bonus = body;
        }
      }
      if (bonus >= 0 && (foe < 0 || (state[bodyBase(bonus) + BODY.z] as number) < (state[bodyBase(foe) + BODY.z] as number))) {
        taken.add(bonus);
        const multiplier = params.combo !== undefined ? nextMultiplier(state, params.combo) : 1;
        const points = params.points * (bodyHp(state, bonus) === EVENT_MARK.golden ? LANE_EVENTS.goldenPoints : 1);
        effects.push({ kind: 'despawn', body: shot }, { kind: 'despawn', body: bonus }, { kind: 'score', amount: points * multiplier });
        if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
        continue;
      }
      if (foe < 0) continue;
      damage.set(foe, (damage.get(foe) ?? 0) + 1);
      effects.push({ kind: 'hit', body: foe, by: shot, amount: 1 }, { kind: 'despawn', body: shot });
      if (hp(foe) > 0) continue;
      // Šíp hrdiny násobí kombem, šíp obránce dá holé body.
      const amount = foe === params.boss ? params.bossPoints : params.points;
      const multiplier = own && params.combo !== undefined ? nextMultiplier(state, params.combo) : 1;
      effects.push({ kind: 'despawn', body: foe }, { kind: 'count', counter: 'items', amount: 1 }, { kind: 'score', amount: amount * multiplier });
      if (own && params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
    }
    for (let body = 0; body < count; body += 1) {
      if (body === player || state[bodyBase(body) + BODY.role] !== ROLE.chaser || !alive(state, body) || hp(body) <= 0) continue;
      if (frontOf(state, body) > DEFENSE.wall) continue;
      const lives = state[HEADER.counters + COUNTER.health] as number;
      effects.push({ kind: 'damage', amount: body === params.boss ? Math.max(1, lives) : 1 }, { kind: 'despawn', body });
    }
    return effects;
  },
};

const noParams = z.object({}).strict();

/** Žádný nepřítel už nejde → výhra (průchod čítačů, po zásazích a průlomech tiku). */
export const defenseGoalRule: RulePiece<z.infer<typeof noParams>> = {
  id: 'defense_goal',
  params: noParams,
  roles: ['player'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }) => {
    for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
      if (state[bodyBase(body) + BODY.role] === ROLE.chaser && alive(state, body)) return [];
    }
    return [{ kind: 'win' }];
  },
};

export const DEFENSE_RULES = { defense_shot: defenseShotRule, defense_hit: defenseHitRule, defense_goal: defenseGoalRule } as const;
