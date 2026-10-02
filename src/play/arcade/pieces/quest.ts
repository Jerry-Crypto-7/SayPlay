/**
 * Úkol – režimy `quest_spatial` a `quest_station` (P32G T2).
 *
 * Oba hrají na ovládání `move_free` a cíle mění stav pravidlem `interact`
 * (`rules/interact.ts`): hráč dojde k cíli, drží „Use“ a stav 0..2 v `flags`
 * těla (`targetStateOf`) se posune. Výhru vydá pravidlo, až jsou všechny cíle
 * v konečném stavu; prohru skládá svět zvenku – časovač specu (`timer`,
 * `arcade/compile.ts`) a v prostoru chycení pronásledovatelem (`arena_eat`).
 *
 * - **V prostoru:** 1–8 cílů po aréně 40 × 40 m, pevné kameny mezi nimi a
 *   volitelní pronásledovatelé útěku P32E (role `chaser`, scéna je kreslí
 *   modelem pronásledovatele – duchy čaroděje): `move_free` s `chase` je vede
 *   rychlostí `chaserSpeed` (40 % hráčovy) a `arena_eat` s `grace` dotek počítá
 *   jako chycení. **Férový start** jako v útěku: za zády hráče, aspoň 40 %
 *   poloviny strany daleko, celé 2 s ochrany stojí, nečinného hráče nedostihnou
 *   dřív než za 5 s. Zpomalení, dokud hráč drží „Use“, `move_free` neumí –
 *   požadavek v plánu P32G.
 * - **Na místě:** 1–3 stanoviště v řadě na pultu před hrdinou (palačinky na
 *   sporáku, díly na stole), v pořadí zleva. Krok ze stavu 1 dál jde jen v okně
 *   připravenosti (`ready`): nalít (držet), počkat, obrátit, až je zlatá.
 *   Pult přes celou šířku drží hrdinu za ním. **Přetečení** (P36A T3): kdo
 *   `QUEST.boil` tiků neposune žádný cíl, tomu hrnec přeteče (dílna se
 *   přehřeje) – pravidlo `boil_over` vezme život a hodiny jdou znovu od nuly.
 */

import { z } from 'zod';

import { type CompileRng, createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeCounter,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  type BodyInit,
  COUNTER,
  FLAG,
  HEADER,
  HIT_GRACE,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
  targetStateOf,
} from '../contract';
import type { CompiledRule } from '../rules/compile';
import type { CompiledInteract } from '../rules/interact';
import { verbSchema } from '../rules/schema';
import { ARENA, type ChaseParams, DIRECTIONS, ESCAPE, GRACE_COUNTER, checkEscapeLevel, fairReach } from './arena';
import { WAVE_LIMITS, WAVE_PLAN, entrySpots, waveOf, waveSpeedStep, wavesChasers } from './waves';

