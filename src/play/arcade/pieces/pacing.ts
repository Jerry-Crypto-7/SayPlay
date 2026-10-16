/**
 * Průběh hry (P45C): úvod, stupňování, vrchol, finále.
 *
 * Intenzita je čistá celočíselná funkce **postupu ke cíli** v promile
 * (`progressOf`) – hra se stupňuje stejně pro rychlého i pomalého hráče a
 * finále přijde těsně před výhrou; podíl uběhlého času je spodní mez, takže
 * tlak roste i nečinnému hráči. Intenzita 1000 = dnešní úroveň hry.
 *
 * Rozvrh spawnů se losuje jen při stavbě světa ze streamu `pacing`
 * (`createCompileRng(seed, 'pacing')`); za běhu žádná náhoda.
 */

import { z } from 'zod';

import { type CompileRng, createCompileRng } from '@/play/compile/rng';

import type { ArcadeParts } from '../addons';
import type { CompiledInteract } from '../rules/interact';
import { ARCADE_LIMITS, type ArcadeEffect, type ArcadeLevel, type ArcadeObservation, type ArcadeRole, type ArcadeWorld, BODY, type BodyInit, type BotPiece, COUNTER, type ControlPiece, FLAG, HEADER, type PieceRef, ROLE, type RulePiece, UNIT, bodyBase, bodyHp, nativeRule, targetStateOf } from '../contract';
import { ESCAPE } from './arena';
import { BEHAVIOURS, type BehaviourId, type BehaviourRef, type BehaviourSpace, behaviourBodies, behaviourEffects, behaviourRefSchema, dodge, duplicateSignature, seenByBase, stepBehaviours } from './behaviours';
import { DUEL_FOE, duelControl, enragedAfter } from './duel';
import { FIGHT } from './fight';
// Cykly `throw.ts` a `segments.ts` ↔ tenhle modul jsou bezpečné: ani jeden nečte hodnoty druhého při načtení, jen ve funkcích.
import { type SegmentGenre, segmentScriptOf, segmentSpans } from './segments';
import { type SteerCourse, steerSegments } from './steer';
import { THROW_ROUND_COUNTER } from './throw';
import { spotsAway, waveOf } from './waves';

export const PACING = {
  /** Konce segmentů v promile postupu: úvod 0–200, stupňování 200–650, vrchol 650–850, finále 850–1000. */
  segments: { intro: 200, buildUp: 650, peak: 850, finale: 1000 },
  /** Intenzita v promile dnešní úrovně: úvod, konec stupňování, vrchol, finále. */
  intensity: { intro: 700, buildUp: 1100, peak: 1300, finale: 1500 },
  /** Hustota spawnů roste s `intensita − spawnFloor`: úvod dostane málo, vrchol a finále hodně. */
  spawnFloor: 500,
  /** Živých těl chování naráz nejvýš. */
  maxActors: 12,
  /**
   * Rezerva slotů pro výstřely chování: ostřelovač jich má ve vzduchu nejvýš 3
   * (přes úhlopříčku arény letí déle než dva jeho cykly). simplified: výstřel
   * nad rezervu se zahodí; víc než dva střelci na hru → rezervu počítat z nich.
   */
  maxShots: 6,
  /**
   * Tep pole (P47A T9): tolik tiků bez události smí v úvodu uběhnout, pak přijde mince. S intenzitou se zkracuje
   * (`heartbeatAt`: × úvod / intenzita – konec stupňování 95, vrchol 80, finále 70 tiků), takže houstne ke konci.
   */
  heartbeat: 150,
  /** Živých mincí tepu naráz nejvýš: s plnou plochou tep místo nové mince odvolá tu nejdál od hráče. */
  heartbeatCoins: 3,
} as const;

/** Body křivky `[postup ‰, intenzita ‰]`; mezi body lineárně, dva body na stejném postupu = skok. */
export type TensionCurve = readonly (readonly [permille: number, intensity: number])[];

const { segments: S, intensity: I } = PACING;

/** Plocha pod křivkou 1030 ‰ dnešní úrovně: úvod lehčí, vrchol a finále těžší. */
export const TENSION_CURVE: TensionCurve = [
  [0, I.intro],
  [S.intro, I.intro],
  [S.buildUp, I.buildUp],
  [S.buildUp, I.peak],
  [S.peak, I.peak],
  [S.peak, I.finale],
  [S.finale, I.finale],
];

/** Intenzita v promile na postupu `progress` (0–1000); celočíselně, poslední bod se stejným postupem vyhrává. */
export function intensityAt(progress: number, curve: TensionCurve): number {
  let at = 0;
  while (at + 1 < curve.length && (curve[at + 1] as readonly [number, number])[0] <= progress) at += 1;
  const [x0, y0] = curve[at] as readonly [number, number];
  const next = curve[at + 1];
  if (next === undefined || next[0] === x0) return y0;
  const [x1, y1] = next;
  const rise = (y1 - y0) * (progress - x0);
  // Celočíselné dělení se zaokrouhlením k nule i pro klesající úsek.
  return y0 + (rise - (rise % (x1 - x0))) / (x1 - x0);
}

/** Jak hra měří postup ke cíli: ujetá trať, sebrané věci, skóre, padlí soupeři, jen čas, nebo vlny (`arena_waves`). */
export const pacingGoalSchema = z
  .object({
    by: z.enum(['distance', 'items', 'score', 'fallen', 'time', 'wave']),
    /** Délka trati v jednotkách, potřebné věci, cílové skóre, počet soupeřů, tiky (`time`), nebo počet vln (`wave`). */
    need: z.int().min(1),
    /** Jen `fallen`: kód role soupeřů. */
    role: z.int().min(1).optional(),
    /** Tiky, po kterých je postup podle času 1000 (spodní mez postupu). */
    limit: z.int().min(1).max(ARCADE_LIMITS.maxTicks),
  })
  .strict();
export type PacingGoal = z.infer<typeof pacingGoalSchema>;

const share = (done: number, need: number): number => Math.min(1000, Math.max(0, Math.floor((done * 1000) / need)));

/** Postup ke cíli v promile: větší z cílového postupu a podílu uběhlého času. */
export function progressOf(state: Int32Array, goal: PacingGoal): number {
  const time = share(state[HEADER.tick] as number, goal.limit);
  const counter = (name: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[name]] as number;
  let done = 0;
  if (goal.by === 'distance') done = state[bodyBase(state[HEADER.player] as number) + BODY.z] as number;
  else if (goal.by === 'items') done = counter('items');
  else if (goal.by === 'score') done = counter('score');
  else if (goal.by === 'fallen') {
    let alive = 0;
    const bodies = state[HEADER.bodyCount] as number;
    for (let body = 0; body < bodies; body += 1) {
      const base = bodyBase(body);
      if (state[base + BODY.role] === goal.role && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) alive += 1;
    }
    done = goal.need - alive;
  } else if (goal.by === 'wave') done = waveOf(state);
  else done = state[HEADER.tick] as number;
  return Math.max(time, share(done, goal.need));
}

/** Jeden krok rozvrhu: na postupu `atPermille` přijde `count` těl chování `behaviour` (index), `entry` = vstup 0–3. */
export interface ScheduleEntry {
  readonly atPermille: number;
  readonly behaviour: number;
  readonly count: number;
  readonly entry: number;
}

/**
 * `n` míst v promile postupu, kde kumulovaná plocha `intensita − spawnFloor`
 * dosáhne středů `n` stejných dílů (± čtvrt dílu losem, když je `rng`).
 * Husté tam, kde je křivka vysoko; před `from` ‰ a od `until` ‰ nic (třeba
 * až od druhé vlny a jen do poslední). Statické žánry (rytmus) staví nad ním noty.
 */
export function placeByCurve(curve: TensionCurve, n: number, rng?: CompileRng, from = 0, until = 1000): number[] {
  const cumulative: number[] = [0];
  for (let p = 0; p < 1000; p += 1) cumulative.push((cumulative[p] as number) + (p < from || p >= until ? 0 : Math.max(0, intensityAt(p, curve) - PACING.spawnFloor)));
  const total = cumulative[1000] as number;
  const quarter = Math.floor(total / (4 * n));
  const places: number[] = [];
  let p = 0;
  for (let k = 0; k < n; k += 1) {
    const target = Math.floor(((2 * k + 1) * total) / (2 * n)) + (rng === undefined ? 0 : rng.int(-quarter, quarter));
    while (p < 999 && (cumulative[p + 1] as number) <= target) p += 1;
    places.push(p);
  }
  return places;
}

/** Rozvrh `budget` spawnů z `kinds` chování od `from` ‰ do `until` ‰; ve vrcholu a finále přijdou po dvou. Jen při stavbě. */
export function scheduleOf(rng: CompileRng, curve: TensionCurve, budget: number, kinds = 1, from = 0, until = 1000): ScheduleEntry[] {
  return placeByCurve(curve, budget, rng, from, until).map((atPermille) => ({
    atPermille,
    behaviour: rng.int(0, kinds - 1),
    count: intensityAt(atPermille, curve) >= PACING.intensity.peak ? 2 : 1,
    entry: rng.int(0, 3),
  }));
}

// ---------------------------------------------------------------------------
// Kusy: obal ovládání, pravidlo, obal robota

