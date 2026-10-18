/**
 * Hod (P25G, T4): ovládání tah-pusť, pravidlo odhozu, řešič hodu a generátor.
 *
 * Boční pohled po +z: hráč stojí v počátku a hází dopředu. Osa nastaví úhel
 * (−1000..1000 = 5°..85°, 0 = 45°), nahoru/dolů ho posune, držení (`HOLD`)
 * nabíjí sílu (1..`maxCharge` tiků), ťuk (`TAP`) = puštění. Ovládání mění
 * jen tělo hráče: `aux0` = úhel, `aux1` = nabití, v tiku puštění záporné
 * (−nabití). Míček vydá pravidlo `launch` efektem `spawn`; zbývající hody
 * jsou čítač `ammo`, rozestup hodů `cooldown`.
 *
 * Cíle: terč, koš na tyči, nebo věž z bloků (stohování jádra: sestřelený
 * blok zmizí, horní dopadnou). **Hratelné z konstrukce:** `solveThrow`
 * najde pro každý cíl (u věže pro každý blok shora dolů) úhel a sílu
 * v mezích, které ho v přesné simulaci letu jádra trefí jako první;
 * generátor cíl, pro který řešení není, přesune.
 */

import { z } from 'zod';

import { type CompileRng, createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeCounter,
  type ArcadeEffect,
  type ArcadeLevel,
  AXIS_MAX,
  AXIS_MIN,
  BODY,
  BUTTON,
  type BodyInit,
  COUNTER,
  type ControlPiece,
  FLAG,
  type GeneratorPiece,
  HEADER,
  PHYSICS_SUBSTEPS,
  type PieceRef,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
} from '../contract';
import { GRAVITY } from '../kernel';
import { bossBody } from './behaviours/boss';
import { PACING, TENSION_CURVE, intensityAt } from './pacing';
import { census } from './shots';
import { WAVE_PLAN } from './waves';

export const THROW_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type ThrowDifficulty = (typeof THROW_DIFFICULTIES)[number];
export const THROW_GOALS = ['target', 'hoop', 'tower'] as const;
export type ThrowGoal = (typeof THROW_GOALS)[number];
/** Popisek role `target` ve specu podle toho, co generátor postaví. */
export const THROW_GOAL_LABELS: Readonly<Record<ThrowGoal, string>> = { target: 'target', hoop: 'hoop', tower: 'block' };
/**
 * Co se z věty hází do koše a co na věž; čte je šablona návrhu (`draft/controls.ts`)
 * i žánr Hod. Bydlí tady, ne v návrhu – žánr jde do prohlížeče a návrh by s sebou
 * přitáhl schémata `spec.ts` (`arcade-bundle.test.ts`).
 */
export const HOOP_CUES = /\b(?:basketball|hoops?|free throws?|trash can|bin|bucket)\b/;
export const TOWER_CUES = /\b(?:angry birds|knock(?:s|ing)? (?:down|over)|towers?|boxes|bowling|pins|cans)\b/;

export const THROW = {
  /** Rychlost míčku při nejslabším a nejsilnějším hodu (jednotek za tik). */
  minSpeed: 150,
  maxSpeed: 450,
  /** Tiky držení do plné síly (1 s). */
  maxCharge: ARCADE_HZ,
  /** Úhel: osa 0 = 45°, ±1000 = ±40°. */
  baseDeg: 45,
  spanDeg: 40,
  aimStep: 40,
  /** Odkud míček vyletí (spodní stěna, přední hrana hráče). */
  launchY: 1500,
  launchZ: 400,
  ballSize: 400,
  ballLifetime: 5 * ARCADE_HZ,
  /** Tiky mezi dvěma hody. */
  cooldown: 30,
  playerW: 600,
  playerH: 1700,
  playerD: 600,
  blockSize: 800,
} as const;

/** Rychlost hodu pro nabití `charge` (sevřené do 1..maxCharge). */
export function throwSpeed(charge: number): number {
  const c = Math.max(1, Math.min(THROW.maxCharge, charge));
  return THROW.minSpeed + Math.trunc(((THROW.maxSpeed - THROW.minSpeed) * c) / THROW.maxCharge);
}

const angleOf = (aim: number): number => ((THROW.baseDeg + (aim * THROW.spanDeg) / AXIS_MAX) * Math.PI) / 180;

/** Rychlost míčku (nahoru, vpřed) pro úhel `aim` a nabití `charge`. */
export function launchVelocity(aim: number, charge: number): { vy: number; vz: number } {
  const speed = throwSpeed(charge);
  const angle = angleOf(aim);
  return { vy: Math.trunc(speed * Math.sin(angle)), vz: Math.trunc(speed * Math.cos(angle)) };
}

/**
 * `swing` (průběh P45C T14) = amplituda kyvu bonusových terčů: terč kola, který přišel efektem `spawn`
 * (jádro mu vynuluje `aux1`), dostane od ovládání periodu kyvadla ze své rychlosti (`swingPeriod`).
 * `dive` (P51 T6, `THROW_DIVE`) = předloha útočníků, rychlost snášení (záporná), výška plížení, dosah a okno
 * plížení v tikách: čekající útočníky ovládání pošle na hráče (`startDives`).
 */
const controlParams = z
  .object({
    swing: z.int().min(UNIT).max(10 * UNIT).optional(),
    dive: z.object({ template: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), drop: z.int().max(-1), low: z.int().min(0), reach: z.int().min(0), window: z.int().min(1).max(ARCADE_LIMITS.maxTicks) }).strict().optional(),
  })
  .strict();

/** Živé tělo s podpisem předlohy `template` (role, model, rozměry) – útočník hodu. */
function sameKind(state: Int32Array, body: number, template: number): boolean {
  const a = bodyBase(body);
  const b = bodyBase(template);
  return body !== template && ((state[a + BODY.flags] as number) & FLAG.alive) !== 0 && [BODY.role, BODY.kind, BODY.w, BODY.h, BODY.d].every((slot) => state[a + slot] === state[b + slot]);
}

/**
 * Útočníci (`THROW_DIVE`) čekají vysoko nad polem (`throw_rounds` je vysadí stojící nad každým obloukem hodu), dokud
 * stojí nějaký cíl kola; pak se nejbližší snese (`drop` za tik) do výšky `low` a odtud se plíží na hráče – tak, aby na
 * `reach` od hráče došel za `window` tiků od přistání, ať přistane kdekoli. Další se snese v tiku, kdy předchozí
 * dosedne, pokud se už neplíží žádný dřívější – nejvýš dva naráz. Kolo tak končí náletem, ne čekáním.
 */
