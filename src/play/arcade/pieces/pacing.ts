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
import { ARCADE_LIMITS, type ArcadeEffect, type ArcadeLevel, type ArcadeRole, type ArcadeWorld, BODY, type BodyInit, type BotPiece, COUNTER, type ControlPiece, FLAG, HEADER, type PieceRef, ROLE, type RulePiece, UNIT, bodyBase, nativeRule } from '../contract';
import { ESCAPE } from './arena';
import { BEHAVIOURS, type BehaviourId, type BehaviourRef, type BehaviourSpace, behaviourBodies, behaviourEffects, behaviourRefSchema, dodge, duplicateSignature, seenByBase, stepBehaviours } from './behaviours';
import { duelControl, enragedAfter } from './duel';
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
const controlParams = z.object({ base: refSchema, goal: pacingGoalSchema, keeper: z.int().min(1), behaviours: behaviourRefs.optional(), space: z.enum(['plane', 'track']).optional(), steady: z.literal(true).optional() }).strict();
const botParams = z.object({ base: refSchema, control: z.string(), keeper: z.int().min(1), behaviours: behaviourRefs.optional(), steady: z.literal(true).optional() }).strict();

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

const scaled = new WeakMap<object, Map<string, Readonly<Record<string, unknown>>>>();
/** `scaledParams` jednou na parametry, ovládání a intenzitu: ovládání i robot je chtějí každý tik a intenzita se mění zřídka. */
function scaledOnce(control: string, params: Readonly<Record<string, unknown>>, intensity: number): Readonly<Record<string, unknown>> {
  let known = scaled.get(params);
  if (known === undefined) scaled.set(params, (known = new Map()));
  const key = `${control}:${intensity}`;
  let out = known.get(key);
  if (out === undefined) known.set(key, (out = scaledParams(control, params, intensity)));
  return out;
}

/** Intenzita podle nejvyššího dosaženého postupu v počítadle. */
const intensityOf = (state: Int32Array, keeper: number): number => intensityAt(reachedOf(state, keeper), TENSION_CURVE);

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
      const keeper = bodyBase(params.keeper);
      const reached = state[keeper + BODY.aux0] as number;
      state[keeper + BODY.aux1] = reached;
      state[keeper + BODY.aux0] = Math.max(reached, progressOf(state, params.goal));
      const own = parseOnce(native, params.base.params);
      const intensity = intensityOf(state, params.keeper);
      native.step(state, player, input, params.steady === true ? own : scaledOnce(params.base.id, own, intensity));
      if (params.behaviours !== undefined) stepBehaviours(state, player, params.behaviours, params.space ?? 'plane', intensity, typeof own.half === 'number' ? own.half : undefined, roadOf(params.base));
    },
  };
}

/** `pacing_bot`: základní robot rozhoduje se stejně škálovanými parametry, jaké vidí ovládání; před těly chování uhne. */
export function makePacingBot(bots: Readonly<Record<string, BotPiece>>): BotPiece<z.infer<typeof botParams>> {
  return {
    id: 'pacing_bot', params: botParams, roles: ['player'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }),
    decide(observation, params) {
      const native = bots[params.base.id];
      if (native === undefined) throw new Error(`arcade: unknown paced bot ${params.base.id}`);
      const seen = params.behaviours === undefined ? observation : seenByBase(observation, params.behaviours);
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
  })
  .strict();
export type PacingRuleParams = z.infer<typeof ruleParams>;

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
}

/** Rychlost fází (`phase_control`) v % na začátku rozjezdu a úseků scénáře; trať bez fází = prázdné. */
function segmentSpeeds(control: PieceRef): number[] {
  const phases = controlIn(control, 'phase_control')?.params.phases as readonly { readonly start: number; readonly speedPercent: number }[] | undefined;
  if (phases === undefined) return [];
  return [0, ...segmentSpans().map(([at]) => at)].map((at) => [...phases].reverse().find((phase) => phase.start <= at)?.speedPercent ?? 100);
}