export const QUEST = {
  /** Dosah „Use“: mezera mezi obrysy hráče a cíle. */
  radius: UNIT,
  /** Délka držení, když ji spec neříká: 0,75 s na krok. */
  hold: 45,
  // V prostoru
  half: ARENA.half,
  target: { w: 800, h: 1200, d: 800 },
  /** Cíle leží v mezikruží kolem startu, aspoň `targetSpacing` od sebe a `wallClearance` od stěny. */
  targetRing: [4 * UNIT, 15 * UNIT] as const,
  targetSpacing: 4 * UNIT,
  wallClearance: 2 * UNIT,
  rock: { w: 1600, h: 1200, d: 1600 },
  /** Kámen stojí aspoň tak daleko od startu, od cíle (místo, odkud se „Use“ dosáhne, zůstane volné) a od jiného kamene. */
  rockClearance: { start: 3 * UNIT, target: 3500, rock: 3 * UNIT },
  /** 40 % hráčovy rychlosti, jako lovec arény; útěk P32E má výchozích 70. */
  chaserSpeed: 60,
  /** Nečinného hráče první pronásledovatel nedostihne dřív (AC T2; útěk sám drží 5 s). */
  idleContactTicks: 4 * ARCADE_HZ,
  /** Pronásledovatel od jiného (útěk: dva směry po 11,25° na férové vzdálenosti, ~5 m), od cíle a od kamene. */
  chaserSpacing: 4 * UNIT,
  chaserTargetClearance: 3 * UNIT,
  chaserRockClearance: 3 * UNIT,
  // Na místě
  stationHalf: 5 * UNIT,
  stationSpacing: 2 * UNIT,
  counter: { z: UNIT, h: 900, d: 800 },
  station: { w: 600, h: 300, d: 600 },
  /** Peče se 1,5 s, pak je 1 s zlatá; minutou chvíli se peče znovu. */
  ready: { after: 90, window: 60 },
  /**
   * Přetečení (P36A T3): tolik tiků bez pokroku stojí život. 8 s – robot posune
   * cíl nejpozději za ~1,5 s (`ready.after`), člověk, který se rozkouká, má
   * rezervu; nečinný přijde o tři životy za 24 s, dřív než mu doběhne nejkratší
   * kolo úkolu (40 s).
   */
  boil: 8 * ARCADE_HZ,
  /**
   * Kola (P36A T4): po dokončení všech cílů přijde další kolo, výhra až
   * v posledním. Odhad robota na kolo (s): v prostoru `spatialBase +
   * spatialPerStep × kroky + perChaser × (pronásledovatelé − 1)`, na místě
   * součet stanovišť (držení, u tří stavů i pečení) a `walk` mezi nimi (sonda
   * T4 na 48 větách: 5 cílů po 1 kroku ve třech kolech 44–77 s, medián 55 s;
   * 8 cílů ve třech kolech 73 s a na 2 semínkách ze 3 přes hodiny; 2 stanoviště
   * po 2 krocích 4 s na kolo). Kol je tolik, aby odhad dosáhl `target +
   * targetPerStep × kroky kola` s, pokud další kolo nepřetáhne `ceiling`.
   */
  rounds: {
    spatialBase: 4,
    spatialPerStep: 2.5,
    perChaser: 2,
    walk: 0.4,
    target: 36,
    targetPerStep: 1,
    ceiling: 66,
    /** Stanoviště se dvěma stavy (oprava): držení 1 s, jinak je kolo dvou stanovišť za 1 s a kol by bylo přes strop. */
    stationHold: ARCADE_HZ,
    /** Cíle dalších kol v mezikruží: uprostřed by je robot před pronásledovatelem nesebral (jako věci vln arény). */
    ring: [WAVE_PLAN.itemHole, 15 * UNIT] as const,
    /** Přetečení v posledním kole: lhůta klesá po kolech až sem (aspoň 1,5× celého kroku stanoviště). */
    boilLast: 4 * ARCADE_HZ,
  },
} as const;

/** Tolik pokusů má každé náhodné umístění, pak generátor úroveň odmítne. */
const ATTEMPTS = 200;

const states = z.union([z.literal(2), z.literal(3)]);
const hold = z.int().min(0).max(5 * ARCADE_HZ);

const spatialParams = z
  .object({
    count: z.int().min(1).max(8).default(5),
    states: states.default(2),
    hold: hold.default(QUEST.hold),
    chasers: z.int().min(0).max(ESCAPE.chasers.max).default(0),
    chaserSpeed: z.int().min(ESCAPE.chaserSpeed.min).max(ESCAPE.chaserSpeed.max).default(QUEST.chaserSpeed),
    rocks: z.int().min(0).max(6).default(3),
    verb: verbSchema.default('use'),
    /** Délku kola nese časovač specu; generátor ji jen přijme z `controlParams` arény. */
    seconds: z.int().min(20).max(80).optional(),
    /** Kola (P36A T4, píše je žánr): tolik kol po `count` cílech; bez nich jedno kolo jako dřív. */
    rounds: z.int().min(2).max(WAVE_LIMITS.rounds).optional(),
    /** Hlídka (P36A T8, píše žánr): pronásledovatelé honí až hráče v dohledu (`ChaseParams.patrol`). */
    patrol: z.int().min(UNIT).max(40 * UNIT).optional(),
  })
  .strict();
export type QuestSpatialParams = z.infer<typeof spatialParams>;