function startDives(state: Int32Array, dive: { readonly template: number; readonly drop: number; readonly low: number; readonly reach: number; readonly window: number }): void {
  const count = state[HEADER.bodyCount] as number;
  let next = -1;
  let dropping = false;
  let creeping = false;
  let targets = false;
  for (let i = 0; i < count; i += 1) {
    const b = bodyBase(i);
    if (((state[b + BODY.flags] as number) & FLAG.alive) !== 0 && state[b + BODY.role] === ROLE.target) targets = true;
    if (!sameKind(state, i, dive.template)) continue;
    const y = state[b + BODY.y] as number;
    if ((state[b + BODY.vy] as number) < 0 && y <= dive.low) {
      // Dosedl přesně na `low`: plíží se vpřed na hráče (a další se může snést).
      state[b + BODY.vy] = 0;
      state[b + BODY.vz] = -Math.max(1, Math.ceil(((state[b + BODY.z] as number) - dive.reach) / dive.window));
    } else if ((state[b + BODY.vy] as number) < 0) {
      state[b + BODY.vy] = Math.max(dive.drop, dive.low - y);
      dropping = true;
    } else if (state[b + BODY.vz] !== 0) creeping = true;
    else if (next < 0 || (state[b + BODY.z] as number) < (state[bodyBase(next) + BODY.z] as number)) next = i;
  }
  if (!targets && !dropping && !creeping && next >= 0) state[bodyBase(next) + BODY.vy] = dive.drop;
}

/** Tiky jednoho kyvu bonusového terče (sudé): za tolik tiků přejede z kraje na kraj. */
export const swingPeriod = (speed: number, amplitude: number): number => 2 * Math.round(amplitude / speed);

/** Živé kinematické terče (i terč-boss role nepřítele, P47A T7) s rychlostí a bez periody (právě přišly) dostanou periodu kyvu. */
function startSwings(state: Int32Array, amplitude: number): void {
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    const b = bodyBase(i);
    const flags = state[b + BODY.flags] as number;
    const role = state[b + BODY.role];
    if ((flags & FLAG.alive) === 0 || (flags & FLAG.kinematic) === 0 || (role !== ROLE.target && role !== ROLE.enemy)) continue;
    const vx = state[b + BODY.vx] as number;
    if (vx !== 0 && state[b + BODY.aux1] === 0) state[b + BODY.aux1] = swingPeriod(Math.abs(vx), amplitude);
  }
}

/** Ovládání: hráč stojí, osa/nahoru/dolů = úhel, držení nabíjí, ťuk pustí. */
export const throwControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'throw',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    if (params.swing !== undefined) startSwings(state, params.swing);
    if (params.dive !== undefined) startDives(state, params.dive);
    const base = bodyBase(player);
    state[base + BODY.vx] = 0;
    state[base + BODY.vz] = 0;
    let aim = state[base + BODY.aux0] as number;
    if (input.axis !== 0) aim = input.axis;
    if ((input.buttons & BUTTON.UP) !== 0) aim += THROW.aimStep;
    if ((input.buttons & BUTTON.DOWN) !== 0) aim -= THROW.aimStep;
    state[base + BODY.aux0] = Math.max(AXIS_MIN, Math.min(AXIS_MAX, aim));
    // Minulý tik byl puštění: nabíjení začíná znovu.
    let charge = Math.max(0, state[base + BODY.aux1] as number);
    if ((input.buttons & BUTTON.HOLD) !== 0) charge = Math.min(THROW.maxCharge, charge + 1);
    state[base + BODY.aux1] = (input.buttons & BUTTON.TAP) !== 0 ? -Math.max(1, charge) : charge;
  },
};

const launchParams = z.object({ template: z.int().min(0) }).strict();

/** Puštění → míček z ruky hráče, hod ubere, rozestup hodů. Puštění v rozestupu se zahodí. */
export const launch: RulePiece<z.infer<typeof launchParams>> = {
  id: 'launch',
  params: launchParams,
  roles: ['player', 'projectile'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const cooldown = state[HEADER.counters + COUNTER.cooldown] as number;
    if (cooldown > 0) return [{ kind: 'count', counter: 'cooldown', amount: -1 }];
    const base = bodyBase(player);
    const released = state[base + BODY.aux1] as number;
    if (released >= 0 || (state[HEADER.counters + COUNTER.ammo] as number) <= 0) return [];
    const { vy, vz } = launchVelocity(state[base + BODY.aux0] as number, -released);
    const effects: ArcadeEffect[] = [
      { kind: 'count', counter: 'ammo', amount: -1 },
      { kind: 'count', counter: 'cooldown', amount: THROW.cooldown },
      { kind: 'spawn', template: params.template, x: state[base + BODY.x] as number, y: THROW.launchY, z: (state[base + BODY.z] as number) + THROW.launchZ, vx: 0, vy, vz },
    ];
    return effects;
  },
};

// ---------------------------------------------------------------------------
// Řešič hodu