/** Šířka silnice řízení (mezi mantinely) uprostřed rozjezdu a úseků scénáře; trať bez mantinelů = prázdné. */
function segmentWidths(level: ArcadeParts['level']): number[] {
  const walls = steerSegments(level);
  if (walls.length === 0) return [];
  return [[0, PACING.segments.intro] as const, ...segmentSpans()].map(([from, to]) => {
    const z = Math.floor((level.length * (from + to)) / 2000);
    return (walls.find((segment) => z < segment.far) ?? (walls[walls.length - 1] as (typeof walls)[number])).width;
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
  const keeper = first + actors.length + shooters.length + extras.length;
  const duplicate = duplicateSignature([...actors.map((actor) => actor.body), ...shotBodies]);
  if (duplicate !== null) return { ...parts, issues: [...(parts.issues ?? []), `pacing: two spawn templates share the signature ${duplicate} (role:kind:w:h:d)`] };
  const shotOf = (id: BehaviourId): { shot?: number } => (shooters.includes(id) ? { shot: first + actors.length + shooters.indexOf(id) } : {});
  const refs = actors.flatMap((actor, index) => (actor.behaviour === undefined ? [] : [{ id: actor.behaviour, template: first + index, ...shotOf(actor.behaviour) }]));
  const moved = refs.length === 0 ? {} : { behaviours: refs };
  const bodies = [...parts.level.bodies, ...[...actors.map((actor) => actor.body), ...shotBodies, ...extras].map((body) => ({ ...body, template: true })), pacingKeeper(parts.level.bodies[0]?.kind ?? 'player')];
  const raw = behaviours.length === 0 || setup.budget === 0 ? [] : scheduleOf(rng, TENSION_CURVE, setup.budget, behaviours.length, setup.from, setup.until);
  // Scénář losuje až za rozvrhem, takže kroky zůstanou, kde byly: nový nepřítel úseku smí až od jeho začátku a první krok úseku je jeho.
  const cast = {
    foes: behaviours.flatMap((actor) => (actor.behaviour === undefined ? [] : [{ behaviour: actor.behaviour, from: actor.from ?? 0 }])),
    speeds: segmentSpeeds(parts.control),
    widths: setup.segments === 'steer' ? segmentWidths(parts.level) : [],
    ...(setup.segments === 'platform' ? { places: segmentPlaces(parts.level) } : {}),
  };
  const script = setup.segments === undefined ? [] : segmentScriptOf(rng, setup.segments, cast);
  const arrivals = script.flatMap((step) => step.changes.flatMap((change) => (change.kind === 'newFoe' ? [{ ...step, index: behaviours.findIndex((actor) => actor.behaviour === change.behaviour) }] : [])));
  const fromOf = (index: number): number => Math.max(behaviours[index]?.from ?? 0, arrivals.find((arrival) => arrival.index === index)?.at ?? 0);
  // Předloha, která ještě nesmí (`from`), předá krok jiné z těch, které už smí – bez dalšího losu, stream zůstane.
  const picked = raw.map((entry) => {
    const ready = behaviours.flatMap((_actor, index) => (fromOf(index) <= entry.atPermille ? [index] : []));
    return ready.includes(entry.behaviour) ? entry.behaviour : ready[entry.behaviour % Math.max(1, ready.length)];
  });
  // Nový nepřítel úseku dostane jeho první krok a chování z toho kroku si vezme jeho nejbližší pozdější krok:
  // hra má dál stejné složení nepřátel (přepsat oba kroky ostřelovače vzalo semínku 7 běžce 15 z 24 útoků).
  const firsts = arrivals.map((arrival) => raw.findIndex((entry) => entry.atPermille >= arrival.at && entry.atPermille < arrival.until));
  for (const [n, arrival] of arrivals.entries()) {
    const k = firsts[n] as number;
    if (k < 0 || picked[k] === arrival.index) continue;
    const swap = picked.findIndex((index, j) => j > k && index === arrival.index && !firsts.includes(j));
    if (swap >= 0) picked[swap] = picked[k];
    picked[k] = arrival.index;
  }
  const drawn = raw
    .flatMap((entry, k) => {
      const index = picked[k];
      if (index === undefined) return [];
      const actor = behaviours[index]?.behaviour;
      // Hejno je jeden spawn celé, i ve vrcholu (dvě hejna naráz by přetekla `maxActors`).
      const group = actor === undefined ? undefined : BEHAVIOURS[actor].group;
      return [{ atPermille: Math.max(1, entry.atPermille), template: first + index, count: group?.size ?? entry.count, entry: entry.entry }];
    });
  const bossed = setup.boss === undefined ? drawn : [...drawn, { atPermille: Math.max(1, setup.boss.at), template: first + behaviours.length, count: 1, entry: 0 }];
  const schedule = setup.extra === undefined ? bossed : [...bossed, { atPermille: Math.max(1, setup.extra.at), template: keeper - 1, count: setup.extra.count, entry: 0 }];
  const half = parts.control.params.half;
  const edge = setup.space === 'plane' && shooters.length > 0 && typeof half === 'number' ? { half } : {};
  const clear = setup.clear === undefined || setup.clear.length === 0 ? {} : { clear: setup.clear.map((step) => ({ role: ROLE[step.role], at: Math.max(1, step.at) })) };
  const rule: PieceRef | null = schedule.length === 0 && setup.finale === undefined && refs.length === 0 ? null : {
    id: 'pacing', params: { keeper, schedule, spots: [...setup.spots], space: setup.space, maxActors: PACING.maxActors, ...(setup.finale === undefined ? {} : { finale: setup.finale }), ...moved, ...edge, ...clear },
  };
  const slots = (schedule.length === 0 ? 0 : PACING.maxActors) + (shooters.length === 0 ? 0 : PACING.maxShots);
  const steady = setup.steady === true ? { steady: true as const } : {};
  return {
    ...parts,
    control: { id: 'pacing_control', params: { base: parts.control, goal: setup.goal, keeper, ...moved, ...(refs.length === 0 ? {} : { space: setup.space }), ...steady } },
    bot: { id: 'pacing_bot', params: { base: parts.bot, control: nativeControlId(parts.control), keeper, ...moved, ...steady } },
    level: { ...parts.level, bodies, spawnSlots: (parts.level.spawnSlots ?? 0) + slots },
    rules: rule === null ? parts.rules : [...parts.rules, rule],
  };
}

// ---------------------------------------------------------------------------
// Oznámení průběhu (P45C T16) a úseků (P46B T7)

/** Úseky 2 a 3 jako chvíle banneru. */
export const SEGMENT_BEATS = ['segment2', 'segment3'] as const;
export type SegmentBeat = (typeof SEGMENT_BEATS)[number];

/**
 * Chvíle průběhu, kterou hra ohlásí: `buildUp` = na ploše je nové chování (ne boss), `segment2`/`segment3` =
 * změna úseku (hra se scénářem úseků místo `buildUp`), jinak běžící finále.
 */
export type PacingBeat = 'buildUp' | SegmentBeat | (typeof FINALES)[number];

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

type Beat = (state: Int32Array) => PacingBeat | null;
const never = (): boolean => false;
const playerZ = (state: Int32Array): number => state[bodyBase(state[HEADER.player] as number) + BODY.z] as number;

/** Hra se scénářem úseků (běžec, řízení, skákačka – `withPacing` `segments`): trať, jejíž finále je boss. */
const segmentPaced = (params: PacingRuleParams): boolean => params.space === 'track' && params.finale === 'boss';

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

const news = new WeakMap<object, readonly SegmentAnnouncement[]>();

/** Ohlášené změny úseků 2 a 3 (`segmentNewsOfWorld`), jednou na svět; hra bez scénáře úseků prázdné. Jen čte svět. */
export function segmentNewsOf(world: BeatWorld): readonly SegmentAnnouncement[] {
  let known = news.get(world);
  if (known === undefined) news.set(world, (known = segmentNewsOfWorld(world)));
  return known;
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

function beatOf(world: BeatWorld): Beat {
  const params = nativeRule(world.rules, 'pacing')?.params as PacingRuleParams | undefined;
  if (params?.finale === undefined) return () => null;
  const { finale, keeper } = params;
  const refs = params.behaviours ?? [];
  // Boss je poslední předloha chování (`withPacing`).
  const foes = finale === 'boss' ? refs.slice(0, -1) : refs;
  const on = finaleOn(world, finale, keeper, finale === 'boss' ? refs.slice(-1) : []);
  if (segmentPaced(params)) {
    // Úseky místo stupňování: poslední úsek, jehož změna už nastala.
    const happened = [...segmentNewsOf(world)].reverse();
    return (state) => {
      if (on(state)) return finale;
      return happened.find((item) => (item.by === 'reached' ? reachedOf(state, keeper) : playerZ(state)) >= item.at)?.beat ?? null;
    };
  }
  return (state) => {
    if (on(state)) return finale;
    return foes.length > 0 && behaviourBodies(state, state[HEADER.player] as number, foes).length > 0 ? 'buildUp' : null;
  };
}

const beats = new WeakMap<object, Beat>();

/**
 * Co hra právě teď ohlásí (banner P45C T16): běžící finále, jinak u hry se scénářem úseků úsek, jehož změna už
 * nastala (`segmentNewsOf`), u jiné `buildUp`, když je na ploše nové chování, jinak `null`. Hra bez finále
 * v pravidle `pacing` nemá žádnou chvíli – ani se svými chováními. Jen čte stav.
 */
export function pacingBeatOf(world: BeatWorld, state: Int32Array): PacingBeat | null {
  let beat = beats.get(world);
  if (beat === undefined) beats.set(world, (beat = beatOf(world)));
  return beat(state);
}