const stationParams = z
  .object({
    count: z.int().min(1).max(3).default(2),
    states: states.default(3),
    hold: hold.default(30),
    after: z.int().min(1).max(10 * ARCADE_HZ).default(QUEST.ready.after),
    window: z.int().min(ARCADE_HZ / 2).max(10 * ARCADE_HZ).default(QUEST.ready.window),
    verb: verbSchema.default('use'),
    seconds: z.int().min(20).max(80).optional(),
    rounds: z.int().min(2).max(WAVE_LIMITS.rounds).optional(),
  })
  .strict();
export type QuestStationParams = z.infer<typeof stationParams>;

const PLAYER = (x: number, zz: number): BodyInit => ({ role: 'player', kind: 'player', x, y: 0, z: zz, w: ARENA.startSize, h: ARENA.height, d: ARENA.startSize, solid: false });

const CHASER = { w: ESCAPE.chaserSize, d: ESCAPE.chaserSize } as const;

/** Nejbližší férový start pronásledovatele útěku: 40 % poloviny strany, nebo 5 s pro nečinného hráče – co je dál. */
export const chaserStartDistance = (speed: number): number => Math.max((QUEST.half * ESCAPE.minDistancePct) / 100, fairReach(speed, PLAYER(0, 0), CHASER)) + ESCAPE.distanceMargin;

// ---------------------------------------------------------------------------
// V prostoru

interface Spot {
  readonly x: number;
  readonly z: number;
}

const clear = (p: Spot, others: readonly Spot[], gap: number): boolean => others.every((o) => Math.hypot(o.x - p.x, o.z - p.z) >= gap);

interface SpatialLevel {
  readonly level: ArcadeLevel;
  readonly issues: string[];
  readonly rocks: readonly Spot[];
  /** Kola: předloha cíle a pronásledovatele (index těla) pro `arena_waves`. */
  readonly templates?: { readonly target: number; readonly chaser: number };
}

function spatialLevel(seed: number, params: QuestSpatialParams): SpatialLevel {
  const rng = createCompileRng(seed);
  const issues: string[] = [];
  const bodies: BodyInit[] = [PLAYER(0, 0)];
  const start = { x: 0, z: 0 };
  const edge = QUEST.half - QUEST.wallClearance;
  const place = (what: string, fits: (at: Spot) => boolean, pick: () => Spot): Spot | null => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const at = pick();
      if (fits(at)) return at;
    }
    issues.push(`no room for ${what}`);
    return null;
  };
  const pickIn = (limit: number) => () => ({ x: rng.int(-limit, limit), z: rng.int(-limit, limit) });

  // Pronásledovatelé první – za zády hráče (směry 16 ± `backArc`, −z) je místa málo; cíle a kameny se jim vyhnou.
  const far = chaserStartDistance(params.chaserSpeed);
  const chasers: { x: number; z: number }[] = [];
  for (let k = 0; k < params.chasers; k += 1) {
    const at = place(
      `chaser ${k + 1}`,
      (p) => clear(p, chasers, QUEST.chaserSpacing),
      () => {
        const dir = DIRECTIONS[16 + rng.int(-ESCAPE.backArc, ESCAPE.backArc)]!;
        const reach = far + rng.int(0, ESCAPE.distanceJitter);
        return { x: Math.trunc((dir.dx * reach) / 1000), z: Math.trunc((dir.dz * reach) / 1000) };
      },
    );
    if (at !== null) chasers.push(at);
  }

  const targets: { x: number; z: number }[] = [];
  for (let k = 0; k < params.count; k += 1) {
    const at = place(
      `target ${k + 1}`,
      (p) => {
        const r = Math.hypot(p.x, p.z);
        return r >= QUEST.targetRing[0] && r <= QUEST.targetRing[1] && clear(p, targets, QUEST.targetSpacing) && clear(p, chasers, QUEST.chaserTargetClearance);
      },
      pickIn(edge),
    );
    if (at !== null) targets.push(at);
  }
  for (const t of targets) bodies.push({ role: 'target', kind: 'target', x: t.x, y: 0, z: t.z, ...QUEST.target, solid: false });

  const rocks: { x: number; z: number }[] = [];
  for (let k = 0; k < params.rocks; k += 1) {
    const at = place(
      `rock ${k + 1}`,
      (p) =>
        clear(p, [start], QUEST.rockClearance.start) &&
        clear(p, targets, QUEST.rockClearance.target) &&
        clear(p, rocks, QUEST.rockClearance.rock) &&
        clear(p, chasers, QUEST.chaserRockClearance),
      pickIn(edge),
    );
    if (at !== null) rocks.push(at);
  }
  for (const r of rocks) bodies.push({ role: 'obstacle', kind: 'rock', x: r.x, y: 0, z: r.z, ...QUEST.rock, solid: true });
  const chaserAt = bodies.length;
  for (const c of chasers) bodies.push({ role: 'chaser', kind: 'chaser', x: c.x, y: 0, z: c.z, ...CHASER, h: ESCAPE.chaserHeight, solid: false, kinematic: true });
  const counters = chasers.length === 0 ? {} : { counters: { [GRACE_COUNTER]: ESCAPE.graceTicks } };
  let templates: SpatialLevel['templates'];
  if (params.rounds !== undefined) {
    // Kola: mrtvá předloha cíle (stav 0) a bez pronásledovatelů ve větě i předloha pronásledovatele (vběhne s dalším kolem).
    templates = { target: bodies.length, chaser: chasers.length === 0 ? bodies.length + 1 : chaserAt };
    bodies.push({ role: 'target', kind: 'target', x: 0, y: 0, z: 0, ...QUEST.target, solid: false, template: true });
    if (chasers.length === 0) bodies.push({ role: 'chaser', kind: 'chaser', x: 0, y: 0, z: ESCAPE.chaserSize - QUEST.half, ...CHASER, h: ESCAPE.chaserHeight, solid: false, kinematic: true, template: true });
  }
  // Sloty kola: cíle jednoho kola a pronásledovatelé, kteří přiběhnou (nejvýš `escapeChasers`).
  const level: ArcadeLevel = { bodies, length: 0, ...counters, ...(params.rounds === undefined ? {} : { spawnSlots: params.count + WAVE_PLAN.escapeChasers }) };
  return { level, issues: [...issues, ...checkQuestLevel(level, params.chaserSpeed)], rocks, ...(templates === undefined ? {} : { templates }) };
}