/** Tělo, které může míček zastavit: terč, nepřítel, nebo pevné. */
export interface ThrowBox {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

export interface ThrowPlan {
  readonly aim: number;
  readonly charge: number;
}

/**
 * Let míčku přesně jako v jádře (gravitace, pak posun, zásah proti obalu
 * dráhy za tik v pořadí indexů, dopad na zem = konec; odraz se nepočítá).
 * Vrací index prvního zasaženého těla, nebo −1.
 */
export function simulateThrow(boxes: readonly ThrowBox[], plan: ThrowPlan, physics = false): number {
  const { vz } = launchVelocity(plan.aim, plan.charge);
  const s = THROW.ballSize;
  for (const { y, z, vy } of throwFlight(plan, physics)) {
    const bottom = Math.min(y, y - vy);
    const top = Math.max(y, y - vy) + s;
    for (const box of boxes) {
      if (Math.abs(2 * z - vz - 2 * box.z) < s + Math.abs(vz) + box.d && Math.abs(-2 * box.x) < s + box.w && bottom < box.y + box.h && box.y < top) return box.index;
    }
  }
  return -1;
}

/** Bod letu po tiku: spodek míčku, poloha vpřed, svislá rychlost. */
export interface FlightPoint {
  readonly y: number;
  readonly z: number;
  readonly vy: number;
}

/**
 * Let míčku od hodu po tik, ve kterém spodek dosáhne země (včetně), nebo do
 * konce života. Jádro: semi-implicitní Euler v celých číslech. `physics`
 * (P29A): míč v Rapieru, jehož `PHYSICS_SUBSTEPS` podkroků ubere poloze za tik
 * jen `g·(k+1)/(2k)` – do dopadu se od téhle dráhy liší nejvýš o jednotku.
 */
export function throwFlight(plan: ThrowPlan, physics = false): FlightPoint[] {
  let { vy } = launchVelocity(plan.aim, plan.charge);
  const { vz } = launchVelocity(plan.aim, plan.charge);
  const lag = physics ? (GRAVITY * (PHYSICS_SUBSTEPS - 1)) / (2 * PHYSICS_SUBSTEPS) : 0;
  let y = THROW.launchY;
  let z = THROW.launchZ;
  const points: FlightPoint[] = [];
  for (let n = 1; n < THROW.ballLifetime; n += 1) {
    vy -= GRAVITY;
    y += vy + lag;
    z += vz;
    points.push({ y: physics ? Math.round(y) : y, z, vy });
    if (y <= 0) break;
  }
  return points;
}

/** Nejmenší a největší osa, kterou řešič zkouší, a krok. */
const AIM_TRIES: { readonly from: number; readonly to: number; readonly step: number } = { from: -700, to: 900, step: 100 };

/**
 * Úhel a síla, které trefí tělo `target` jako první, nebo null. Pro každý
 * zkoušený úhel spočítá sílu z rovnice letu (diskrétní: y = vy·n − g·n(n+1)/2)
 * a ověří ji a dvě sousední nabití simulací – nejvýš 17 × 5 letů.
 */
export function solveThrow(boxes: readonly ThrowBox[], target: number): ThrowPlan | null {
  const box = boxes.find((b) => b.index === target);
  if (box === undefined) return null;
  const dz = box.z - THROW.launchZ;
  const dy = box.y + box.h / 2 - THROW.launchY - THROW.ballSize / 2;
  for (let aim = AIM_TRIES.from; aim <= AIM_TRIES.to; aim += AIM_TRIES.step) {
    const a = aim === 0 ? 1 : aim;
    const angle = angleOf(a);
    const rise = dz * Math.tan(angle) - dy;
    if (rise <= 0) continue;
    const ticks = (-1 + Math.sqrt(1 + (8 * rise) / GRAVITY)) / 2;
    const speed = dz / (ticks * Math.cos(angle));
    const charge = Math.round(((speed - THROW.minSpeed) * THROW.maxCharge) / (THROW.maxSpeed - THROW.minSpeed));
    for (const c of [charge, charge - 1, charge + 1, charge - 2, charge + 2]) {
      if (c < 1 || c > THROW.maxCharge) continue;
      if (simulateThrow(boxes, { aim: a, charge: c }) === target) return { aim: a, charge: c };
    }
  }
  return null;
}

/** Tělesa, která míček zastaví (pořadí = index jako v jádře). */
export function boxesOfLevel(bodies: readonly BodyInit[]): ThrowBox[] {
  const boxes: ThrowBox[] = [];
  bodies.forEach((body, index) => {
    if (index === 0 || body.template === true || body.role === 'projectile') return;
    if (body.role === 'target' || body.role === 'enemy' || body.solid) boxes.push({ index, x: body.x, y: body.y, z: body.z, w: body.w, h: body.h, d: body.d });
  });
  return boxes;
}

/** Totéž nad stavem: jen živá tělesa. */
export function boxesOfState(state: Int32Array, player: number): ThrowBox[] {
  const boxes: ThrowBox[] = [];
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const b = bodyBase(i);
    const flags = state[b + BODY.flags] as number;
    const role = state[b + BODY.role];
    if ((flags & FLAG.alive) === 0 || role === ROLE.projectile) continue;
    if (role !== ROLE.target && role !== ROLE.enemy && (flags & FLAG.solid) === 0) continue;
    boxes.push({ index: i, x: state[b + BODY.x] as number, y: state[b + BODY.y] as number, z: state[b + BODY.z] as number, w: state[b + BODY.w] as number, h: state[b + BODY.h] as number, d: state[b + BODY.d] as number });
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  readonly goals: number;
  readonly towerHeight: number;
  /** Zeď mezi hráčem a cíli, přes kterou se musí házet obloukem. */
  readonly wall: boolean;
  readonly near: number;
  readonly far: number;
  readonly spareThrows: number;
}

const TIERS: Readonly<Record<ThrowDifficulty, Tier>> = {
  easy: { goals: 2, towerHeight: 2, wall: false, near: 7 * UNIT, far: 15 * UNIT, spareThrows: 3 },
  normal: { goals: 3, towerHeight: 3, wall: false, near: 8 * UNIT, far: 19 * UNIT, spareThrows: 3 },
  hard: { goals: 3, towerHeight: 4, wall: true, near: 10 * UNIT, far: 22 * UNIT, spareThrows: 2 },
};

export const THROW_FIELD = {
  wallZ: [5 * UNIT, 7 * UNIT] as const,
  wallH: [2500, 3500] as const,
  /** Pokusů o umístění jednoho cíle, než generátor vezme nejbližší řešitelnou polohu. */
  placeTries: 12,
} as const;

const generatorParams = z
  .object({
    difficulty: z.enum(THROW_DIFFICULTIES).default('normal'),
    /** Co se trefuje; bez hodnoty podle semínka. */
    goal: z.enum(THROW_GOALS).optional(),
    /** Míček skáče (koš, míč); bez hodnoty jen u koše. */
    bounce: z.boolean().optional(),
    /** Hodů navíc nad počet cílů; bez hodnoty podle obtížnosti. */
    spareThrows: z.int().min(0).max(10).optional(),
    /**
     * Kola (P36A F5): odhad robota na celou hru v sekundách; kol tolik, kolik
     * se do něj vejde, aspoň jedno. Bez hodnoty jedno pole jako dřív.
     */
    budget: z.int().min(1).max(90).optional(),
    /** Opt-in ratio of the visible clock to the original work budget; read by arcade compilation. */
    paceBudgetPct: z.int().min(50).max(100).optional(),
    /** Průběh P45C T14 (píše ho jen průběh, ne spec): v každém kole pohyblivý bonusový terč (`THROW_SWING`). */
    swing: z.literal(true).optional(),
    /** Průběh P47A T7 (jen `genre.v4`): bonusový terč posledního kola je terč-boss (`THROW_BOSS`). Jen se `swing`. */
    boss: z.literal(true).optional(),
    /** Průběh P51 T6 (jen `genre.v5`): do posledních kol přiletí útočníci (`THROW_DIVE`). Jen s koly. */
    dive: z.literal(true).optional(),
  })
  .strict();
export type ThrowParams = z.infer<typeof generatorParams>;

/** Hodiny, které jádro opravdu hlídá (`limitSeconds` v `arcade/compile.ts`): 10 s až horizont ověření. */
const clockSeconds = (seconds: number): number => Math.min(ARCADE_LIMITS.maxTicks / ARCADE_HZ, Math.max(10, seconds));

/**
 * Rozpočet kol pro hodiny specu (P36A F5): kola se vejdou do hodin s prohrou, ne do delšího rozpočtu
 * (remix, který zkrátí jen hodiny). `paceBudgetPct` drží rozpočet práce, hodiny jsou kratší.
 */
export function throwParamsFor(params: ThrowParams, clock: { readonly seconds: number; readonly onEnd: string } | undefined): ThrowParams {
  if (params.budget === undefined || clock?.onEnd !== 'lose') return params;
  return { ...params, budget: Math.min(params.budget, throwBudgetIn(clockSeconds(params.paceBudgetPct === undefined ? clock.seconds : Math.ceil((clock.seconds * 100) / params.paceBudgetPct)))) };
}

/**
 * Pohyblivý bonusový terč (P45C T14, `swing`): v každém kole visí za jeho cíli terč, který přejíždí čáru
 * hodu kyvadlem jádra (±`amplitude`); rychlost kola jde s křivkou napětí od `speed[0]` (úvod) po `speed[1]`
 * (finále). Kolo končí, až padne i on, takže bonusový terč posledního kola je poslední krok k výhře –
 * finále. `seconds` = odhad robota na něj (hod a čekání, až terč přejede čáru) do rozpočtu kol.
 */
export const THROW_SWING = {
  body: { w: 1000, h: 1000, d: 300 },
  amplitude: 3 * UNIT,
  speed: [30, 105] as const,
  /** Za nejvzdálenějším cílem kola o tolik dál; spodní hrana z `lifts` – první místo, kam hod doletí, když cíle kola padly. */
  behind: [2 * UNIT, 3 * UNIT, UNIT] as const,
  lifts: [1800, 3000, 600, 4200] as const,
  seconds: 2,
} as const;

/**
 * Terč-boss hodu (P47A T7, parametr `boss`): poslední kolo nese místo bonusového terče a `hp` nejvyšších cílů
 * nepřítele `bossBody` bonusového terče (9/4 rozměrů, `kind` `boss`) s `hp` HP, který se kýve rychlostí
 * posledního kola – zásah míčem ubere 1 HP (`shot_hit.tough`), poslední HP ho sebere a kolo i výhra čekají na
 * jeho pád. Hodů kola o `hp` na bosse víc než za odebrané cíle a bonusový terč, a navíc `reserve`, aby náboje
 * nebyly útes (vzor `SHOOTER_FOES.bossAmmo`). Kolo bosse trvá jako kolo, které nahradilo (tři hody na kývající
 * se terč ~2,4 s proti třem cílům a bonusovému terči), takže rozpočet kol ani hodiny se nemění: boss navíc
 * ke všem cílům kola prohrál buňce `throw.default` na hodiny 52 s (intermediate 15/20), o kolo kratší hra
 * s ním dala začátečníkovi 20/20.
 */
export const THROW_BOSS = { hp: 3, reserve: 2 } as const;

/**
 * Útočníci hodu (P51 T6, jen nová hra `genre.v5`, parametr `dive`): do posledních kol přiletí s jejich začátkem
 * útočníci – `counts[0]` do posledního, `counts[1]` do předposledního. Čekají v řadě nad polem blízko hráče
 * (`from`, každý další o `gap` dál) ve výšce `wait` – nad vrcholem každého oblouku hodu (plný hod pod 45° vrcholí
 * ~7,8 m), takže hodům na cíle nepřekážejí. Až padne poslední cíl kola, snese se nejbližší (`drop` za tik) do výšky
 * `low` a odtud se plíží na hráče tak, aby na `reach` od hráče došel za `window` tiků od přistání; jakmile dosedne,
 * snáší se další, pokud se už neplíží žádný dřívější (`startDives`). Role nepřítele: míček je sestřelí (bod) a kolo
 * na ně čeká jako na cíle. Kdo se doplíží na `reach`, vezme hráči `steal` hodů (nejvýš, co má) a zmizí – nechat
 * ho doplížit je dražší než ho sestřelit, a hody došly = prohra. Kolo s útočníky má za každého `throws` hodů navíc
 * a jejich odhad (`seconds` za útočníka) jde do rozpočtu kol: o tolik posledních kol míň, kolik přetáhne (hodiny
 * zůstávají; křivka rychlostí kyvu jde dál přes kola před úbytkem, `buildField`). Blízký útočník padne krátkým
 * hodem, takže konec kola zhoustne (telemetrie `rising`).
 *
 * Změřeno na buňce `throw.default` (12 semínek, intermediate / novice / `rising`; bez útočníků 12 / 6 / 0, hodiny
 * 52 s, dlouhá semínka 46–48 s, začátečník je přetáhne):
 * - útočníci s kolem rovnou na hráče (24 m, 1 m/s): 5 / 5 / 0 – útočník stál robota ~1,9 s a dal 2–3 události, konec
 *   nezhoustl a dlouhé hry přetáhly 52 s; přílet z dálky až po vyčištění kola: 5 / 5 / 0;
 * - snesení a plížení bez rozpočtu kol: 5 / 5 / 5; s rozpočtem (o kolo míň) a pomalým plížením: 12 / 12 / 12 –
 *   začátečník dostal kolo času navíc; plížení do pevného okna vždy jen jeden: novice 10 → 0 mezi 34 a 30 tiky;
 * - další se snese, když předchozí dosedne, 4 + 4 útočníci (`window` 42 / 46 / 50 / 54 / 60): intermediate
 *   5 / 12 / 12 / 12 / 12, novice 1 / 5 / 5 / 6 / 12, `rising` 12/12 od 46; dlouhá semínka intermediate 42,5–44,4 s.
 *   S 4 + 3 jedno semínko poměr 1,0 (`rising` 11/12), s 5 + 4 novice 0 / 5 / 5 při 46 / 50 / 54.
 */
export const THROW_DIVE = {
  body: { role: 'enemy', kind: 'enemy', x: 0, y: 0, z: 0, w: 1200, h: 900, d: 1200, solid: false, kinematic: true } as BodyInit,
  wait: 9000,
  low: 2400,
  from: 5 * UNIT,
  gap: 1500,
  drop: 400,
  window: 50,
  reach: 3 * UNIT,
  steal: 2,
  counts: [4, 4] as readonly number[],
  seconds: 1,
  throws: 1,
} as const;

/** Bonusový terč na čáře hodu (`x` 0); místo mu dá `bonusOf`, kraj a rychlost `swingAt`. */
const BONUS: BodyInit = { role: 'target', kind: 'target', x: 0, y: 0, z: 0, ...THROW_SWING.body, solid: false, kinematic: true };

/** Rychlost bonusového terče při intenzitě `intensity` (‰): úvod 700 → `speed[0]`, finále 1500 → `speed[1]`. */
export function swingSpeed(intensity: number): number {
  const [slow, fast] = THROW_SWING.speed;
  const share = Math.max(0, Math.min(PACING.intensity.finale - PACING.intensity.intro, intensity - PACING.intensity.intro));
  return slow + Math.floor(((fast - slow) * share) / (PACING.intensity.finale - PACING.intensity.intro));
}

/**
 * Bonusový terč za cíli kola (těla `from..`): první místo z `behind` × `lifts`, kam ho hod trefí, když cíle kola
 * padly a stojí jen opěry, zeď a tyče. Stojí na čáře hodu (`x` 0) – kraj a rychlost mu dá až `swingAt`. `null` = nikam.
 * `shape` = tělo terče (terč-boss posledního kola, `THROW_BOSS`).
 */
function bonusOf(bodies: readonly BodyInit[], from: number, shape: BodyInit = BONUS): BodyInit | null {
  const far = Math.max(...bodies.slice(from).map((body) => body.z + body.d / 2));
  const standing = bodies.map((body, index) => (index >= from && body.role === 'target' ? { ...body, template: true } : body));
  for (const behind of THROW_SWING.behind) {
    for (const lift of THROW_SWING.lifts) {
      const bonus: BodyInit = { ...shape, y: lift, z: far + behind };
      if (solveThrow(boxesOfLevel([...standing, bonus]), standing.length) !== null) return bonus;
    }
  }
  return null;
}

/** Bonusový terč na kraji kyvu rychlosti `speed` (strana podle kola), mířící přes čáru hodu. */
function swingAt(bonus: BodyInit, speed: number, round: number): BodyInit {
  const side = round % 2 === 0 ? -1 : 1;
  const period = swingPeriod(speed, THROW_SWING.amplitude);
  return { ...bonus, x: (side * period * speed) / 2, vx: -side * speed, period };
}

/**
 * Kola hodu (P36A F5): po vyčištění pole přijdou nové cíle, výhra až
 * v posledním. Každé další kolo je těžší – pás cílů o `shift` dál (nejvýš
 * `farMax`), věž o blok vyšší každé druhé kolo (nejvýš `towerMax`) a hodů
 * navíc o jeden méně každé druhé kolo (nejméně `spareMin`). Odhad robota na
 * kolo: `perRound + perThrow × cíle kola` (sonda F5, 6 semínek, rozpočet 48:
 * terč 8 kol 40–41 s, koš 8 kol 43–45 s, věž 2–3 kola 40–47 s; 18 vět žánru
 * Hod 40,6–47,7 s).
 */
export const THROW_ROUNDS = {
  max: 12,
  shift: UNIT,
  farMax: 24 * UNIT,
  towerMax: 4,
  spareMin: 1,
  perRound: 1,
  perThrow: 1.5,
} as const;

/**
 * Číslo kola (0 = první) v čítači `trigger`: ten plní jen doplněk `+shoot`
 * (hod doplňky nebere, `CAPABILITIES.throw`) a záznam držení pravidla
 * `interact` (hráč hodu stojí daleko od všech cílů). Hody drží `ammo`.
 */
export const THROW_ROUND_COUNTER = 'trigger' satisfies ArcadeCounter;

/** Odhad robota na kolo s `targets` těly k sestřelení (s). */
export const throwRoundSeconds = (targets: number): number => THROW_ROUNDS.perRound + THROW_ROUNDS.perThrow * targets;

/** Rozpočet robota, který se vejde do hodin `seconds` (hodiny = rozpočet × faktor + rezerva jako hodiny úkolu), aspoň 1 s. */
export const throwBudgetIn = (seconds: number): number => Math.max(1, Math.floor((seconds - WAVE_PLAN.clockMargin) / WAVE_PLAN.clockFactor));

const player: BodyInit = { role: 'player', kind: 'thrower', x: 0, y: 0, z: 0, w: THROW.playerW, h: THROW.playerH, d: THROW.playerD, solid: false };

/** Tyč koše stojí o tolik za obroučkou; podstavec terče pod ním na stejném `z`. */
const POLE_BEHIND = 700;

/** Těla jednoho cíle na hloubce `z`: terč, koš na tyči, nebo věž. */
function goalBodies(goal: ThrowGoal, z: number, height: number, lift: number): BodyInit[] {
  if (goal === 'target') {
    const target: BodyInit = { role: 'target', kind: 'target', x: 0, y: lift, z, w: 1200, h: 1200, d: 300, solid: false };
    return lift === 0 ? [target] : [{ role: 'obstacle', kind: 'wood-block', x: 0, y: 0, z, w: 1200, h: lift, d: 1200, solid: true }, target];
  }
  if (goal === 'hoop') {
    // Obroučka na tyči; tyč stojí za ní a je pevná (odraz od desky = konec hodu).
    const rim = 2600 + lift;
    return [
      { role: 'target', kind: 'hoop', x: 0, y: rim, z, w: 900, h: 250, d: 900, solid: false },
      { role: 'obstacle', kind: 'pole', x: 0, y: 0, z: z + POLE_BEHIND, w: 300, h: rim + 900, d: 300, solid: true },
    ];
  }
  return Array.from({ length: height }, (_, k): BodyInit => ({ role: 'target', kind: 'wood-block', x: 0, y: k * THROW.blockSize, z, w: THROW.blockSize, h: THROW.blockSize, d: THROW.blockSize, solid: true, gravity: true }));
}

/** Pořadí, ve kterém se cíl dá sestřelit: věž shora dolů, jinak cíl sám. */
function hitOrder(bodies: readonly BodyInit[], from: number, to: number): number[] {
  const targets: number[] = [];
  for (let i = from; i < to; i += 1) if (bodies[i]?.role === 'target') targets.push(i);
  return targets.sort((a, b) => (bodies[b]?.y ?? 0) - (bodies[a]?.y ?? 0));
}

/** Jde cíl (těla `from..to`) sestřelit celý, když ostatní cíle stojí? Věž shora dolů, bez dopadu. */
function solvable(bodies: readonly BodyInit[], from: number, to: number): boolean {
  const removed = new Set<number>();
  for (const target of hitOrder(bodies, from, to)) {
    const boxes = boxesOfLevel(bodies).filter((box) => !removed.has(box.index));
    if (solveThrow(boxes, target) === null) return false;
    removed.add(target);
  }
  return true;
}

/**
 * Cíle jednoho pole od nejvzdálenějšího: bližší cíl se pak ověřuje s tím
 * vzdálenějším na místě. Pás cílů posunutý o `shift` dál, věž `height` bloků,
 * terč a koš zvednuté o 0 až `lifts` × 600.
 */
function placeGoals(rng: CompileRng, bodies: BodyInit[], goal: ThrowGoal, tier: Tier, shift: number, height: number, lifts = 2): void {
  const near = tier.near + shift;
  const band = Math.floor((tier.far - tier.near) / tier.goals);
  for (let g = tier.goals - 1; g >= 0; g -= 1) {
    const from = bodies.length;
    let placed = false;
    for (let attempt = 0; attempt < THROW_FIELD.placeTries && !placed; attempt += 1) {
      const z = near + g * band + rng.int(0, band - 1500);
      const lift = goal === 'tower' ? 0 : rng.int(0, lifts) * 600;
      bodies.push(...goalBodies(goal, z, height, lift));
      if (solvable(bodies, from, bodies.length)) placed = true;
      else bodies.length = from;
    }
    // Nic nesedlo: nejnižší cíl na začátku pásu (tam řešení je vždy, zkontroluje test).
    if (!placed) bodies.push(...goalBodies(goal, near + g * band, 1, 0));
  }
}

const targetsIn = (bodies: readonly BodyInit[]): number => bodies.filter((body) => body.role === 'target' && body.template !== true).length;

/** Podstavec kopií kol: díl 600 vysoký, vyšší podstavec je víc dílů na sobě. */
const LIFT_STEP = 600;

/**
 * Tvar kopie musí být u druhu a role vždy týž: scéna slot, který spawn
 * přepíše týmž druhem a rolí, nepřekreslí (`bodiesStale`). Podstavec terče
 * proto jde po dílech `LIFT_STEP` (srážka i řešič vidí totéž), koš v dalších
 * kolech stojí na zemi (tyč jedné výšky).
 */
const inSteps = (body: BodyInit): BodyInit[] =>
  body.role === 'obstacle' && body.kind === 'wood-block' && body.h > LIFT_STEP
    ? Array.from({ length: body.h / LIFT_STEP }, (_, k) => ({ ...body, y: body.y + k * LIFT_STEP, h: LIFT_STEP }))
    : [body];

const roundBody = z.int().min(0).max(ARCADE_LIMITS.maxBodies - 1);

const roundsParams = z
  .object({
    /** Kola od druhého: těla (předloha, x, y, z po čtveřicích) a hody kola. */
    rounds: z
      .array(
        z
          .object({
            bodies: z.array(z.int()).max(4 * 16),
            throws: z.int().min(1).max(30),
            /** Bonusový terč kola (P45C T14): předloha, x, y, z a rychlost kyvu `vx` – periodu mu dá ovládání (`swing`). */
            swing: z.tuple([roundBody, z.int(), z.int(), z.int(), z.int()]).optional(),
            /** Útočníků kola (P51 T6, `dive`): od jeho začátku čekají v řadě nad polem. */
            dives: z.int().min(1).max(6).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(THROW_ROUNDS.max - 1),
    /** Předlohy opěr (tyč koše, podstavec terče): živá překážka jejich druhu s koncem kola zmizí. */
    supports: z.array(roundBody).max(4),
    /** Útočníci (P51 T6, `THROW_DIVE`): předloha, výška, kde čeká první a o kolik dál další, kde už berou hody a kolik. */
    dive: z.object({ template: roundBody, y: z.int().min(0), from: z.int().min(1), gap: z.int().min(0), reach: z.int().min(0), steal: z.int().min(1).max(10) }).strict().optional(),
  })
  .strict();
export type ThrowRoundsParams = z.infer<typeof roundsParams>;

interface ThrowBuild {
  readonly level: ArcadeLevel;
  /** Kola od druhého; `null` = jedno pole jako dřív. */
  readonly rounds: ThrowRoundsParams | null;
  /** Předloha terče-bosse posledního kola (`THROW_BOSS`); bez něj chybí. */
  readonly tough?: number;
}

/** Útočníků kola `index` z `count` kol od druhého (`THROW_DIVE.counts` od posledního); jen s `dive`. */
const divesAt = (index: number, count: number): number => THROW_DIVE.counts[count - 1 - index] ?? 0;

/**
 * Pole hodu a jeho kola. Bez `budget` přesně dřívější pole (stejné losy).
 * S ním další kola, dokud odhad robota na celou hru nepřetáhne rozpočet:
 * kolo se postaví na prázdném poli (hráč, míček, zeď – opěry předchozího kola
 * zmizí), jeho těla přijdou kopiemi předloh (jedna na tvar, za těly úrovně).
 */
function buildField(seed: number, params: ThrowParams): ThrowBuild {
  const rng = createCompileRng(seed);
  const tier = TIERS[params.difficulty];
  const goal = params.goal ?? rng.pick(THROW_GOALS);
  const bounce = params.bounce ?? goal === 'hoop';
  const bodies: BodyInit[] = [
    player,
    { role: 'projectile', kind: 'ball', x: 0, y: 0, z: 0, w: THROW.ballSize, h: THROW.ballSize, d: THROW.ballSize, solid: false, template: true, gravity: true, lifetime: THROW.ballLifetime, bounce: bounce ? 450 : 0 },
  ];
  if (tier.wall) {
    const wallH = rng.int(THROW_FIELD.wallH[0], THROW_FIELD.wallH[1]);
    bodies.push({ role: 'obstacle', kind: 'wall', x: 0, y: 0, z: rng.int(THROW_FIELD.wallZ[0], THROW_FIELD.wallZ[1]), w: 4000, h: wallH, d: 400, solid: true });
  }
  const field = bodies.length;
  placeGoals(rng, bodies, goal, tier, 0, tier.towerHeight);
  // Bonusový terč (P45C T14) nebere los rozvržení: cíle kol zůstanou, kde by byly bez průběhu.
  const swing = params.swing === true && params.budget !== undefined;
  const goals = targetsIn(bodies);
  const firstBonus = swing ? bonusOf(bodies, field) : null;
  if (firstBonus !== null) bodies.push(firstBonus);
  const spare = params.spareThrows ?? tier.spareThrows;
  const throws = targetsIn(bodies) + spare;
  const single = (): ThrowBuild => ({ level: { bodies, length: 0, spawnSlots: 3, counters: { ammo: throws, reserve: 0 } }, rounds: null });
  if (params.budget === undefined) return single();

  // Další kola: jedna předloha na tvar, místa a hody kola do parametrů pravidla.
  const templates: BodyInit[] = [];
  const keys: string[] = [];
  const templateOf = (body: BodyInit): number => {
    const key = [body.role, body.kind, body.w, body.h, body.d, body.solid, body.gravity === true].join('|');
    let at = keys.indexOf(key);
    if (at < 0) {
      at = keys.push(key) - 1;
      templates.push({ ...body, x: 0, y: 0, z: 0, template: true });
    }
    return at;
  };
  const planned: { readonly bodies: readonly BodyInit[]; readonly throws: number; readonly bonus: BodyInit | null; readonly seconds: number }[] = [];
  const bonusSeconds = (bonus: BodyInit | null): number => (bonus === null ? 0 : THROW_SWING.seconds);
  let seconds = throwRoundSeconds(goals) + bonusSeconds(firstBonus);
  let widest = 0;
  for (let k = 1; k < THROW_ROUNDS.max; k += 1) {
    const scratch = bodies.slice(0, field);
    const shift = Math.min(k * THROW_ROUNDS.shift, Math.max(0, THROW_ROUNDS.farMax - tier.far));
    placeGoals(rng, scratch, goal, tier, shift, Math.min(THROW_ROUNDS.towerMax, tier.towerHeight + Math.floor(k / 2)), goal === 'hoop' ? 0 : 2);
    const bonus = swing ? bonusOf(scratch, field) : null;
    const round = scratch.slice(field).flatMap(inSteps);
    const own = throwRoundSeconds(targetsIn(round)) + bonusSeconds(bonus);
    if (seconds + own > params.budget) break;
    seconds += own;
    widest = Math.max(widest, round.length + (bonus === null ? 0 : 1));
    planned.push({ bodies: round, throws: targetsIn(round) + (bonus === null ? 0 : 1) + Math.max(THROW_ROUNDS.spareMin, spare - Math.ceil(k / 2)), bonus, seconds: own });
  }
  // Útočníci (P51 T6) jdou do rozpočtu kol: o tolik posledních kol míň, kolik jejich odhad přetáhne (jedno kolo zůstane).
  const diveSeconds = (count: number): number => (params.dive === true ? Array.from({ length: count }, (_, index) => divesAt(index, count)).reduce((sum, dives) => sum + dives, 0) * THROW_DIVE.seconds : 0);
  // Křivka rychlostí jde přes kola před úbytkem: kola, která zůstala, se kývou jako bez útočníků, boss rychlostí finále.
  const curveRounds = planned.length;
  while (planned.length > 1 && seconds + diveSeconds(planned.length) > params.budget) seconds -= planned.pop()!.seconds;
  if (planned.length === 0) return single();
  // Rychlost bonusového terče kola `k` z intenzity uprostřed kola: první kolo úvod, poslední finále.
  const speedOf = (k: number): number => swingSpeed(intensityAt(Math.floor(((2 * k + 1) * 500) / (curveRounds + 1)), TENSION_CURVE));
  const firstAt = bodies.length - 1;
  if (firstBonus !== null) bodies[firstAt] = swingAt(firstBonus, speedOf(0), 0);
  // Terč-boss (P47A T7) místo bonusového terče posledního kola, za cíli kola; bez místa zůstane kolo jak je.
  const final = planned.length - 1;
  const crowned = planned[final]!;
  const boss = params.boss === true && crowned.bonus !== null ? bonusOf([...bodies.slice(0, field), ...crowned.bodies], field, bossBody({ ...BONUS, role: 'enemy' }, THROW_BOSS.hp)) : null;
  let tough: number | undefined;
  const rounds = planned.map((round, index) => {
    const bossRound = boss !== null && index === final;
    // Kolo bosse bez `hp` nejvyšších cílů (věž shora): tři hody na bosse místo nich a bonusového terče.
    const dropped = bossRound ? new Set(hitOrder(round.bodies, 0, round.bodies.length).slice(0, THROW_BOSS.hp)) : new Set<number>();
    // …a bez jejich opěr (P47A T10): podstavec terče pod ním a tyč koše za ním by stály samy. Místo bosse se
    // hledalo s nimi (`bonusOf` bere jen přímý zásah), takže jeho hod platí i bez nich.
    const orphan = (body: BodyInit): boolean =>
      body.role === 'obstacle' && [...dropped].some((k) => round.bodies[k]!.x === body.x && body.z - round.bodies[k]!.z >= 0 && body.z - round.bodies[k]!.z <= POLE_BEHIND);
    const spawned = round.bodies.filter((body, k) => !dropped.has(k) && !orphan(body));
    // Útočníci kola (P51 T6): hod navíc za každého.
    const dives = params.dive === true ? divesAt(index, planned.length) : 0;
    const own = {
      bodies: spawned.flatMap((body) => [bodies.length + templateOf(body), body.x, body.y, body.z]),
      throws: round.throws + (bossRound ? THROW_BOSS.hp - dropped.size - 1 + THROW_BOSS.reserve : 0) + dives * THROW_DIVE.throws,
      ...(dives === 0 ? {} : { dives }),
    };
    const target = bossRound ? boss : round.bonus;
    if (target === null) return own;
    const bonus = swingAt(target, speedOf(index === final ? curveRounds : index + 1), index + 1);
    const template = bodies.length + templateOf(bonus);
    if (bossRound) tough = template;
    return { ...own, swing: [template, bonus.x, bonus.y, bonus.z, bonus.vx ?? 0] as [number, number, number, number, number] };
  });
  const supports = templates.flatMap((body, k) => (body.role === 'obstacle' ? [bodies.length + k] : []));
  // Předloha útočníků až za předlohami kol: indexy předloh, které kola znají ze `genre.v4`, se nehnou.
  const dive = params.dive === true ? { template: bodies.length + templateOf(THROW_DIVE.body), y: THROW_DIVE.wait, from: THROW_DIVE.from, gap: THROW_DIVE.gap, reach: THROW_DIVE.reach, steal: THROW_DIVE.steal } : undefined;
  const divers = Math.max(0, ...rounds.map((round) => round.dives ?? 0));
  return {
    level: { bodies: [...bodies, ...templates], length: 0, spawnSlots: 3 + widest + divers, counters: { ammo: throws, reserve: 0 } },
    rounds: { rounds, supports, ...(dive === undefined ? {} : { dive }) },
    ...(tough === undefined ? {} : { tough }),
  };
}

export const throwField: GeneratorPiece<ThrowParams> = {
  id: 'throw_field',
  params: generatorParams,
  roles: ['player', 'projectile', 'target', 'obstacle'],
  cost: (params) => ({ bodies: 3 + TIERS[params.difficulty].goals * Math.max(2, TIERS[params.difficulty].towerHeight) + 4, rules: 4 }),
  generate: (seed, params) => buildField(seed, params).level,
};

/** Pole a pravidla hodu: odhoz, zásah (terči-bossovi ubere HP), všechny cíle (s koly až poslední kolo), hody došly. */
export function throwParts(seed: number, params: ThrowParams): { readonly level: ArcadeLevel; readonly rules: PieceRef[] } {
  const { level, rounds, tough } = buildField(seed, params);
  return {
    level,
    rules: [
      { id: 'launch', params: { template: 1 } },
      { id: 'shot_hit', params: tough === undefined ? {} : { tough } },
      rounds === null ? { id: 'cleared', params: {} } : { id: 'throw_rounds', params: rounds },
      { id: 'out_of_ammo', params: {} },
    ],
  };
}

/**
 * Konec kola (spouštěč `counter`): pole je čisté → v posledním kole výhra,
 * jinak opěry kola zmiznou, přijdou těla dalšího kola, hody na počet kola
 * a čítač kola o jedno výš. Poslední míček ve vzduchu nic nemění: kolo
 * začíná, až žádný cíl nestojí. S útočníky (`dive`, P51 T6) přijdou s kolem i ti
 * a každý tik vezme hody ten, kdo se doplížil k hráči (`diveArrivals`).
 */
export const throwRounds: RulePiece<ThrowRoundsParams> = {
  id: 'throw_rounds',
  params: roundsParams,
  roles: ['target', 'obstacle'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    // Útočníci, kteří doletěli k hráči, vezmou hody a zmizí – i uprostřed kola (P51 T6).
    const arrived = params.dive === undefined ? [] : diveArrivals(state, params.dive);
    if (census(state).foes > 0) return arrived;
    const next = params.rounds[state[HEADER.counters + COUNTER[THROW_ROUND_COUNTER]] as number];
    if (next === undefined) return [{ kind: 'win' }];
    const effects: ArcadeEffect[] = [];
    const kinds = params.supports.map((template) => state[bodyBase(template) + BODY.kind] as number);
    for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
      const base = bodyBase(i);
      if (((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && state[base + BODY.role] === ROLE.obstacle && kinds.includes(state[base + BODY.kind] as number)) effects.push({ kind: 'despawn', body: i });
    }
    for (let k = 0; k + 3 < next.bodies.length; k += 4) effects.push({ kind: 'spawn', template: next.bodies[k]!, x: next.bodies[k + 1]!, y: next.bodies[k + 2]!, z: next.bodies[k + 3]!, vx: 0, vy: 0, vz: 0 });
    if (next.swing !== undefined) effects.push({ kind: 'spawn', template: next.swing[0], x: next.swing[1], y: next.swing[2], z: next.swing[3], vx: next.swing[4], vy: 0, vz: 0 });
    const { dive } = params;
    // Útočníci kola čekají v řadě za polem; vrhne je na hráče ovládání (`startDives`).
    if (dive !== undefined) for (let k = 0; k < (next.dives ?? 0); k += 1) effects.push({ kind: 'spawn', template: dive.template, x: 0, y: dive.y, z: dive.from + k * dive.gap, vx: 0, vy: 0, vz: 0 });
    effects.push({ kind: 'count', counter: 'ammo', amount: next.throws - (state[HEADER.counters + COUNTER.ammo] as number) });
    effects.push({ kind: 'count', counter: THROW_ROUND_COUNTER, amount: 1 });
    return effects;
  },
};

/** Útočníci na `reach` od hráče a blíž: každý zmizí a vezme `steal` hodů, dokud nějaké jsou. */
function diveArrivals(state: Int32Array, dive: NonNullable<ThrowRoundsParams['dive']>): ArcadeEffect[] {
  const effects: ArcadeEffect[] = [];
  let ammo = state[HEADER.counters + COUNTER.ammo] as number;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (!sameKind(state, i, dive.template) || (state[bodyBase(i) + BODY.z] as number) > dive.reach) continue;
    const taken = Math.min(dive.steal, Math.max(0, ammo));
    ammo -= taken;
    effects.push({ kind: 'despawn', body: i });
    if (taken > 0) effects.push({ kind: 'count', counter: 'ammo', amount: -taken });
  }
  return effects;
}

/** Tvrzení „hratelné z konstrukce“ nad hotovým polem; prázdné pole = hratelné. */
export function checkThrowLevel(level: ArcadeLevel): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const { bodies } = level;
  // Každý cíl sám (ostatní stojí): věž = souvislá řada bloků na stejném z.
  const byZ = new Map<number, number[]>();
  bodies.forEach((body, index) => {
    if (body.role === 'target' && body.template !== true) byZ.set(body.z, [...(byZ.get(body.z) ?? []), index]);
  });
  for (const [z, indices] of byZ) {
    const removed = new Set<number>();
    for (const target of [...indices].sort((a, b) => (bodies[b]?.y ?? 0) - (bodies[a]?.y ?? 0))) {
      const boxes = boxesOfLevel(bodies).filter((box) => !removed.has(box.index));
      if (solveThrow(boxes, target) === null) issues.push(`target ${target} at ${m(z)} cannot be hit by any throw within the power and angle limits`);
      removed.add(target);
    }
  }
  const goals = targetsIn(bodies);
  if (goals === 0) issues.push('nothing to hit');
  if ((level.counters?.ammo ?? 0) < goals) issues.push(`${level.counters?.ammo ?? 0} throws for ${goals} targets`);
  const capacity = bodies.length + (level.spawnSlots ?? 0);
  if (capacity > ARCADE_LIMITS.maxBodies) issues.push(`${capacity} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
