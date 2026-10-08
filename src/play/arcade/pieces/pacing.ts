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
import { ARCADE_LIMITS, type ArcadeEffect, BODY, type BodyInit, type BotPiece, COUNTER, type ControlPiece, FLAG, HEADER, type PieceRef, type RulePiece, bodyBase } from '../contract';
import { ESCAPE } from './arena';
import { BEHAVIOURS, type BehaviourId, type BehaviourSpace, behaviourEffects, behaviourRefSchema, dodge, duplicateSignature, stepBehaviours } from './behaviours';
import { FIGHT } from './fight';
import { spotsAway } from './waves';

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

/** Jak hra měří postup ke cíli: ujetá trať, sebrané věci, skóre, padlí soupeři, nebo jen čas. */
export const pacingGoalSchema = z
  .object({
    by: z.enum(['distance', 'items', 'score', 'fallen', 'time']),
    /** Délka trati v jednotkách, potřebné věci, cílové skóre, počet soupeřů, nebo tiky (`time`). */
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
  } else done = state[HEADER.tick] as number;
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
 * Husté tam, kde je křivka vysoko. Statické žánry (rytmus) staví nad ním noty.
 */
export function placeByCurve(curve: TensionCurve, n: number, rng?: CompileRng): number[] {
  const cumulative: number[] = [0];
  for (let p = 0; p < 1000; p += 1) cumulative.push((cumulative[p] as number) + Math.max(0, intensityAt(p, curve) - PACING.spawnFloor));
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

/** Rozvrh `budget` spawnů z `kinds` chování; ve vrcholu a finále přijdou po dvou. Jen při stavbě. */
export function scheduleOf(rng: CompileRng, curve: TensionCurve, budget: number, kinds = 1): ScheduleEntry[] {
  return placeByCurve(curve, budget, rng).map((atPermille) => ({
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
const controlParams = z.object({ base: refSchema, goal: pacingGoalSchema, keeper: z.int().min(1), behaviours: behaviourRefs.optional(), space: z.enum(['plane', 'track']).optional() }).strict();
const botParams = z.object({ base: refSchema, control: z.string(), keeper: z.int().min(1), behaviours: behaviourRefs.optional() }).strict();

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

/** Intenzita podle nejvyššího dosaženého postupu v počítadle. */
const intensityOf = (state: Int32Array, keeper: number): number => intensityAt(reachedOf(state, keeper), TENSION_CURVE);

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
      native.step(state, player, input, scaledParams(params.base.id, own, intensity));
      if (params.behaviours !== undefined) stepBehaviours(state, player, params.behaviours, params.space ?? 'plane', intensity, typeof own.half === 'number' ? own.half : undefined);
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
      const input = native.decide(observation, scaledParams(params.control, parseOnce(native, params.base.params), intensityOf(observation.state, params.keeper)));
      return params.behaviours === undefined ? input : dodge(observation, params.behaviours, params.control, input);
    },
  };
}

export const FINALES = ['boss', 'wave', 'sprint', 'round', 'escape'] as const;

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
    const due = params.schedule.filter((entry) => entry.atPermille > before && entry.atPermille <= reached);
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
        effects.push({ kind: 'spawn', template: entry.template, x, y: 0, z, vx: 0, vy: 0, vz: 0 });
      }
    }
    return effects;
  },
};

/** Předloha spawnu; s `behaviour` ji hýbe a nechá udeřit rámec chování (`behaviours/index.ts`). */
export interface PacingActor {
  readonly body: BodyInit;
  readonly behaviour?: BehaviourId;
}

/** Co `withPacing` přidá: jak hra měří postup, kde se vstupuje, předlohy chování a kolik spawnů. */
export interface PacingSetup {
  readonly seed: number;
  readonly goal: PacingGoal;
  readonly space: BehaviourSpace;
  readonly spots: readonly number[];
  /** Předlohy spawnů (`template: true`); prázdné = jen křivka bez spawnů. */
  readonly behaviours: readonly PacingActor[];
  readonly budget: number;
  readonly finale?: (typeof FINALES)[number];
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
  const shooters = [...new Set(setup.behaviours.flatMap((actor) => (actor.behaviour !== undefined && BEHAVIOURS[actor.behaviour].shot !== undefined ? [actor.behaviour] : [])))];
  const shotBodies = shooters.map((id) => BEHAVIOURS[id].shot as BodyInit);
  const keeper = first + setup.behaviours.length + shooters.length;
  const duplicate = duplicateSignature([...setup.behaviours.map((actor) => actor.body), ...shotBodies]);
  if (duplicate !== null) return { ...parts, issues: [...(parts.issues ?? []), `pacing: two spawn templates share the signature ${duplicate} (role:kind:w:h:d)`] };
  const shotOf = (id: BehaviourId): { shot?: number } => (shooters.includes(id) ? { shot: first + setup.behaviours.length + shooters.indexOf(id) } : {});
  const refs = setup.behaviours.flatMap((actor, index) => (actor.behaviour === undefined ? [] : [{ id: actor.behaviour, template: first + index, ...shotOf(actor.behaviour) }]));
  const moved = refs.length === 0 ? {} : { behaviours: refs };
  const bodies = [...parts.level.bodies, ...[...setup.behaviours.map((actor) => actor.body), ...shotBodies].map((body) => ({ ...body, template: true })), pacingKeeper(parts.level.bodies[0]?.kind ?? 'player')];
  const schedule = setup.behaviours.length === 0 || setup.budget === 0 ? [] : scheduleOf(createCompileRng(setup.seed, 'pacing'), TENSION_CURVE, setup.budget, setup.behaviours.length)
    .map((entry) => {
      const actor = setup.behaviours[entry.behaviour]?.behaviour;
      // Hejno je jeden spawn celé, i ve vrcholu (dvě hejna naráz by přetekla `maxActors`).
      const group = actor === undefined ? undefined : BEHAVIOURS[actor].group;
      return { atPermille: Math.max(1, entry.atPermille), template: first + entry.behaviour, count: group?.size ?? entry.count, entry: entry.entry };
    });
  const half = parts.control.params.half;
  const edge = setup.space === 'plane' && shooters.length > 0 && typeof half === 'number' ? { half } : {};
  const rule: PieceRef | null = schedule.length === 0 && setup.finale === undefined && refs.length === 0 ? null : {
    id: 'pacing', params: { keeper, schedule, spots: [...setup.spots], space: setup.space, maxActors: PACING.maxActors, ...(setup.finale === undefined ? {} : { finale: setup.finale }), ...moved, ...edge },
  };
  const slots = (schedule.length === 0 ? 0 : PACING.maxActors) + (shooters.length === 0 ? 0 : PACING.maxShots);
  return {
    ...parts,
    control: { id: 'pacing_control', params: { base: parts.control, goal: setup.goal, keeper, ...moved, ...(refs.length === 0 ? {} : { space: setup.space }) } },
    bot: { id: 'pacing_bot', params: { base: parts.bot, control: parts.control.id, keeper, ...moved } },
    level: { ...parts.level, bodies, spawnSlots: (parts.level.spawnSlots ?? 0) + slots },
    rules: rule === null ? parts.rules : [...parts.rules, rule],
  };
}