/**
 * Knoflíky žánru, které intenzita škáluje (vzor `phase_control`): klíč
 * parametru základního ovládání (tečka = vnořený), `up` = větší je těžší
 * (hodnota × intenzita), jinak menší je těžší (hodnota / intenzita), a meze,
 * přes které škálování nikdy nejde. Žánr bez řádku jen nese křivku.
 */
export const PACING_KNOBS: Readonly<Record<string, readonly { readonly key: string; readonly up: boolean; readonly min: number; readonly max: number }[]>> = {
  move_free: [{ key: 'chase.speed', up: true, min: ESCAPE.chaserSpeed.min, max: ESCAPE.chaserSpeed.max }],
  fight: [{ key: 'enemySpeed', up: true, min: FIGHT.enemySpeed.min, max: FIGHT.enemySpeed.max }],
  walker: [{ key: 'chaseSpeed', up: true, min: 0, max: 70 }],
  // Souboj dvou (T13): agresivita soupeře = intenzita, nejvýš 1200 – mezera po úderu by ve vrcholu (1300) klesla
  // pod reakci začátečníka (20 tiků + 2 na úder) a novice vyhrál 0/20 (1200: 10/20 s rozzuřením, 18/20 bez něj).
  // Nejméně dnešní úroveň (T18): s úvodem 700 soupeř v klipu skoro stál (slepý soud T17 0/2) a hra trvala 47–53 s;
  // od 1000 začne jako dnešní první soupeř, hra 41–46 s, novice 8/20 (1100: 8/20, 38–43 s; 1200 po celou hru 4/20).
  duel: [{ key: 'pace', up: true, min: 1000, max: 1200 }],
};

/**
 * Tělo-počítadlo (vzor `comboKeeper`): mrtvá předloha za tělesy úrovně, nic ho
 * nekreslí ani nesrazí. `aux0` = nejvyšší dosažený postup v promile, `aux1` =
 * tentýž postup tik předtím – pravidlo `pacing` z nich pozná, které kroky
 * rozvrhu tento tik přešly. Zapisuje je jen `pacing_control`.
 */
export const pacingKeeper = (kind: string): BodyInit => ({ role: 'obstacle', kind, x: 0, y: -100 * 1000, z: 0, w: 1, h: 1, d: 1, solid: false, template: true });

export const reachedOf = (state: Int32Array, keeper: number): number => state[bodyBase(keeper) + BODY.aux0] as number;

const refSchema = z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) });

/** Chování nepřátel ve hře (P45C T4): předlohy, podle jejichž podpisu se těla poznají. */
const behaviourRefs = z.array(behaviourRefSchema).min(1).max(8);
/** `steady`: knoflíky žánru (`PACING_KNOBS`) se neškálují – křivka jen rozvrhuje spawny a finále. */
/**
 * `pulse`: tělo-počítadlo tepu a předloha jeho mince (`markPulse`), jen hry pole ve `genre.v4`. `spark` (sběr a útěk
 * s věcmi, P47A T9): mince je jiskra (`isSpark`) – strážci ji nehlídají.
 */
const pulseRef = z.object({ keeper: z.int().min(1), template: z.int().min(1), spark: z.literal(true).optional() }).strict();
const controlParams = z.object({ base: refSchema, goal: pacingGoalSchema, keeper: z.int().min(1), behaviours: behaviourRefs.optional(), space: z.enum(['plane', 'track']).optional(), steady: z.literal(true).optional(), pulse: pulseRef.optional() }).strict();
const botParams = z
  .object({
    base: refSchema, control: z.string(), keeper: z.int().min(1), behaviours: behaviourRefs.optional(), steady: z.literal(true).optional(),
    /** Skóre, od kterého výhra čeká už jen na pád bosse (`grow_to.boss`, P47A T3): robot pak věci na zemi nevidí a jde na bosse. */
    points: z.int().min(1).optional(),
    /** Tep: robot mince tepu nevidí (`withoutCoins`). */
    pulse: pulseRef.optional(),
  })
  .strict();

const parsed = new WeakMap<object, unknown>();
/** Parametry základního kusu přečtené schématem jednou (výchozí hodnoty doplní zod). */
function parseOnce(piece: { readonly params: { parse(input: unknown): unknown } }, raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!parsed.has(raw)) parsed.set(raw, piece.params.parse(raw));
  return parsed.get(raw) as Readonly<Record<string, unknown>>;
}

/** Parametry `params` s knoflíky ovládání `control` škálovanými intenzitou; klíč, který parametry nemají, se přeskočí. */
export function scaledParams(control: string, params: Readonly<Record<string, unknown>>, intensity: number): Readonly<Record<string, unknown>> {
  const knobs = PACING_KNOBS[control];
  if (knobs === undefined) return params;
  let out = params;
  for (const knob of knobs) {
    const path = knob.key.split('.');
    const leaf = path.pop() as string;
    const holder = path.reduce<Readonly<Record<string, unknown>> | undefined>((at, key) => at?.[key] as Readonly<Record<string, unknown>> | undefined, out);
    const value = holder?.[leaf];
    if (typeof value !== 'number') continue;
    const scaled = knob.up ? Math.floor((value * intensity) / 1000) : Math.floor((value * 1000) / intensity);
    const bounded = Math.max(knob.min, Math.min(knob.max, scaled));
    const set = (at: Readonly<Record<string, unknown>>, depth: number): Readonly<Record<string, unknown>> =>
      depth === path.length ? { ...at, [leaf]: bounded } : { ...at, [path[depth] as string]: set(at[path[depth] as string] as Readonly<Record<string, unknown>>, depth + 1) };
    out = set(out, 0);
  }
  return out;
}

const scaled = new WeakMap<object, Map<string, Map<number, Readonly<Record<string, unknown>>>>>();
/** `scaledParams` jednou na parametry, ovládání a intenzitu: ovládání i robot je chtějí každý tik a intenzita se mění zřídka. */
function scaledOnce(control: string, params: Readonly<Record<string, unknown>>, intensity: number): Readonly<Record<string, unknown>> {
  let known = scaled.get(params);
  if (known === undefined) scaled.set(params, (known = new Map()));
  let byIntensity = known.get(control);
  if (byIntensity === undefined) known.set(control, (byIntensity = new Map()));
  let out = byIntensity.get(intensity);
  if (out === undefined) byIntensity.set(intensity, (out = scaledParams(control, params, intensity)));
  return out;
}

/** Intenzita podle nejvyššího dosaženého postupu v počítadle. */
const intensityOf = (state: Int32Array, keeper: number): number => intensityAt(reachedOf(state, keeper), TENSION_CURVE);

/** Tiky bez události, po kterých tep přijde, na postupu `progress` ‰: `beat` v úvodu, s intenzitou kratší. */
export const heartbeatAt = (beat: number, progress: number): number => Math.floor((beat * PACING.intensity.intro) / intensityAt(progress, TENSION_CURVE));

/** Role, jejichž zmizení telemetrie počítá jako zabití (`telemetry.ts`, `KILL_ROLES`). */
const PULSE_ROLES: readonly number[] = [ROLE.chaser, ROLE.enemy, ROLE.hazard, ROLE.target];
/** Sloty těla-počítadla tepu se stavem po minulém tiku (`x` = tik poslední události). */
const PULSE_SLOTS = [BODY.z, BODY.vx, BODY.vy, BODY.vz, BODY.w, BODY.h, BODY.d, BODY.aux0] as const;

/** HP hráče, skóre, zdraví, živá těla od slotu spawnu, živé věci, živé hrozby, součet stavů cílů, HP hrozeb. */
function pulseOf(state: Int32Array, player: number): number[] {
  let spawned = 0;
  let items = 0;
  let threats = 0;
  let states = 0;
  let hp = 0;
  const from = state[HEADER.spawnBase] as number;
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (body === player || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    if (body >= from) spawned += 1;
    const role = state[base + BODY.role] as number;
    if (role === ROLE.collectible) items += 1;
    else if (PULSE_ROLES.includes(role)) {
      threats += 1;
      hp += bodyHp(state, body);
      if (role === ROLE.target) states += targetStateOf(state, body);
    }
  }
  const counter = (name: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[name]] as number;
  return [bodyHp(state, player), counter('score'), counter('health'), spawned, items, threats, states, hp];
}

/**
 * Tep pole (P47A T9), krok ovládání: stav po minulém tiku proti uloženému v těle-počítadle tepu. Událost = ubylo
 * HP hráče, skóre přibylo, zdraví ubylo, těl od slotu spawnu přibylo, věcí, hrozeb či HP hrozeb ubylo, stav cílů
 * se změnil – jen to, co telemetrie počítá taky (`eventsOf`), takže tep nikdy nečeká déle, než smí; co navíc
 * nepozná, stojí nanejvýš minci navíc. Tik události (minulý) jde do `x`.
 */
function markPulse(state: Int32Array, player: number, pulse: z.infer<typeof pulseRef>): void {
  const base = bodyBase(pulse.keeper);
  const now = pulseOf(state, player);
  const was = PULSE_SLOTS.map((slot) => state[base + slot] as number);
  const [hp, score, health, spawned, items, threats, states, threatHp] = now as [number, number, number, number, number, number, number, number];
  const happened = hp < (was[0] as number) || score > (was[1] as number) || health < (was[2] as number) || spawned > (was[3] as number)
    || items < (was[4] as number) || threats < (was[5] as number) || states !== was[6] || threatHp < (was[7] as number);
  if (happened) state[base + BODY.x] = (state[HEADER.tick] as number) - 1;
  for (const [k, slot] of PULSE_SLOTS.entries()) state[base + slot] = now[k] as number;
}