/**
 * Cíle jednoho z dalších kol (x, z po dvojicích): v mezikruží `QUEST.rounds.ring`
 * kolem středu, `targetSpacing` od sebe a od kamenů jako cíle první úrovně.
 */
function roundTargets(rng: CompileRng, count: number, rocks: readonly Spot[]): number[] {
  const edge = QUEST.half - QUEST.wallClearance;
  const [inner, outer] = QUEST.rounds.ring;
  const placed: Spot[] = [];
  for (let k = 0; k < count; k += 1) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const p = { x: rng.int(-edge, edge), z: rng.int(-edge, edge) };
      const r = Math.hypot(p.x, p.z);
      if (r < inner || r > outer || !clear(p, placed, QUEST.targetSpacing) || !clear(p, rocks, QUEST.rockClearance.target)) continue;
      placed.push(p);
      break;
    }
  }
  return placed.flatMap((p) => [p.x, p.z]);
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou úrovní; prázdné pole = hratelná. Pronásledovatele soudí jako útěk. */
export function checkQuestLevel(level: ArcadeLevel, chaserSpeed: number): string[] {
  const issues = checkEscapeLevel(level, { items: 0, chaserSpeed });
  if (!level.bodies.some((body) => body.role === 'target' && body.template !== true)) issues.push('no target to work on');
  // Předloha pronásledovatele dalších kol na startu neběží.
  if (level.bodies.some((body) => body.role === 'chaser' && body.template !== true) && level.counters?.[GRACE_COUNTER] !== ESCAPE.graceTicks) issues.push('chasers without the 2 s start grace');
  return issues;
}

// ---------------------------------------------------------------------------
// Na místě

function stationLevel(params: QuestStationParams): ArcadeLevel {
  const { counter, station, stationHalf, stationSpacing } = QUEST;
  const bodies: BodyInit[] = [PLAYER(0, 0)];
  // Pult přes celou šířku: hrdina zůstane za ním a chodí podél.
  bodies.push({ role: 'obstacle', kind: 'counter', x: 0, y: 0, z: counter.z, w: 2 * stationHalf, h: counter.h, d: counter.d, solid: true });
  for (let k = 0; k < params.count; k += 1) {
    const x = Math.round((k - (params.count - 1) / 2) * stationSpacing);
    bodies.push({ role: 'target', kind: 'target', x, y: counter.h, z: counter.z, ...station, solid: false });
  }
  return { bodies, length: 0 };
}