/** Živé mince tepu: kopie předlohy `template` (role, model, šířka a výška) od slotu spawnu. */
function coinsOf(state: Int32Array, template: number): number[] {
  const t = bodyBase(template);
  const same = (base: number, slot: number): boolean => state[base + slot] === state[t + slot];
  const coins: number[] = [];
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && same(base, BODY.role) && same(base, BODY.kind) && same(base, BODY.w) && same(base, BODY.h)) coins.push(body);
  }
  return coins;
}

const roads = new WeakMap<object, SteerCourse | null>();
/** Silnice řízení pod obaly základního ovládání (osa trati `course`), jednou na parametry; jiné ovládání ji nemá. */
function roadOf(base: PieceRef): SteerCourse | undefined {
  let road = roads.get(base);
  if (road === undefined) roads.set(base, (road = (controlIn(base, 'steer')?.params.course as SteerCourse | undefined) ?? null));
  return road ?? undefined;
}

/**
 * `pacing_control`: posune počítadlo postupu, pak krok základního ovládání se
 * škálovanými knoflíky žánru (`PACING_KNOBS`) a krok těl chování.
 */
export function makePacingControl(controls: Readonly<Record<string, ControlPiece>>): ControlPiece<z.infer<typeof controlParams>> {
  return {
    id: 'pacing_control', params: controlParams, roles: ['player'], cost: () => ({ bodies: 1, rules: 0 }),
    step(state, player, input, params) {
      const native = controls[params.base.id];
      if (native === undefined) throw new Error(`arcade: unknown paced control ${params.base.id}`);
      if (params.pulse !== undefined) markPulse(state, player, params.pulse);
      const keeper = bodyBase(params.keeper);
      const reached = state[keeper + BODY.aux0] as number;
      state[keeper + BODY.aux1] = reached;
      state[keeper + BODY.aux0] = Math.max(reached, progressOf(state, params.goal));
      const own = parseOnce(native, params.base.params);
      const intensity = intensityOf(state, params.keeper);
      native.step(state, player, input, params.steady === true ? own : scaledOnce(params.base.id, own, intensity));
      if (params.behaviours !== undefined) stepBehaviours(state, player, params.behaviours, params.space ?? 'plane', intensity, typeof own.half === 'number' ? own.half : undefined, roadOf(params.base), params.pulse?.spark === true ? params.pulse.template : undefined);
    },
  };
}

/**
 * Pohled bez věcí na zemi: cíl skóre je splněný a výhra čeká na bosse – věc navíc nic nepřidá a boss je poslední
 * krok (`behaviours/boss.ts`, `lastStep`). Bez toho robot bez profilu kroužil kolem věci, ke které ho nečinný boss
 * nepustil, až do konce hodin (sběr pod šablonou `treasure_rush`, 2/40 semínek).
 */
function withoutItems(observation: ArcadeObservation): ArcadeObservation {
  const state = observation.state.slice();
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] === ROLE.collectible) state[base + BODY.flags] = (state[base + BODY.flags] as number) & ~FLAG.alive;
  }
  return { ...observation, state };
}

/**
 * Pohled bez mincí tepu (P47A T9): mince jsou bonus pro člověka. Robot, který je viděl, sbíral nejbližší minci
 * místo hlídané věci a bosse (sběr, semínko 7: od 26. s jen mince, boss nepadl) a začátečník přežití vyhrál 8/8
 * místo pásma 3–6.
 */
function withoutCoins(observation: ArcadeObservation, template: number): ArcadeObservation {
  const coins = coinsOf(observation.state, template);
  if (coins.length === 0) return observation;
  const state = observation.state.slice();
  for (const body of coins) state[bodyBase(body) + BODY.flags] = (state[bodyBase(body) + BODY.flags] as number) & ~FLAG.alive;
  return { ...observation, state };
}

/** `pacing_bot`: základní robot rozhoduje se stejně škálovanými parametry, jaké vidí ovládání; před těly chování uhne. */
export function makePacingBot(bots: Readonly<Record<string, BotPiece>>): BotPiece<z.infer<typeof botParams>> {
  return {
    id: 'pacing_bot', params: botParams, roles: ['player'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }),
    decide(observation, params) {
      const native = bots[params.base.id];
      if (native === undefined) throw new Error(`arcade: unknown paced bot ${params.base.id}`);
      const plain = params.pulse === undefined ? observation : withoutCoins(observation, params.pulse.template);
      const goal = params.points !== undefined && (observation.state[HEADER.counters + COUNTER.score] as number) >= params.points ? withoutItems(plain) : plain;
      const seen = params.behaviours === undefined ? goal : seenByBase(goal, params.behaviours);
      const own = parseOnce(native, params.base.params);
      const input = native.decide(seen, params.steady === true ? own : scaledOnce(params.control, own, intensityOf(observation.state, params.keeper)));
      return params.behaviours === undefined ? input : dodge(observation, params.behaviours, params.control, input);
    },
  };
}

/**
 * Druhy finále. T14 připsal statické žánry: `sudden` – náhlá smrt posledních kol načasování, `phrase` – rychlá
 * závěrečná fráze rytmu, `bonus` – poslední pohyblivý bonusový terč hodu; `round` = poslední kolo (u stanoviště
 * s dvojím úkolem).
 */
export const FINALES = ['boss', 'wave', 'sprint', 'round', 'escape', 'sudden', 'phrase', 'bonus'] as const;

const ruleParams = z
  .object({
    keeper: z.int().min(1),
    /** Kroky rozvrhu s už vybranou předlohou chování (index těla). */
    schedule: z.array(z.object({ atPermille: z.int().min(1).max(1000), template: z.int().min(1), count: z.int().min(1).max(PACING.maxActors), entry: z.int().min(0).max(3) }).strict()).max(32),
    /** Místa vstupu `[x, z]` po dvojicích; `track` = `z` je odstup před hráčem. */
    spots: z.array(z.int()).min(2).max(16),
    space: z.enum(['plane', 'track']),
    maxActors: z.int().min(1).max(PACING.maxActors),
    finale: z.enum(FINALES).optional(),
    /** Těla chování, která pravidlo nechá udeřit (`behaviourEffects`). */
    behaviours: behaviourRefs.optional(),
    /** Polovina strany plochy (`plane`): výstřel chování za ní zmizí. */
    half: z.int().min(1).optional(),
    /**
     * Na postupu `at` ‰ odejdou všechna živá těla role `role` – pronásledovatelé
     * uvolní plochu bossovi, nová chování odejdou před poslední vlnou.
     */
    clear: z.array(z.object({ role: z.int().min(1), at: z.int().min(1).max(1000) }).strict()).min(1).max(2).optional(),
    /** Tep pole (P47A T9): předloha mince, tělo-počítadlo tepu a `beat` = tiky bez události v úvodu (`heartbeatAt`). */
    pulse: z.object({ template: z.int().min(1), keeper: z.int().min(1), beat: z.int().min(1).max(ARCADE_LIMITS.maxTicks) }).strict().optional(),
  })
  .strict();
export type PacingRuleParams = z.infer<typeof ruleParams>;

/**
 * Tep pole (P47A T9): po `heartbeatAt` tikách bez události přijde mince na nejbližším volném místě vstupu; s plnou
 * plochou (`heartbeatCoins`) tep místo ní odvolá minci nejdál od hráče. Obojí je událost a ovládání ji příští tik
 * zapíše (`markPulse`), takže tep přijde znovu až po dalším tichu. Mince předlohy život nevezme.
 */
function heartbeatOf(state: Int32Array, player: number, pulse: NonNullable<PacingRuleParams['pulse']>, spots: readonly number[], reached: number): ArcadeEffect[] {
  if ((state[HEADER.tick] as number) - (state[bodyBase(pulse.keeper) + BODY.x] as number) < heartbeatAt(pulse.beat, reached)) return [];
  const coins = coinsOf(state, pulse.template);
  const t = bodyBase(pulse.template);
  const p = bodyBase(player);
  // Čtverec vzdálenosti v celých číslech (za běhu žádná plovoucí čárka mimo přesný rozsah).
  const away = (body: number): number => ((state[bodyBase(body) + BODY.x] as number) - (state[p + BODY.x] as number)) ** 2 + ((state[bodyBase(body) + BODY.z] as number) - (state[p + BODY.z] as number)) ** 2;
  if (coins.length >= PACING.heartbeatCoins) return [{ kind: 'despawn', body: coins.reduce((far, body) => (away(body) > away(far) ? body : far)) }];
  const near = spotsAway(state, player, spots).reverse();
  const taken = (k: number): boolean => coins.some((body) => Math.abs((state[bodyBase(body) + BODY.x] as number) - (spots[2 * k] as number)) < (state[t + BODY.w] as number) && Math.abs((state[bodyBase(body) + BODY.z] as number) - (spots[2 * k + 1] as number)) < (state[t + BODY.d] as number));
  const at = near.find((k) => !taken(k)) ?? (near[0] as number);
  return [{ kind: 'spawn', template: pulse.template, x: spots[2 * at] as number, y: state[t + BODY.y] as number, z: spots[2 * at + 1] as number, vx: 0, vy: 0, vz: 0 }];
}

/** Živá těla chování: kopie některé z předloh rozvrhu (týž model) od prvního slotu spawnu. */
function actorsAlive(state: Int32Array, templates: ReadonlySet<number>): number {
  const kinds = new Set([...templates].map((template) => state[bodyBase(template) + BODY.kind] as number));
  let alive = 0;
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && kinds.has(state[base + BODY.kind] as number)) alive += 1;
  }
  return alive;
}

/**
 * Pravidlo `pacing` (spouštěč `tick`): kroky rozvrhu, které postup v tomto
 * tiku přešel, vydají `spawn` předloh – v rovině na místech nejdál od hráče
 * (vzor `enter` ve `waves.ts`), na trati před hráčem v pruhu kroku. Nikdy víc
 * živých těl chování než `maxActors`; co se nevejde, nepřijde. Předtím údery
 * těl chování (`behaviourEffects`) – zranit smí jen tudy.
 */
export const pacingRule: RulePiece<PacingRuleParams> = {
  id: 'pacing', trigger: 'tick', params: ruleParams, roles: [], cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player }, params) {
    const keeper = bodyBase(params.keeper);
    const before = state[keeper + BODY.aux1] as number;
    const reached = state[keeper + BODY.aux0] as number;
    const effects: ArcadeEffect[] = params.behaviours === undefined ? [] : behaviourEffects(state, player, params.behaviours, params.half);
    if (params.pulse !== undefined) effects.push(...heartbeatOf(state, player, params.pulse, params.spots, reached));
    // Postup se v tomhle tiku nehnul: žádný krok rozvrhu ani úklid nepřešel.
    if (reached === before) return effects;
    const clears = (params.clear ?? []).filter((clear) => clear.at > before && clear.at <= reached);
    for (const clear of clears) {
      for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
        const base = bodyBase(body);
        if (body !== player && state[base + BODY.role] === clear.role && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) effects.push({ kind: 'despawn', body });
      }
    }
    // Postup po vlnách skáče: krok rozvrhu před úklidem, který přešel tentýž tik, už nepřijde (jeho vlna skončila).
    const stale = (entry: PacingRuleParams['schedule'][number]): boolean => clears.some((clear) => entry.atPermille < clear.at && state[bodyBase(entry.template) + BODY.role] === clear.role);
    const due = params.schedule.filter((entry) => entry.atPermille > before && entry.atPermille <= reached && !stale(entry));
    if (due.length === 0) return effects;
    let room = params.maxActors - actorsAlive(state, new Set(params.schedule.map((entry) => entry.template)));
    const spots = params.spots.length >> 1;
    const order = params.space === 'plane' ? spotsAway(state, player, params.spots) : [];
    const p = bodyBase(player);
    for (const entry of due) {
      const ref = params.behaviours?.find((candidate) => candidate.template === entry.template);
      const group = ref === undefined ? undefined : BEHAVIOURS[ref.id].group;
      for (let k = 0; k < entry.count && room > 0; k += 1, room -= 1) {
        // Hejno přijde celé na jednom místě, po `spacing` vedle sebe (rovina) nebo za sebou (trať).
        const at = params.space === 'plane' ? (order[group === undefined ? k % spots : 0] as number) : (entry.entry + (group === undefined ? k : 0)) % spots;
        const shift = group === undefined ? 0 : Math.trunc(((2 * k - entry.count + 1) * group.spacing) / 2);
        const x = (params.spots[2 * at] as number) + (params.space === 'plane' ? shift : 0);
        const z = (params.spots[2 * at + 1] as number) + (params.space === 'track' ? (state[p + BODY.z] as number) + shift : 0);
        // Výška předlohy: těla chování i boss stojí na zemi (0), stanoviště finále (T14) na pultu.
        effects.push({ kind: 'spawn', template: entry.template, x, y: state[bodyBase(entry.template) + BODY.y] as number, z, vx: 0, vy: 0, vz: 0 });
      }
    }
    return effects;
  },
};

/** Předloha spawnu; s `behaviour` ji hýbe a nechá udeřit rámec chování (`behaviours/index.ts`). */
export interface PacingActor {
  readonly body: BodyInit;
  readonly behaviour?: BehaviourId;
  /** Rozvrh ji nevysadí před tímhle postupem v promile (hejno běžce až ve vrcholu); krok dřív dostane jinou předlohu. */
  readonly from?: number;
}

/** Ovládání pod obalem fází (`phase_control`): robot průběhu uhýbá podle něj, ne podle obalu. */
const nativeControlId = (control: PieceRef): string => (control.id === 'phase_control' ? nativeControlId(control.params.base as PieceRef) : control.id);

/** Co `withPacing` přidá: jak hra měří postup, kde se vstupuje, předlohy chování a kolik spawnů. */
export interface PacingSetup {
  readonly seed: number;
  readonly goal: PacingGoal;
  readonly space: BehaviourSpace;
  readonly spots: readonly number[];
  /** Předlohy spawnů (`template: true`); prázdné = jen křivka bez spawnů. */
  readonly behaviours: readonly PacingActor[];
  /** Hra dostane jen tolik z `behaviours`, losem ze streamu `pacing` před rozvrhem; bez pole všechny. */
  readonly pick?: number;
  readonly budget: number;
  /** Rozvrh nic nevysadí před tímhle postupem v promile (např. až od druhé vlny)… */
  readonly from?: number;
  /** …ani od tohohle (např. jen do poslední vlny). */
  readonly until?: number;
  readonly finale?: (typeof FINALES)[number];
  /**
   * Boss: tělo a postup v promile, na kterém přijde – jeden spawn mimo los rozvrhu, předloha za předlohami `behaviours`.
   * `behaviour` = chování bosse (výchozí `boss`; úkol má za bosse strážce nad poslední věcí).
   */
  readonly boss?: { readonly body: BodyInit; readonly at: number; readonly behaviour?: BehaviourId };
  /** Na postupu `at` ‰ odejdou živá těla role `role` (pronásledovatelé s příchodem bosse, chování před poslední vlnou). */
  readonly clear?: readonly { readonly role: BodyInit['role']; readonly at: number }[];
  /** Knoflíky žánru zůstanou, jak jsou (vlny si drží své zrychlení); křivka jen rozvrhuje spawny a finále. */
  readonly steady?: boolean;
  /**
   * Finále bez chování (T14): na postupu `at` ‰ přijde `count` kopií těla `body` na místech `spots` ve výšce
   * předlohy – stanoviště dvojího úkolu posledního kola. Předloha jde za předlohy výstřelů, mimo los rozvrhu.
   */
  readonly extra?: { readonly body: BodyInit; readonly at: number; readonly count: number };
  /**
   * Scénář úseků žánru (P46B T3, `segmentScriptOf`): nový nepřítel úseku přijde s jeho prvním krokem
   * rozvrhu a dřív ne – úsek 2 i 3 tak vždy přinese chování, které hráč ještě neviděl.
   */
  readonly segments?: SegmentGenre;
  /** Scénář úseků od režiséra (P46E T4, `spec.segments`): přepíše los `segmentScriptOf`. */
  readonly script?: readonly SegmentNews[];
  /** Tep pole (P47A T9): předloha mince, která přijde po `PACING.heartbeat` tikách bez události (`heartbeatOf`). */
  readonly pulse?: BodyInit;
  /**
   * Mince tepu je jiskra (P47A T9, sběr a útěk s věcmi, `isSpark`): strážci ji nehlídají; `arena_eat` ji sebere bez
   * bodu a vlna věcí na ni nečeká (předlohu jim dá `pacingParts`).
   */
  readonly spark?: true;
}

/** Rychlost fází (`phase_control`) v % na začátku rozjezdu a úseků scénáře; trať bez fází = prázdné. */
function segmentSpeeds(control: PieceRef): number[] {
  const phases = controlIn(control, 'phase_control')?.params.phases as readonly { readonly start: number; readonly speedPercent: number }[] | undefined;
  if (phases === undefined) return [];
  return [0, ...segmentSpans().map(([at]) => at)].map((at) => [...phases].reverse().find((phase) => phase.start <= at)?.speedPercent ?? 100);
}

/**
 * Šířka silnice řízení (mezi mantinely) v rozjezdu a úsecích scénáře: ta, která v úseku vede nejdelší kus trati;
 * trať bez mantinelů = prázdné. Okruh ze vzorů (P46D) má v každém úseku zúžení, šikany i rozcestí – jeden bod
 * uprostřed úseku by padl na kterýkoli z nich. Na trati se šířkou po úsecích je to šířka úseku. Šířky čte jen
 * scénář (změna `narrow`) a nápis úseku, svět ne.
 */