// ---------------------------------------------------------------------------
// Přetečení stanoviště (P36A T3)

/**
 * Hodiny přetečení v hashovaném stavu: čítač `reserve`. Stanoviště nemá
 * pronásledovatele, jejichž ochranu (`GRACE_COUNTER`) tenhle slot jinde nese;
 * `trigger` drží rozdělané držení `interact`, `cooldown` čte póza výstřelu
 * (`motion.ts`), `score` a `items` smějí měnit pravidla specu. HUD ho ukazuje
 * jen u střelby, a ta na stanovišti není.
 */
const BOIL_COUNTER = 'reserve' satisfies ArcadeCounter;
/** Hodnota čítače = hotové kroky × `BOIL_SPAN` + tiky od posledního kroku (nad horizont jádra). */
const BOIL_SPAN = 1 << 13;

/** Tiky od posledního posunu cíle a kolik kroků stavu bylo tehdy hotových – scéna z nich smí kreslit, jak hrnec kypí. */
export function boilOf(state: Int32Array): { readonly ticks: number; readonly done: number } {
  const value = state[HEADER.counters + COUNTER[BOIL_COUNTER]] as number;
  return { ticks: value % BOIL_SPAN, done: Math.floor(value / BOIL_SPAN) };
}

/** Hotové kroky stavu všech živých cílů – pokrok jde jen nahoru, takže jeho změna = hráč posunul cíl. */
function stepsDone(state: Int32Array): number {
  let done = 0;
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] === ROLE.target && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) done += targetStateOf(state, body);
  }
  return done;
}

/**
 * Lhůta přetečení: `QUEST.boil`, u pomalého stanoviště dvojnásobek celého
 * kroku (držení + pečení + okno), ať ji robot, který posouvá cíl bez otálení,
 * nikdy nedožije – ani s nejdelším oknem, které generátor pustí.
 */
export const boilTicks = (params: Pick<QuestStationParams, 'hold' | 'after' | 'window'>): number => Math.max(QUEST.boil, 2 * (params.hold + params.after + params.window));

const boilParams = z
  .object({
    ticks: z.int().min(ARCADE_HZ).max(ARCADE_LIMITS.maxTicks),
    /** Bez životů prohra (jako chycení v prostoru), se životy ztráta života s vteřinou milosti. */
    effect: z.enum(['lose', 'damage']),
    /** Kola (P36A T4): každé další kolo (`waveOf`) zkrátí lhůtu o `step` tiků, nejníž na `floor`. */
    step: z.int().min(1).max(ARCADE_LIMITS.maxTicks).optional(),
    floor: z.int().min(ARCADE_HZ).max(ARCADE_LIMITS.maxTicks).optional(),
  })
  .strict();

/** Lhůta přetečení stanoviště v kolech: od `boilTicks` po kolech dolů na `QUEST.rounds.boilLast`, aspoň 1,5× celého kroku. */
export function boilRounds(params: Pick<QuestStationParams, 'hold' | 'after' | 'window'>, rounds: number): { readonly step?: number; readonly floor: number } {
  const floor = Math.max(QUEST.rounds.boilLast, Math.ceil(1.5 * (params.hold + params.after + params.window)));
  const step = Math.floor((boilTicks(params) - floor) / (rounds - 1));
  return step > 0 ? { step, floor } : { floor };
}

/**
 * Každý tik: pokrok se změnil → hodiny od nuly; jinak tik navíc a po `ticks`
 * tikách bez pokroku (v kolech kratší, `step`) přetečení – život (nebo prohra)
 * a hodiny znovu od nuly. Výhra přijde vždy s posunem cíle, takže přetečení
 * v témže tiku nenastane. Nové kolo vrátí cíle do stavu 0 – i to je změna.
 */
export const boilOver: RulePiece<z.infer<typeof boilParams>> = {
  id: 'boil_over',
  params: boilParams,
  roles: ['player', 'target'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    const at = HEADER.counters + COUNTER[BOIL_COUNTER];
    const before = state[at] as number;
    const seen = boilOf(state);
    const done = stepsDone(state);
    let ticks = done === seen.done ? seen.ticks + 1 : 0;
    const effects: ArcadeEffect[] = [];
    const limit = params.step === undefined ? params.ticks : Math.max(params.floor ?? ARCADE_HZ, params.ticks - params.step * waveOf(state));
    if (ticks >= limit) {
      effects.push(params.effect === 'lose' ? { kind: 'lose' } : { kind: 'damage', amount: 1, grace: HIT_GRACE });
      ticks = 0;
    }
    const next = done * BOIL_SPAN + ticks;
    if (next !== before) effects.push({ kind: 'count', counter: BOIL_COUNTER, amount: next - before });
    return effects;
  },
};

// ---------------------------------------------------------------------------
// Díly režimů

const interactRule = (verb: string, interact: CompiledInteract): PieceRef => {
  const params: CompiledRule = { id: 'quest', verb, when: { interact }, if: [], do: [] };
  return { id: 'interact', params };
};

/** Hráč má pevnou velikost jako v útěku: skóre z `do` pravidla ho nezvětší. */
function questParts(level: ArcadeLevel, half: number, verb: string, interact: CompiledInteract, chase: ChaseParams | undefined, catchRules: PieceRef[], issues: readonly string[]): ModeParts {
  const moving = { half, size: ESCAPE.playerSize, ...(chase === undefined ? {} : { chase }) };
  return {
    control: { id: 'move_free', params: moving },
    bot: { id: 'quest_bot', params: { half, interact, ...(chase === undefined ? {} : { chase }) } },
    level,
    rules: [interactRule(verb, interact), ...catchRules],
    ...(issues.length > 0 ? { issues } : {}),
  };
}

/**
 * Životy úkolu (P36A T2): hra žánru začíná se třemi; berou je pronásledovatelé
 * v prostoru a přetečení na místě (T3). Pravidlo prohry svět nese vždy, ať jde
 * život i živě přidat (`live.ts`).
 */
const livesRules = (health: number | undefined): PieceRef[] => (health === undefined ? [] : [{ id: 'out_of_health', params: {} }]);

export const questSpatial: ModeGeneratorPiece<QuestSpatialParams> = {
  id: 'quest_spatial',
  params: spatialParams,
  roles: ['player', 'target', 'obstacle', 'chaser'],
  // Kola: předlohy a sloty jednoho kola, pravidlo kol a chycení i bez pronásledovatelů na startu.
  cost: (params) =>
    params.rounds === undefined
      ? { bodies: 1 + params.count + params.rocks + params.chasers, rules: 1 + (params.chasers > 0 ? 1 : 0) }
      : { bodies: 3 + 2 * params.count + params.rocks + params.chasers + WAVE_PLAN.escapeChasers, rules: 3 },
  generate: (seed, params) => spatialLevel(seed, params).level,
  parts: (seed, params, health) => {
    const { level, issues, rocks, templates } = spatialLevel(seed, params);
    const { rounds } = params;
    const interact: CompiledInteract = { role: ROLE.target, radius: QUEST.radius, hold: params.hold, states: params.states, ...(rounds === undefined ? {} : { rounds }) };
    // Kdo drží „Use“, stojí u cíle: pronásledovatelé zatím běží poloviční rychlostí (G-R1). V kolech každé další zrychlí.
    const patrol = params.patrol === undefined ? {} : { patrol: params.patrol };
    const chase: ChaseParams | undefined =
      rounds !== undefined
        ? { speed: params.chaserSpeed, lead: ESCAPE.lead, slowWhileUse: true, step: waveSpeedStep(rounds), ...patrol }
        : params.chasers === 0
          ? undefined
          : { speed: params.chaserSpeed, lead: ESCAPE.lead, slowWhileUse: true, ...patrol };
    // Chycení jako v útěku: mimo ochranu prohra, se životy ztráta života, nová ochrana a odhoz (P36A T2).
    const catches: PieceRef[] =
      chase === undefined
        ? []
        : [{ id: 'arena_eat', params: health === undefined ? { effect: 'lose', grace: ESCAPE.graceTicks } : { effect: 'damage', grace: ESCAPE.graceTicks, knockback: ESCAPE.knockback } }];
    if (rounds !== undefined && templates !== undefined) {
      // Kola: hotové cíle zmizí a nové leží jinde, každé druhé kolo přiběhne pronásledovatel navíc (místa losuje stream `spawn`).
      const rng = createCompileRng(seed, 'spawn');
      const spots = entrySpots(rng, QUEST.half - ESCAPE.chaserSize);
      const waves = Array.from({ length: rounds - 1 }, (_, k) => ({
        items: roundTargets(rng, params.count, rocks),
        chasers: wavesChasers(params.chasers, k + 1) - wavesChasers(params.chasers, k),
      }));
      catches.push({ id: 'arena_waves', params: { until: 'targets', done: params.states - 1, item: templates.target, chaser: templates.chaser, spots, waves } });
    }
    return questParts(level, QUEST.half, params.verb, interact, chase, [...catches, ...livesRules(health)], issues);
  },
};