export function segmentWidths(level: ArcadeParts['level']): number[] {
  const walls = steerSegments(level);
  if (walls.length === 0) return [];
  return [[0, PACING.segments.intro] as const, ...segmentSpans()].map(([from, to]) => {
    const [near, far] = [Math.floor((level.length * from) / 1000), Math.floor((level.length * to) / 1000)];
    const spans = new Map<number, number>();
    for (const wall of walls) {
      const overlap = Math.min(far, wall.far) - Math.max(near, wall.near);
      if (overlap > 0) spans.set(wall.width, (spans.get(wall.width) ?? 0) + overlap);
    }
    let best = (walls[walls.length - 1] as (typeof walls)[number]).width;
    let most = 0;
    for (const [width, span] of spans) if (span > most) [best, most] = [width, span];
    return best;
  });
}

/**
 * Druhy prostředí skákačky (P46B T6) v rozjezdu a úsecích scénáře podle polohy na trati: kinematický hrot = past
 * (`trap`), kinematická plošina = pohyblivá plošina (`moving`).
 */
function segmentPlaces(level: ArcadeParts['level']): string[][] {
  return [[0, PACING.segments.intro] as const, ...segmentSpans()].map(([from, to]) => {
    const kinds = level.bodies.flatMap((body) => {
      const at = Math.floor((body.z * 1000) / Math.max(1, level.length));
      if (body.kinematic !== true || body.template === true || at < from || at >= to) return [];
      return body.role === 'hazard' ? ['trap'] : body.role === 'platform' ? ['moving'] : [];
    });
    return [...new Set(kinds)].sort().reverse();
  });
}

/** Kde postup krok na `permille` ‰ nejpozději přejde: cíl roste po celých věcech, kolech či tikách (`progressOf`). */
const crossingOf = (goal: PacingGoal, permille: number): number => Math.min(1000, Math.floor((Math.ceil((permille * goal.need) / 1000) * 1000) / goal.need));

/**
 * Příchody nových nepřátel úseků pole (P47A T8). Postup sběru a questu roste po věcech a kolech, takže krok rozvrhu
 * přijde až s věcí či kolem, které ho přešly (`crossingOf`; quest po druhém kole skočí rovnou na kolo bosse). Nový
 * nepřítel úseku dostane první volný krok, který postup přejde uvnitř úseku a ne spolu s bossem (boss vyčistí role
 * a finále má sám). Když takový krok není, posune se nejbližší volný krok na nejbližší takové místo od `from` do
 * `until` – rozpočet spawnů zůstane a nic se nelosuje. Úsek bez takového místa (quest:
 * úsek 3 je kolo bosse) nového nepřítele nedostane; jeho chování pak smí od začátku úseku jako u běžce.
 */
function fieldArrivals<T extends { readonly at: number; readonly until: number; readonly index: number }>(raw: readonly ScheduleEntry[], listed: readonly T[], setup: PacingSetup): { steps: ScheduleEntry[]; arrivals: T[]; firsts: number[] } {
  const steps = [...raw];
  const cross = (permille: number): number => crossingOf(setup.goal, permille);
  const boss = setup.boss === undefined ? -1 : cross(Math.max(1, setup.boss.at));
  const fits = (permille: number, at: number, until: number): boolean => cross(permille) >= at && cross(permille) < until && cross(permille) !== boss;
  const used: number[] = [];
  const arrivals = listed.map((arrival) => {
    let k = steps.findIndex((entry, j) => !used.includes(j) && fits(entry.atPermille, arrival.at, arrival.until));
    if (k < 0) {
      // Nejbližší volný krok na nejbližší místo, kde ho postup přejde v úseku a ne s bossem: rozvrh se pohne co nejméně.
      let best: { j: number; place: number } | null = null;
      for (let place = Math.max(arrival.at, setup.from ?? 0, 1); place < Math.min(arrival.until, setup.until ?? 1000); place += 1) {
        if (!fits(place, arrival.at, arrival.until)) continue;
        for (const [j, entry] of steps.entries()) {
          if (!used.includes(j) && (best === null || Math.abs(entry.atPermille - place) < Math.abs((steps[best.j] as ScheduleEntry).atPermille - best.place))) best = { j, place };
        }
      }
      if (best !== null) steps[best.j] = { ...(steps[best.j] as ScheduleEntry), atPermille: best.place };
      k = best?.j ?? -1;
    }
    if (k >= 0) used.push(k);
    return { arrival: k < 0 ? arrival : { ...arrival, at: (steps[k] as ScheduleEntry).atPermille }, k };
  });
  return { steps, arrivals: arrivals.map((placed) => placed.arrival), firsts: arrivals.map((placed) => placed.k) };
}

/**
 * Části hry s průběhem: obalí ovládání a robota, za tělesa úrovně přidá
 * předlohy chování a počítadlo, rezervu spawnů a pravidlo `pacing` s rozvrhem
 * z `createCompileRng(seed, 'pacing')`. Bez předloh (a bez finále) pravidlo
 * nepřidá; s chováním ano i bez rozvrhu (těla chování může nést úroveň).
 * Chování s výstřelem dostane za předlohami těl jednu předlohu výstřelu na
 * druh a rezervu `maxShots` slotů. Dvě předlohy se stejným podpisem (role,
 * model, rozměry) = `issues`.
 */
export function withPacing(parts: ArcadeParts, setup: PacingSetup): ArcadeParts {
  const first = parts.level.bodies.length;
  const rng = createCompileRng(setup.seed, 'pacing');
  // Výběr chování (`pick`) bere stream první, rozvrh pokračuje za ním; bez výběru rozvrh začíná na začátku streamu jako dřív.
  const behaviours = setup.pick === undefined || setup.pick >= setup.behaviours.length ? setup.behaviours : rng.shuffle(setup.behaviours).slice(0, setup.pick);
  // Boss je poslední předloha chování; los rozvrhu ho nevybírá.
  const actors: readonly PacingActor[] = setup.boss === undefined ? behaviours : [...behaviours, { body: setup.boss.body, behaviour: setup.boss.behaviour ?? 'boss' }];
  const shooters = [...new Set(actors.flatMap((actor) => (actor.behaviour !== undefined && BEHAVIOURS[actor.behaviour].shot !== undefined ? [actor.behaviour] : [])))];
  const shotBodies = shooters.map((id) => BEHAVIOURS[id].shot as BodyInit);
  const extras = setup.extra === undefined ? [] : [setup.extra.body];
  // Mince tepu je poslední předloha před počítadlem, tělo-počítadlo tepu jde za počítadlo postupu.
  const pulses = setup.pulse === undefined ? [] : [setup.pulse];
  const keeper = first + actors.length + shooters.length + extras.length + pulses.length;
  const duplicate = duplicateSignature([...actors.map((actor) => actor.body), ...shotBodies]);
  if (duplicate !== null) return { ...parts, issues: [...(parts.issues ?? []), `pacing: two spawn templates share the signature ${duplicate} (role:kind:w:h:d)`] };
  const shotOf = (id: BehaviourId): { shot?: number } => (shooters.includes(id) ? { shot: first + actors.length + shooters.indexOf(id) } : {});
  const refs = actors.flatMap((actor, index) => (actor.behaviour === undefined ? [] : [{ id: actor.behaviour, template: first + index, ...shotOf(actor.behaviour) }]));
  const moved = refs.length === 0 ? {} : { behaviours: refs };
  const counter = pacingKeeper(parts.level.bodies[0]?.kind ?? 'player');
  const bodies = [...parts.level.bodies, ...[...actors.map((actor) => actor.body), ...shotBodies, ...extras, ...pulses].map((body) => ({ ...body, template: true })), counter, ...pulses.map(() => counter)];
  const raw = behaviours.length === 0 || setup.budget === 0 ? [] : scheduleOf(rng, TENSION_CURVE, setup.budget, behaviours.length, setup.from, setup.until);
  // Scénář losuje až za rozvrhem, takže kroky zůstanou, kde byly: nový nepřítel úseku smí až od jeho začátku a první krok úseku je jeho.
  const cast = {
    foes: behaviours.flatMap((actor) => (actor.behaviour === undefined ? [] : [{ behaviour: actor.behaviour, from: actor.from ?? 0 }])),
    speeds: segmentSpeeds(parts.control),
    widths: setup.segments === 'steer' ? segmentWidths(parts.level) : [],
    ...(setup.segments === 'platform' ? { places: segmentPlaces(parts.level) } : {}),
  };
  const script = setup.segments === undefined ? [] : segmentScriptOf(rng, setup.segments, cast, setup.script);
  const listed = script.flatMap((step) => step.changes.flatMap((change) => (change.kind === 'newFoe' ? [{ ...step, index: behaviours.findIndex((actor) => actor.behaviour === change.behaviour) }] : [])));
  const field = setup.segments === 'field' ? fieldArrivals(raw, listed, setup) : null;
  const steps = field?.steps ?? raw;
  // Pole: nový nepřítel smí až od místa svého kroku (úsek 3 za tikem bosse), ne od začátku úseku.
  const arrivals = field?.arrivals ?? listed;
  // Úsek režiséra bez nového nepřítele (P46E T4): nepřítel bez příchodu přijde až za posledním takovým úsekem.
  const hold = setup.script === undefined ? 0 : Math.max(0, ...script.filter((step) => !step.changes.some((change) => change.kind === 'newFoe')).map((step) => step.until));
  const fromOf = (index: number): number => Math.max(behaviours[index]?.from ?? 0, arrivals.find((arrival) => arrival.index === index)?.at ?? hold);
  // Předloha, která ještě nesmí (`from`), předá krok jiné z těch, které už smí – bez dalšího losu, stream zůstane.
  const picked = steps.map((entry) => {
    const ready = behaviours.flatMap((_actor, index) => (fromOf(index) <= entry.atPermille ? [index] : []));
    return ready.includes(entry.behaviour) ? entry.behaviour : ready[entry.behaviour % Math.max(1, ready.length)];
  });
  // Nový nepřítel úseku dostane jeho první krok a chování z toho kroku si vezme jeho nejbližší pozdější krok:
  // hra má dál stejné složení nepřátel (přepsat oba kroky ostřelovače vzalo semínku 7 běžce 15 z 24 útoků).
  const firsts = field?.firsts ?? arrivals.map((arrival) => raw.findIndex((entry) => entry.atPermille >= arrival.at && entry.atPermille < arrival.until));
  for (const [n, arrival] of arrivals.entries()) {
    const k = firsts[n] as number;
    if (k < 0 || picked[k] === arrival.index) continue;
    const swap = picked.findIndex((index, j) => j > k && index === arrival.index && !firsts.includes(j));
    if (swap >= 0) picked[swap] = picked[k];
    picked[k] = arrival.index;
  }
  const drawn = steps
    .flatMap((entry, k) => {
      const index = picked[k];
      if (index === undefined) return [];
      const actor = behaviours[index]?.behaviour;
      // Hejno je jeden spawn celé, i ve vrcholu (dvě hejna naráz by přetekla `maxActors`).
      const group = actor === undefined ? undefined : BEHAVIOURS[actor].group;
      return [{ atPermille: Math.max(1, entry.atPermille), template: first + index, count: group?.size ?? entry.count, entry: entry.entry }];
    });
  const bossed = setup.boss === undefined ? drawn : [...drawn, { atPermille: Math.max(1, setup.boss.at), template: first + behaviours.length, count: 1, entry: 0 }];
  const schedule = setup.extra === undefined ? bossed : [...bossed, { atPermille: Math.max(1, setup.extra.at), template: first + actors.length + shooters.length, count: setup.extra.count, entry: 0 }];
  const pulse = setup.pulse === undefined ? {} : { pulse: { template: keeper - 1, keeper: keeper + 1, beat: PACING.heartbeat } };
  const half = parts.control.params.half;
  const edge = setup.space === 'plane' && shooters.length > 0 && typeof half === 'number' ? { half } : {};
  const clear = setup.clear === undefined || setup.clear.length === 0 ? {} : { clear: setup.clear.map((step) => ({ role: ROLE[step.role], at: Math.max(1, step.at) })) };
  const rule: PieceRef | null = schedule.length === 0 && setup.finale === undefined && refs.length === 0 ? null : {
    id: 'pacing', params: { keeper, schedule, spots: [...setup.spots], space: setup.space, maxActors: PACING.maxActors, ...(setup.finale === undefined ? {} : { finale: setup.finale }), ...moved, ...edge, ...clear, ...pulse },
  };
  const slots = (schedule.length === 0 ? 0 : PACING.maxActors) + (shooters.length === 0 ? 0 : PACING.maxShots) + (pulses.length === 0 ? 0 : PACING.heartbeatCoins);
  const steady = setup.steady === true ? { steady: true as const } : {};
  return {
    ...parts,
    control: { id: 'pacing_control', params: { base: parts.control, goal: setup.goal, keeper, ...moved, ...(refs.length === 0 ? {} : { space: setup.space }), ...steady, ...(pulses.length === 0 ? {} : { pulse: { keeper: keeper + 1, template: keeper - 1, ...(setup.spark === true ? { spark: true } : {}) } }) } },
    bot: { id: 'pacing_bot', params: { base: parts.bot, control: nativeControlId(parts.control), keeper, ...moved, ...steady, ...(pulses.length === 0 ? {} : { pulse: { keeper: keeper + 1, template: keeper - 1 } }) } },
    level: { ...parts.level, bodies, spawnSlots: (parts.level.spawnSlots ?? 0) + slots },
    rules: rule === null ? parts.rules : [...parts.rules, rule],
  };
}