/** Odhad robota na jedno kolo úkolu v prostoru (s). */
export const spatialRoundSeconds = (count: number, states: number, chasers: number): number =>
  QUEST.rounds.spatialBase + QUEST.rounds.spatialPerStep * count * (states - 1) + QUEST.rounds.perChaser * Math.max(0, chasers - 1);

/** Odhad robota na jedno kolo stanovišť (s): držení, u tří stavů i pečení, a přechody mezi stanovišti. */
export const stationRoundSeconds = (params: Pick<QuestStationParams, 'count' | 'states' | 'hold' | 'after'>): number =>
  (params.count * (params.states === 3 ? params.hold + params.after : params.hold)) / ARCADE_HZ + QUEST.rounds.walk * (params.count - 1);

/**
 * Kolik kol a odhad robota na všechna (s): kola přibývají, dokud odhad nedosáhne
 * `target + targetPerStep × kroky kola`, a další kolo nesmí přetáhnout `ceiling`.
 * Jedno kolo (žánr pak `rounds` nepíše) zbude jen dlouhé práci: 8 hořících
 * stromů se třemi pronásledovateli trvá samo ~48 s. `round(k)` = odhad kola `k`.
 */
export function questRounds(steps: number, round: (k: number) => number): { readonly rounds: number; readonly seconds: number } {
  const target = QUEST.rounds.target + QUEST.rounds.targetPerStep * steps;
  let rounds = 1;
  let seconds = round(0);
  while (rounds < WAVE_LIMITS.rounds && seconds < target && seconds + round(rounds) <= QUEST.rounds.ceiling) {
    seconds += round(rounds);
    rounds += 1;
  }
  return { rounds, seconds };
}

export const questStation: ModeGeneratorPiece<QuestStationParams> = {
  id: 'quest_station',
  params: stationParams,
  roles: ['player', 'target', 'obstacle'],
  cost: (params) => ({ bodies: 2 + params.count, rules: params.rounds === undefined ? 2 : 3 }),
  generate: (_seed, params) => stationLevel(params),
  parts: (_seed, params, health) => {
    const { rounds } = params;
    const interact: CompiledInteract = {
      role: ROLE.target,
      radius: QUEST.radius,
      hold: params.hold,
      states: params.states,
      order: true,
      ready: { after: params.after, window: params.window },
      ...(rounds === undefined ? {} : { rounds }),
    };
    // Přetečení (P36A T3): kdo stojí, přijde o život, bez životů o hru – jako chycení v prostoru. V kolech je lhůta čím dál kratší.
    const boil: PieceRef = { id: 'boil_over', params: { ticks: boilTicks(params), effect: health === undefined ? 'lose' : 'damage', ...(rounds === undefined ? {} : boilRounds(params, rounds)) } };
    const rules = [boil, ...livesRules(health)];
    // Kola: hotová stanoviště začnou znovu od stavu 0 (další objednávka na tomtéž sporáku).
    if (rounds !== undefined) rules.push({ id: 'arena_waves', params: { until: 'targets', done: params.states - 1, spots: [], waves: Array.from({ length: rounds - 1 }, () => ({})) } });
    return questParts(stationLevel(params), QUEST.stationHalf, params.verb, interact, undefined, rules, []);
  },
};