// ---------------------------------------------------------------------------
// Oznámení průběhu (P45C T16), úseků (P46B T7) a finále podle žánru (P47A T10)

/** Úseky 2 a 3 jako chvíle banneru. */
export const SEGMENT_BEATS = ['segment2', 'segment3'] as const;
export type SegmentBeat = (typeof SEGMENT_BEATS)[number];

/**
 * Finále `genre.v4` (P47A T5–T7, T3), které hra ohlásí tím, co ve světě opravdu přijde, místo druhu finále pravidla
 * `pacing`: `champion` = šampion duelu (tělo soupeře převezme předlohu `duel.champion`), `bossTarget` = terč-boss
 * posledního kola hodu (`shot_hit.tough`), `rush` = spěch stanoviště (`interact.rush`), `shower` = déšť mincí
 * přežití (předloha mimo chování v rozvrhu finále `wave`). Svět bez nich (uložené hry) hlásí finále jako dřív.
 */
export const FINALE_NEWS = ['champion', 'bossTarget', 'rush', 'shower'] as const;
export type FinaleNews = (typeof FINALE_NEWS)[number];

/**
 * Chvíle průběhu, kterou hra ohlásí: `buildUp` = na ploše je nové chování (ne boss), `segment2`/`segment3` =
 * změna úseku (hra se scénářem úseků místo `buildUp`), jinak běžící finále (`FINALE_NEWS` tam, kde ho svět má).
 */
export type PacingBeat = 'buildUp' | SegmentBeat | (typeof FINALES)[number] | FinaleNews;

/** Svět, ze kterého se chvíle čtou: pravidla a ovládání, úseky navíc úroveň z počátečního stavu. */
export type BeatWorld = Pick<ArcadeWorld, 'rules' | 'control' | 'initial' | 'kinds' | 'length'>;

/**
 * Co úsek 2 či 3 hráči opravdu přinesl, v pořadí přednosti pro jediný nápis úseku: nový nepřítel, užší silnice,
 * nová past, pohyblivé plošiny, vyšší rychlost.
 */
export const SEGMENT_NEWS = ['newFoe', 'narrow', 'trap', 'moving', 'faster'] as const;
export type SegmentNews = (typeof SEGMENT_NEWS)[number];

/**
 * Ohlášená změna úseku a chvíle, kdy nastane: postup `reached` ‰ dojde na `at` (nový nepřítel přijde s krokem
 * rozvrhu), nebo hráč na trati dojede do `z` = `at` (rychlejší fáze, past nebo užší silnice před ním).
 */
export interface SegmentAnnouncement {
  readonly beat: SegmentBeat;
  readonly news: SegmentNews;
  readonly by: 'reached' | 'z';
  readonly at: number;
}

/** Past, pohyblivou plošinu a užší silnici banner ohlásí o tolik dřív, než k nim hráč dojede – uvidí je včas. */
export const NEWS_LEAD = 20 * UNIT;

const never = (): boolean => false;
const playerZ = (state: Int32Array): number => state[bodyBase(state[HEADER.player] as number) + BODY.z] as number;

/** Hra se scénářem úseků (běžec, řízení, skákačka – `withPacing` `segments`): trať, jejíž finále je boss. */
const segmentPaced = (params: PacingRuleParams): boolean => params.space === 'track' && params.finale === 'boss';

/**
 * Hra pole se scénářem úseků (`genre.v4`, P47A T8 – sběr, útěk, přežití, quest v prostoru): rovina s tepem pole.
 * Scénář úseků pole a tep (T9) staví průběh jen spolu a jen ve `genre.v4`; uložené hry nemají ani jedno, takže
 * dál ohlásí `buildUp`.
 */
const fieldPaced = (params: PacingRuleParams): boolean => params.space === 'plane' && params.pulse !== undefined;

const ROLE_NAMES: ReadonlyMap<number, ArcadeRole> = new Map(Object.entries(ROLE).map(([name, code]) => [code, name as ArcadeRole]));

/** Úroveň zpátky z počátečního stavu světa: role, model, rozměry, kinematika a předlohy (`segmentWidths`, `segmentPlaces`). */
function levelOf(world: BeatWorld): ArcadeLevel {
  const bodies: BodyInit[] = [];
  for (let body = 0; body < (world.initial[HEADER.bodyCount] as number); body += 1) {
    const at = (slot: number): number => world.initial[bodyBase(body) + slot] as number;
    const flags = at(BODY.flags);
    bodies.push({
      role: ROLE_NAMES.get(at(BODY.role)) ?? 'thing', kind: world.kinds[at(BODY.kind)] ?? '',
      x: at(BODY.x), y: at(BODY.y), z: at(BODY.z), w: at(BODY.w), h: at(BODY.h), d: at(BODY.d),
      solid: (flags & FLAG.solid) !== 0, kinematic: (flags & FLAG.kinematic) !== 0, template: (flags & FLAG.alive) === 0,
    });
  }
  return { bodies, length: world.length };
}

/**
 * Co úseky 2 a 3 hry opravdu změnily, přečteno ze světa, ne z pevného seznamu: nový nepřítel = chování, jehož
 * první krok rozvrhu pravidla `pacing` padne do úseku (`withPacing` dává novému nepříteli úseku jeho první krok);
 * rychlost = fáze trati (`segmentSpeeds`); užší silnice řízení a nová past či pohyblivá plošina skákačky = tělesa
 * úrovně (`segmentWidths`, `segmentPlaces` nad úrovní z počátečního stavu) – tatáž čtení, ze kterých staví scénář
 * úseků (`segmentScriptOf`). Úsek ohlásí jednu změnu: první podle `SEGMENT_NEWS`, která není druhem změny předchozího
 * úseku (dvakrát „New foe“ řekne míň než „New foe“ a „Faster!“). Úsek beze změny nic. Jen hra se scénářem úseků.
 */
function segmentNewsOfWorld(world: BeatWorld): SegmentAnnouncement[] {
  const params = nativeRule(world.rules, 'pacing')?.params as PacingRuleParams | undefined;
  if (params !== undefined && fieldPaced(params)) return fieldNewsOf(world, params);
  if (params === undefined || !segmentPaced(params)) return [];
  // Boss je poslední předloha chování (`withPacing`); nový nepřítel je jen chování rozvrhu před ním.
  const boss = params.behaviours?.at(-1)?.template;
  const firsts = new Map<number, number>();
  for (const entry of params.schedule) if (entry.template !== boss) firsts.set(entry.template, Math.min(firsts.get(entry.template) ?? 1000, entry.atPermille));
  const phased = controlIn(world.control, 'phase_control')?.params as { readonly phases: readonly { readonly start: number }[]; readonly length: number } | undefined;
  const speeds = segmentSpeeds(world.control);
  const steer = controlIn(world.control, 'steer') !== undefined;
  const platform = controlIn(world.control, 'platform') !== undefined;
  const level = steer || platform ? levelOf(world) : { bodies: [], length: world.length };
  const widths = steer ? segmentWidths(level) : [];
  const walls = steer ? steerSegments(level) : [];
  const places = platform ? segmentPlaces(level) : [];
  const zOf = (permille: number): number => Math.floor((world.length * permille) / 1000);
  let previous: SegmentNews | undefined;
  return segmentSpans().flatMap(([from, until], index): SegmentAnnouncement[] => {
    const k = index + 1;
    const found: Omit<SegmentAnnouncement, 'beat'>[] = [];
    const arrivals = [...firsts.values()].filter((at) => at >= from && at < until);
    if (arrivals.length > 0) found.push({ news: 'newFoe', by: 'reached', at: Math.min(...arrivals) });
    const before = widths[k - 1] ?? 0;
    if ((widths[k] ?? Infinity) < before) {
      const narrower = walls.find((wall) => wall.far > zOf(from) && wall.width < before);
      found.push({ news: 'narrow', by: 'z', at: Math.max(0, (narrower?.near ?? zOf(from)) - NEWS_LEAD) });
    }
    for (const variant of (places[k] ?? []).filter((kind) => !places.slice(0, k).some((earlier) => earlier.includes(kind)))) {
      const role = variant === 'trap' ? 'hazard' : 'platform';
      const near = Math.min(...level.bodies.flatMap((body) => {
        const at = Math.floor((body.z * 1000) / Math.max(1, level.length));
        return body.role === role && body.kinematic === true && body.template !== true && at >= from && at < until ? [body.z - body.d / 2] : [];
      }));
      found.push({ news: variant as 'trap' | 'moving', by: 'z', at: Math.max(0, near - NEWS_LEAD) });
    }
    if (phased !== undefined && (speeds[k] ?? 0) > (speeds[k - 1] ?? Infinity)) {
      // Fáze platí od `floor(z · 1000 / délka) >= start` (`phaseSpeed`): od prvního celého `z` nad `start · délka / 1000`.
      const start = [...phased.phases].reverse().find((phase) => phase.start <= from)?.start ?? 0;
      found.push({ news: 'faster', by: 'z', at: Math.ceil((start * phased.length) / 1000) });
    }
    found.sort((a, b) => SEGMENT_NEWS.indexOf(a.news) - SEGMENT_NEWS.indexOf(b.news));
    const chosen = found.find((item) => item.news !== previous) ?? found[0];
    if (chosen === undefined) return [];
    previous = chosen.news;
    return [{ beat: SEGMENT_BEATS[index] as SegmentBeat, ...chosen }];
  });
}

/** Krok rozvrhu bosse finále (poslední předloha chování, `withPacing`); hra bez bosse `undefined`. */
const bossStepOf = (params: PacingRuleParams): PacingRuleParams['schedule'][number] | undefined => {
  const boss = params.finale === 'boss' ? params.behaviours?.at(-1)?.template : undefined;
  return boss === undefined ? undefined : params.schedule.find((entry) => entry.template === boss);
};

/**
 * Nový nepřítel úseku pole (P47A T8), přečtený z rozvrhu světa, ne ze scénáře: první krok předlohy chování, kterou
 * žádný dřívější krok neměl. Úsek kroku je ten, ve kterém ho postup cíle přejde (`crossingOf` – sběr a quest rostou
 * po věcech a kolech); krok, který postup přejde až s bossem, nový nepřítel úseku není (boss má tik sám – quest:
 * úsek 3 je kolo bosse). Nápis přijde, když postup dojde na krok – v tom tiku ho pravidlo `pacing` vysadí.
 */
function fieldNewsOf(world: BeatWorld, params: PacingRuleParams): SegmentAnnouncement[] {
  const goal = controlIn(world.control, 'pacing_control')?.params.goal as PacingGoal | undefined;
  if (goal === undefined) return [];
  const bossStep = bossStepOf(params);
  const foes = new Set((params.behaviours ?? []).flatMap((ref) => (ref.template === bossStep?.template ? [] : [ref.template])));
  const firsts = new Map<number, number>();
  for (const entry of params.schedule) if (foes.has(entry.template)) firsts.set(entry.template, Math.min(firsts.get(entry.template) ?? 1000, entry.atPermille));
  const bossAt = bossStep === undefined ? -1 : crossingOf(goal, bossStep.atPermille);
  return segmentSpans().flatMap(([from, until], index): SegmentAnnouncement[] => {
    const arrivals = [...firsts.values()].filter((at) => crossingOf(goal, at) >= from && crossingOf(goal, at) < until && crossingOf(goal, at) !== bossAt);
    return arrivals.length === 0 ? [] : [{ beat: SEGMENT_BEATS[index] as SegmentBeat, news: 'newFoe', by: 'reached', at: Math.min(...arrivals) }];
  });
}

const news = new WeakMap<object, readonly SegmentAnnouncement[]>();

/** Ohlášené změny úseků 2 a 3 (`segmentNewsOfWorld`), jednou na svět; hra bez scénáře úseků prázdné. Jen čte svět. */
export function segmentNewsOf(world: BeatWorld): readonly SegmentAnnouncement[] {
  let known = news.get(world);
  if (known === undefined) news.set(world, (known = segmentNewsOfWorld(world)));
  return known;
}

/** Šampion duelu (P47A T6): předloha těla bosse, kterou ovládání `duel` otiskne do soupeře; svět bez šampiona `undefined`. */
const championOf = (world: Pick<ArcadeWorld, 'control'>): number | undefined => (controlIn(world.control, 'duel')?.params.champion as { readonly body: number } | undefined)?.body;

/** Terč-boss hodu (P47A T7): předloha, které `shot_hit.tough` zásahem bere HP; svět bez něj `undefined`. */
const toughOf = (world: Pick<ArcadeWorld, 'rules'>): number | undefined => nativeRule(world.rules, 'shot_hit')?.params.tough as number | undefined;

/** Déšť mincí přežití (P47A T3): krok rozvrhu finále `wave`, jehož předloha není chování (`PacingSetup.extra`). */
const showerOf = (params: PacingRuleParams): PacingRuleParams['schedule'][number] | undefined =>
  params.finale === 'wave' ? params.schedule.find((entry) => !(params.behaviours ?? []).some((ref) => ref.template === entry.template)) : undefined;

/** Živé kopie předlohy `template` od slotu spawnu: tatáž role, model a rozměry (tep pole má jiné rozměry než déšť). */
function copiesOf(state: Int32Array, template: number): number[] {
  const t = bodyBase(template);
  const out: number[] = [];
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && [BODY.role, BODY.kind, BODY.w, BODY.h, BODY.d].every((slot) => state[base + slot] === state[t + slot])) out.push(body);
  }
  return out;
}

/**
 * Těla bosse finále, která nesou HP pro pipy ve scéně (P47A T10): šampion duelu (soupeř s modelem předlohy
 * `duel.champion`, i po knockoutu s HP 0) a živý terč-boss hodu. Bosse chování (sběr, quest, souboj …) kreslí
 * pipy podle svého chování; tady nejsou. Hra bez nich `null`. Jen čte stav.
 */
export function finaleBossesOf(world: Pick<ArcadeWorld, 'rules' | 'control'>): ((state: Int32Array) => number[]) | null {
  const champion = championOf(world);
  if (champion !== undefined) return (state) => (state[bodyBase(DUEL_FOE) + BODY.kind] === state[bodyBase(champion) + BODY.kind] ? [DUEL_FOE] : []);
  const tough = toughOf(world);
  return tough === undefined ? null : (state) => copiesOf(state, tough);
}

/**
 * Druh těla bosse finále (poslední předloha chování pravidla `pacing`, P46E T4; od P47A T10 i šampion duelu a
 * terč-boss hodu); `null` = hra bez bosse.
 */
export function bossKindOf(world: Pick<ArcadeWorld, 'rules' | 'initial' | 'kinds' | 'control'>): string | null {
  const params = nativeRule(world.rules, 'pacing')?.params as { readonly finale?: string; readonly behaviours?: readonly { readonly template: number }[] } | undefined;
  const template = params?.finale === 'boss' ? params.behaviours?.at(-1)?.template : params?.finale === 'round' ? championOf(world) : params?.finale === 'bonus' ? toughOf(world) : undefined;
  return template === undefined ? null : (world.kinds[world.initial[bodyBase(template) + BODY.kind] as number] ?? null);
}

/** Kus ovládání `id` v řetězu obalů (`params.base`: doplňky, průběh, fáze, skládání). */
function controlIn(ref: PieceRef, id: string): PieceRef | undefined {
  if (ref.id === id) return ref;
  const base = ref.params.base;
  return typeof base === 'object' && base !== null ? controlIn(base as PieceRef, id) : undefined;
}

/**
 * Běží finále? Čte mechanismus, který finále ve světě opravdu dělá, ne jeho jméno: boss = živé tělo bosse,
 * poslední vlna či kolo = čítač vlny arény, souboj dvou = rozzuření posledního soupeře (`enragedAfter`),
 * sprint = nejrychlejší fáze trati (`phase_control`, jako `phaseSpeed`), náhlá smrt = posledních `sudden`
 * úkolů rozhodčího (jako `judgeRule`), bonus hodu = poslední kolo. Fráze rytmu a útěk na čas jsou místo
 * na křivce: noty rytmu leží podle její plochy (`placeByCurve`) a postup jsou vyřízené noty, takže finále
 * začne s podílem not před vrcholem 850 ‰. Svět bez mechanismu svého finále ho neohlásí nikdy.
 */
function finaleOn(world: Pick<ArcadeWorld, 'rules' | 'control'>, finale: (typeof FINALES)[number], keeper: number, boss: readonly BehaviourRef[]): (state: Int32Array) => boolean {
  const waves = nativeRule(world.rules, 'arena_waves')?.params.waves as readonly unknown[] | undefined;
  if (finale === 'boss') return boss.length === 0 ? never : (state) => behaviourBodies(state, state[HEADER.player] as number, boss).length > 0;
  if (finale === 'wave' || (finale === 'round' && waves !== undefined)) return waves === undefined ? never : (state) => waveOf(state) >= waves.length;
  if (finale === 'round') {
    const duel = controlIn(world.control, 'duel');
    if (duel === undefined) return never;
    const params = duelControl.params.parse(duel.params);
    return (state) => enragedAfter(Math.floor(playerZ(state) / UNIT), params);
  }
  if (finale === 'sprint') {
    const phased = controlIn(world.control, 'phase_control')?.params as { readonly phases: readonly { readonly start: number }[]; readonly length: number } | undefined;
    const last = phased?.phases.at(-1)?.start ?? 0;
    return phased === undefined || last === 0 ? never : (state) => Math.floor((playerZ(state) * 1000) / phased.length) >= last;
  }
  if (finale === 'sudden') {
    const judge = nativeRule(world.rules, 'judge')?.params as { readonly goal: number; readonly sudden?: number } | undefined;
    const from = judge?.sudden === undefined ? undefined : judge.goal - judge.sudden;
    return from === undefined ? never : (state) => Math.floor(playerZ(state) / UNIT) >= from;
  }
  if (finale === 'bonus') {
    const rounds = (nativeRule(world.rules, 'throw_rounds')?.params.rounds as readonly unknown[] | undefined)?.length;
    return rounds === undefined ? never : (state) => (state[HEADER.counters + COUNTER[THROW_ROUND_COUNTER]] as number) >= rounds;
  }
  const from = finale === 'phrase' ? placeByCurve(TENSION_CURVE, 1000).filter((at) => at < S.peak).length : S.peak;
  return (state) => reachedOf(state, keeper) >= from;
}

/** Chvíle hry a podmínka, se kterou platí; `at` = postup ‰, na kterém přijde (pořadí úseků pole s finále). */
interface BeatStep {
  readonly beat: PacingBeat;
  readonly on: (state: Int32Array) => boolean;
  readonly at?: number;
}

/**
 * Finále, které hra ohlásí, a kdy běží – mechanismem, který ho ve světě opravdu dělá: šampion = soupeř duelu
 * s modelem předlohy šampiona (otiskne ji ovládání v tiku, kdy padne předposlední soupeř), spěch = kolo arény od
 * `interact.rush.round` (od něj platí kratší úkoly), terč-boss = poslední kolo hodu (`throw_rounds` ho vyšle
 * v tiku, kdy čítač kola dojde na počet kol), déšť = živá mince předlohy deště. Jinak finále pravidla (`finaleOn`).
 */
function finaleStepOf(world: BeatWorld, params: PacingRuleParams & { readonly finale: (typeof FINALES)[number] }): BeatStep {
  const { finale, keeper } = params;
  const refs = params.behaviours ?? [];
  if (finale === 'round') {
    const crowned = finaleBossesOf(world);
    if (crowned !== null) return { beat: 'champion', on: (state) => crowned(state).length > 0 };
    const rush = (nativeRule(world.rules, 'interact')?.params.when as { readonly interact?: CompiledInteract } | undefined)?.interact?.rush?.round;
    if (rush !== undefined) return { beat: 'rush', on: (state) => waveOf(state) >= rush };
  }
  if (finale === 'bonus' && toughOf(world) !== undefined) return { beat: 'bossTarget', on: finaleOn(world, finale, keeper, []) };
  const shower = showerOf(params);
  if (shower !== undefined) return { beat: 'shower', on: (state) => copiesOf(state, shower.template).length > 0, at: shower.atPermille };
  // Boss je poslední předloha chování (`withPacing`).
  const boss = bossStepOf(params);
  return { beat: finale, on: finaleOn(world, finale, keeper, finale === 'boss' ? refs.slice(-1) : []), ...(boss === undefined ? {} : { at: boss.atPermille }) };
}

/**
 * Chvíle hry v pořadí, ve kterém přicházejí, s podmínkou každé. Běžec, řízení a skákačka: úsek 2, úsek 3, finále.
 * Pole se scénářem úseků (P47A T8): úseky a finále podle postupu, na kterém přijdou – nepřítel úseku 3 sběru přijde
 * až po bossovi (postup 650 ‰ přejde táž věc jako boss), proto jeho nápis přijde po nápisu bosse. Jiná hra:
 * stupňování, když je na ploše nové chování (ne boss), pak finále.
 */
function stepsOf(world: BeatWorld): readonly BeatStep[] {
  const params = nativeRule(world.rules, 'pacing')?.params as PacingRuleParams | undefined;
  if (params?.finale === undefined) return [];
  const { keeper } = params;
  const finale = finaleStepOf(world, params as PacingRuleParams & { readonly finale: (typeof FINALES)[number] });
  const segments = segmentNewsOf(world).map((item): BeatStep => ({ beat: item.beat, at: item.at, on: (state) => (item.by === 'reached' ? reachedOf(state, keeper) : playerZ(state)) >= item.at }));
  if (segmentPaced(params)) return [...segments, finale];
  // Pole: řazení je stabilní, takže finále na stejném postupu jako nepřítel úseku je až za ním (v jednom tiku vyhraje).
  if (segments.length > 0) return [...segments, finale].sort((a, b) => (a.at ?? 1000) - (b.at ?? 1000));
  const refs = params.behaviours ?? [];
  const foes = params.finale === 'boss' ? refs.slice(0, -1) : refs;
  return [{ beat: 'buildUp', on: (state) => foes.length > 0 && behaviourBodies(state, state[HEADER.player] as number, foes).length > 0 }, finale];
}

const steps = new WeakMap<object, readonly BeatStep[]>();
const stepsOnce = (world: BeatWorld): readonly BeatStep[] => {
  let known = steps.get(world);
  if (known === undefined) steps.set(world, (known = stepsOf(world)));
  return known;
};

/** Chvíle, které hra může ohlásit, v pořadí, ve kterém přicházejí (banner žádnou neohlásí po pozdější). Jen čte svět. */
export function pacingBeatOrderOf(world: BeatWorld): readonly PacingBeat[] {
  return stepsOnce(world).map((step) => step.beat);
}

/**
 * Co hra právě teď ohlásí (banner P45C T16): poslední chvíle v pořadí `pacingBeatOrderOf`, jejíž podmínka platí –
 * běžící finále, úsek, jehož změna už nastala (`segmentNewsOf`; v poli i nepřítel úseku 3 za bossem), u hry bez
 * úseků `buildUp`, když je na ploše nové chování; jinak `null`. Hra bez finále v pravidle `pacing` nemá žádnou
 * chvíli – ani se svými chováními. Jen čte stav.
 */
export function pacingBeatOf(world: BeatWorld, state: Int32Array): PacingBeat | null {
  const known = stepsOnce(world);
  for (let k = known.length - 1; k >= 0; k -= 1) if ((known[k] as BeatStep).on(state)) return (known[k] as BeatStep).beat;
  return null;
}
