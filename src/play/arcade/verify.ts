/**
 * Ověření arkádové hry (P25A, T4) – brána publikace.
 *
 * Hra je publikovatelná, když robot se zpožděním reakce vyhraje do horizontu
 * (90 s), nečinný hráč nevyhraje, dvě nezávislá přehrání robotova záznamu
 * skončí týmž hashem a svět je v mezích jádra. Výsledek jde do tvaru
 * `QualityReport` (`arcadeReport`), aby publikace, feed a sdílení zůstaly
 * jedna cesta s dnešními hrami.
 */

import type { KeypointEvidence, QualityReport, VerbProof } from '@/play/contracts';
import { createStreams, nextInt } from '@/sim/rng';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeObservation,
  type ArcadeState,
  type ArcadeWorld,
  BODY,
  COUNTER,
  FIRED,
  FLAG,
  HEADER,
  type InputEvent,
  LOGIC_SLOTS,
  LOGIC_VAR_SLOTS,
  type LogicNames,
  NO_INPUT,
  UNIT,
  bodyBase,
  bodyHp,
  logicBase,
  phaseOf,
  targetStateOf,
  timerLeft,
  varValue,
} from './contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, replay, step } from './kernel';
import { underlyingRule } from './addons';
import { ARCADE_LIBRARY } from './library';
import { releasePhysics } from './physics/step';
import { avoidingLosses, lossPlanner, losingVerbs, rulesPlanner } from './rules/bot';
import { type CompiledRule, SPEC_RULES } from './rules/compile';
import { type ActionWitness, type RoleBinding, WitnessRecorder, threatProbeInput } from './witness';
import { pacingProbeBodies } from './pieces/pacing-parts';

export interface BotRun {
  readonly witnesses: readonly ActionWitness[];
  readonly inputs: readonly InputEvent[];
  readonly outcome: ArcadeOutcome;
  readonly tick: number;
  readonly hash: string;
  /** Kde hráč skončil (metry trati) – pro důvod prohry. */
  readonly distanceM: number;
  /** Tik prvního výstřelu každého pravidla světa (index jako `world.rules`), −1 = nevystřelilo (P29A). */
  readonly firstFired: readonly number[];
  /** Sloveso → první naměřená změna stavu po výstřelu jeho pravidla (P30B T2); chybí = žádná. */
  readonly changes: ReadonlyMap<string, string>;
  /** Kostky logiky a jejich důkaz tímto během (P45B T7); svět bez logiky a bez vln = []. */
  readonly logic: readonly LogicProof[];
}

// ---------------------------------------------------------------------------
// Změna stavu za slovesem (P30B T2)

/** Tělo po `push` / `throwHeld`, které musí ujet aspoň jednotku, aby sloveso platilo. */
interface Motion {
  readonly verb: string;
  readonly body: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly tick: number;
}

const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const heldOf = (state: ArcadeState): number => (state[HEADER.held] as number) - 1;
const heldName = (body: number): string => (body < 0 ? 'nothing' : `body ${String(body)}`);
const counterAt = (state: ArcadeState, counter: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[counter]] as number;
const RESPAWN = [HEADER.respawnX, HEADER.respawnY, HEADER.respawnZ] as const;

/**
 * Proměnné a fáze těsně před efektem a jména deklarace (P45B T7). Mění je jen efekty logiky
 * a každou jejich změnu jádro ohlásí stopou, takže stín, který běh robota posune po každé
 * stopě (`LogicLedger.traced`), je přesný i při dvou změnách v jednom tiku.
 */
interface LogicPrior {
  readonly names: LogicNames | undefined;
  readonly vars: number[];
  phase: number;
}

/** Svět bez logiky: efekt logiky v něm nevznikne. */
const NO_LOGIC: LogicPrior = { names: undefined, vars: [], phase: 0 };

/** Jméno z deklarace; svět postavený bez specu jména nemá a dostane index. */
const nameOf = (names: readonly string[] | undefined, index: number): string => names?.[index] ?? String(index);

/**
 * Změna, kterou třída efektu slibuje. `after` je stav hned po tom efektu (stopa
 * jádra); `null` = efekt se provedl naprázdno. Výsledek hry (`win` / `lose`)
 * rozhodne až konec tiku a posun těla po `push` / `throwHeld` další tiky – ty
 * měří volající.
 *
 * Mimo čítače se všechno soudí podmínkou na `after`, ne srovnáním se začátkem
 * tiku: jádro efekt ohlásí jen za provedenou změnu, a co se v tiku stalo dřív
 * (míč zanikl a spawn dostal jeho slot, hráč vyběhl ze startu, první značka
 * posunula bod návratu), by srovnání se začátkem tiku schovalo nebo přičetlo
 * (revize fáze 1 P30B, R1). Proměnná a fáze se srovnají se stínem `prior` těsně
 * před efektem – „lives 3→2“ potřebuje hodnotu před ním.
 */
function changeOf(effect: ArcadeEffect, after: ArcadeState, tick: number, prior: LogicPrior): string | null {
  const at = `at tick ${String(tick)}`;
  // Čítač jádro posune přesně o `amount`; jiné zdroje téhož tiku (běžec boduje minci sám) se nepočítají.
  const counter = (name: keyof typeof COUNTER, amount: number): string | null =>
    amount === 0 ? null : `${name} ${amount > 0 ? '+' : ''}${String(amount)} (now ${String(counterAt(after, name))}) ${at}`;
  switch (effect.kind) {
    case 'score':
      return counter('score', effect.amount);
    case 'count':
      return counter(effect.counter, effect.amount);
    case 'damage':
      return counter('health', -effect.amount);
    case 'win':
    case 'lose':
    // Kombo je zápis počítadla k sebrání – změnu za slovesem dokládá skóre téhož pravidla.
    case 'combo':
      return null;
    case 'despawn':
      return effect.body >= 0 && effect.body < (after[HEADER.bodyCount] as number) && !alive(after, effect.body) ? `body ${String(effect.body)} gone ${at}` : null;
    case 'spawn': {
      // Nové tělo stojí přesně tam, kam ho efekt poslal, a má roli předlohy.
      const role = after[bodyBase(effect.template) + BODY.role];
      for (let body = after[HEADER.spawnBase] as number; body < (after[HEADER.bodyCount] as number); body += 1) {
        const base = bodyBase(body);
        const placed = after[base + BODY.x] === effect.x && after[base + BODY.y] === effect.y && after[base + BODY.z] === effect.z;
        if (alive(after, body) && placed && after[base + BODY.role] === role) return `body ${String(body)} appeared ${at}`;
      }
      return null;
    }
    // Kdo se držel na začátku tiku, důkaz nejmenuje: v tiku se to mohlo změnit (R1).
    case 'grab':
      return heldOf(after) === effect.body ? `grabbed ${heldName(effect.body)} ${at}` : null;
    case 'release':
      return heldOf(after) === -1 ? `let go ${at}` : null;
    case 'toggle': {
      // Jádro přepnuté tělo označí, ať ho druhé přepnutí nevrátí. Příznak zůstává z dřívějších tiků
      // i u kopií předlohy, proto důkaz tělesa nepočítá – že se v tiku něco přeplo, ručí stopa jádra.
      for (let body = 0; body < (after[HEADER.bodyCount] as number); body += 1) {
        const base = bodyBase(body);
        if (after[base + BODY.role] === effect.role && ((after[base + BODY.flags] as number) & FLAG.switched) !== 0) return `role ${String(effect.role)} switched ${at}`;
      }
      return null;
    }
    case 'respawn': {
      // Návrat odjinud hlásí jádro (i hráči, který tik začal na bodu návratu a pak se pohnul, R1).
      const p = bodyBase(after[HEADER.player] as number);
      const home = [BODY.x, BODY.y, BODY.z].every((slot, axis) => after[p + slot] === after[RESPAWN[axis] as number]);
      return home ? `player back at the respawn point ${at}` : null;
    }
    case 'checkpoint':
      // Posun bodu návratu hlásí jádro; srovnání se začátkem tiku by za posun vydalo i druhou značku na totéž místo.
      return `respawn point moved ${at}`;
    case 'push':
    case 'throwHeld':
    case 'knockback':
      return null;
    case 'heal':
      return `body ${String(effect.body)} healed, hp now ${String(bodyHp(after, effect.body))} ${at}`;
    // Švy P32-0 T4: jádro efekt ohlásí jen za skutečnou změnu HP nebo stavu cíle.
    case 'hit':
      return `body ${String(effect.body)} hit, hp now ${String(bodyHp(after, effect.body))} ${at}`;
    case 'stateChange':
      return `body ${String(effect.body)} now in state ${String(targetStateOf(after, effect.body))} ${at}`;
    // Logika (P45B T7): proměnná a fáze proti stínu před efektem, časovač a událost podmínkou na `after`.
    case 'setVar':
    case 'addVar': {
      const from = prior.vars[effect.var] as number;
      const to = varValue(after, logicBase(after), effect.var);
      return from === to ? null : `var ${nameOf(prior.names?.var, effect.var)} ${String(from)}→${String(to)} ${at}`;
    }
    case 'goPhase': {
      const to = phaseOf(after, logicBase(after));
      return prior.phase === to ? null : `phase ${nameOf(prior.names?.phase, prior.phase)}→${nameOf(prior.names?.phase, to)} ${at}`;
    }
    case 'startTimer':
      return timerLeft(after, logicBase(after), effect.timer) === effect.ticks ? `timer ${nameOf(prior.names?.timer, effect.timer)} started (${String(effect.ticks)} ticks) ${at}` : null;
    case 'stopTimer':
      return timerLeft(after, logicBase(after), effect.timer) === 0 ? `timer ${nameOf(prior.names?.timer, effect.timer)} stopped ${at}` : null;
    case 'emit':
      return (((after[logicBase(after) + LOGIC_SLOTS.eventPending] as number) >>> effect.event) & 1) === 1 ? `event ${nameOf(prior.names?.event, effect.event)} sent ${at}` : null;
    // Západka je účetnictví spouštěče, ne viditelná změna.
    case 'latch':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Důkaz kostek logiky (P45B T7)

/** Druh kostky logiky: deklarace bloku `logic` a vlna v pravidle. */
export type LogicProofKind = 'var' | 'timer' | 'phase' | 'event' | 'wave';

/** Kostka logiky a její důkaz robotovým během – obdoba `VerbProof`. */
export interface LogicProof {
  readonly kind: LogicProofKind;
  /** Jméno z deklarace `logic`, u vlny id pravidla ze specu. */
  readonly id: string;
  /** Na kostku něco sáhlo: zápis proměnné, start časovače, přechod do fáze, vyslání události, výstřel pravidla s vlnou. */
  readonly fired: boolean;
  readonly changed: boolean;
  /** Viditelná změna, kterou robot naměřil; `null` = žádná. */
  readonly evidence: string | null;
}

const DECLARED = ['var', 'timer', 'phase', 'event'] as const;

/** Pravidlo specu s vlnou: index ve světě, id ze specu a předlohy jeho vln. */
interface WaveRule {
  readonly rule: number;
  readonly id: string;
  readonly templates: readonly number[];
}

/** Pravidla specu s vlnou v pořadí pravidel světa, i pod obalem složené hry. */
function waveRules(world: ArcadeWorld): WaveRule[] {
  return world.rules.flatMap((ref, rule) => {
    const native = underlyingRule(ref);
    if (!(native.id in SPEC_RULES)) return [];
    const params = native.params as CompiledRule;
    const templates = params.do.flatMap((effect) => ('wave' in effect ? [effect.wave.template] : []));
    return templates.length === 0 ? [] : [{ rule, id: params.id, templates }];
  });
}

/** Klíč kostky, které se efekt týká; `null` = efekt není logika (nebo je to západka). */
function keyOf(effect: ArcadeEffect): string | null {
  switch (effect.kind) {
    case 'setVar':
    case 'addVar':
      return `var:${String(effect.var)}`;
    case 'goPhase':
      return `phase:${String(effect.phase)}`;
    case 'startTimer':
    case 'stopTimer':
      return `timer:${String(effect.timer)}`;
    case 'emit':
      return `event:${String(effect.event)}`;
    default:
      return null;
  }
}

const liveOfRole = (state: ArcadeState, role: number): number => {
  let live = 0;
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (alive(state, body) && state[bodyBase(body) + BODY.role] === role) live += 1;
  return live;
};

/** Bity výstřelu průchodu logiky (bez čerstvých časovačů): mimo průchody logiky je jádro drží na 0. */
const PASS_BITS = (1 << FIRED.freshTimer) - 1;

/**
 * Co robotův běh naměřil na kostkách logiky. Vystřelila = pravidla vydala efekt kostky (i
 * naprázdno; časovač jen startem), u vlny vystřelilo její pravidlo. Změna = stopa jádra
 * (proměnná, vstup do fáze, zastavení časovače, vyslaná událost), časovač, který doběhl,
 * a víc živých těl role vlny na konci tiku, ve kterém vlna něco zrodila. Počáteční fázi
 * jádro vstoupí v tiku 0 samo.
 */
class LogicLedger {
  readonly prior: LogicPrior;
  private readonly fired = new Set<string>();
  private readonly evidence = new Map<string, string>();
  private readonly waves: readonly WaveRule[];
  /** Časovače (bit na časovač), které v tomto tiku před průchodem časovačů někdo spustil či zastavil. */
  private touched = 0;
  /** Vlny, jejichž spawn jádro v tomto tiku ohlásilo. */
  private readonly spawned = new Set<WaveRule>();
  // Pole vypsané zvlášť, ne `private readonly` v parametru: skripty čtou tenhle soubor přes
  // odstranění typů v Node (strip-only), které vlastnosti v parametrech konstruktoru neumí.
  private readonly world: ArcadeWorld;

  private constructor(world: ArcadeWorld, initial: ArcadeState, waves: readonly WaveRule[]) {
    this.world = world;
    const base = world.logic === undefined ? -1 : logicBase(initial);
    this.prior = base < 0 ? { names: undefined, vars: [], phase: 0 } : { names: world.logic?.names, vars: LOGIC_VAR_SLOTS.map((_, index) => varValue(initial, base, index)), phase: phaseOf(initial, base) };
    this.waves = waves;
    const start = this.prior.names?.phase[0];
    if (start !== undefined) {
      this.fired.add('phase:0');
      this.evidence.set('phase:0', `phase ${start} entered at the start (tick 0)`);
    }
  }

  /** Kniha jen pro svět s logikou nebo s vlnou; jinak `null` a běh robota nic navíc neměří. */
  static of(world: ArcadeWorld, initial: ArcadeState): LogicLedger | null {
    const waves = waveRules(world);
    return world.logic === undefined && waves.length === 0 ? null : new LogicLedger(world, initial, waves);
  }

  /** Stopa jádra: změna kostky a posun stínu. Volá se až po důkazu slovesa, který čte stín před efektem. */
  traced(rule: number, effect: ArcadeEffect, after: ArcadeState, tick: number): void {
    if (effect.kind === 'spawn') {
      for (const wave of this.waves) if (wave.rule === rule && wave.templates.includes(effect.template)) this.spawned.add(wave);
      return;
    }
    const key = keyOf(effect);
    if (key === null) return;
    // Start či stop mimo průchody logiky předejde průchodu časovačů téhož tiku: ten časovač v tiku nedoběhne.
    if ((effect.kind === 'startTimer' || effect.kind === 'stopTimer') && ((after[logicBase(after) + LOGIC_SLOTS.fired] as number) & PASS_BITS) === 0) this.touched |= 1 << effect.timer;
    // Start časovače je výstřel, ne důkaz: časovač musí doběhnout nebo ho někdo zastaví.
    if (effect.kind !== 'startTimer' && !this.evidence.has(key)) {
      const change = changeOf(effect, after, tick, this.prior);
      if (change !== null) this.evidence.set(key, change);
    }
    if (effect.kind === 'setVar' || effect.kind === 'addVar') this.prior.vars[effect.var] = varValue(after, logicBase(after), effect.var);
    if (effect.kind === 'goPhase') this.prior.phase = phaseOf(after, logicBase(after));
  }

  /** Efekty, které pravidla v tiku vydala, i naprázdno. Stop bez startu nevystřelí – časovač neběžel. */
  issued(effects: readonly ArcadeEffect[]): void {
    for (const effect of effects) {
      const key = effect.kind === 'stopTimer' ? null : keyOf(effect);
      if (key !== null) this.fired.add(key);
    }
  }

  /** Konec tiku: časovače, které doběhly, a vlny, po kterých přibyla živá těla role. */
  settle(before: ArcadeState, after: ArcadeState, tick: number): void {
    // Průchod časovačů odečte do nuly časovač, který tik začal na 1 a hlavní průchod ho nespustil ani nezastavil.
    this.prior.names?.timer.forEach((name, timer) => {
      const key = `timer:${String(timer)}`;
      if (((this.touched >>> timer) & 1) === 0 && timerLeft(before, logicBase(before), timer) === 1 && !this.evidence.has(key)) this.evidence.set(key, `timer ${name} ran out at tick ${String(tick)}`);
    });
    this.touched = 0;
    for (const wave of this.spawned) {
      const key = `wave:${String(wave.rule)}`;
      for (const template of wave.templates) {
        const role = after[bodyBase(template) + BODY.role] as number;
        const was = liveOfRole(before, role);
        const now = liveOfRole(after, role);
        const label = (this.world.kinds[after[bodyBase(template) + BODY.kind] as number] ?? '').replace(/^thing:/, '');
        if (now > was && !this.evidence.has(key)) this.evidence.set(key, `live ${label} bodies ${String(was)}→${String(now)} at tick ${String(tick)}`);
      }
    }
    this.spawned.clear();
  }

  /** Důkazy v pořadí deklarace (proměnné, časovače, fáze, události), pak vlny v pořadí pravidel. */
  proofs(firstFired: readonly number[]): LogicProof[] {
    const names = this.prior.names;
    const declared = names === undefined ? [] : DECLARED.flatMap((kind) => names[kind].map((id, index) => ({ kind, id, key: `${kind}:${String(index)}`, fired: this.fired.has(`${kind}:${String(index)}`) })));
    const waves = this.waves.map((wave) => ({ kind: 'wave' as const, id: wave.id, key: `wave:${String(wave.rule)}`, fired: (firstFired[wave.rule] ?? -1) >= 0 }));
    return [...declared, ...waves].map(({ kind, id, key, fired }) => {
      const evidence = this.evidence.get(key) ?? null;
      return { kind, id, fired, changed: evidence !== null, evidence };
    });
  }
}

/** Proč kostka neprošla: [nevystřelila, vystřelila naprázdno] – věta pro opravné kolo (vzor `VERB_UNPROVED`). */
const LOGIC_WHY: Readonly<Record<LogicProofKind, readonly [unproved: string, noEffect: string]>> = {
  var: ['no rule wrote this var', 'rules wrote this var, but its value never changed'],
  timer: ['no rule started this timer', 'this timer started, but it never ran out and nothing stopped it'],
  phase: ['the game never entered this phase', 'a rule sent the game to this phase, but it never entered it'],
  event: ['no rule emitted this event', 'a rule emitted this event, but it was never sent'],
  wave: ['the rule with this wave never fired', 'the rule fired, but its wave added no live body'],
};

/** Tělo, kterým `push` / `throwHeld` hýbe, a kde bylo před tikem výstřelu. */
function motionOf(verb: string, effect: ArcadeEffect, before: ArcadeState, tick: number): Motion | null {
  const body = effect.kind === 'push' ? effect.body : effect.kind === 'throwHeld' ? heldOf(before) : -1;
  if (body < 0 || body >= (before[HEADER.bodyCount] as number)) return null;
  const base = bodyBase(body);
  return { verb, body, x: before[base + BODY.x] as number, y: before[base + BODY.y] as number, z: before[base + BODY.z] as number, tick };
}

/**
 * Jak dlouho po výstřelu `push` / `throwHeld` se posun těla počítá (R1). Strčené tělo
 * (160 j/tik, tření 8 j/tik) ujede metr za 8 tiků a do 20 se zastaví, hozené za 5.
 */
const MOTION_TICKS = 20;

/**
 * Okno pohybu (R1): jen živé, nenesené tělo a jen `MOTION_TICKS` po výstřelu. Jinak sloveso
 * dokázal kterýkoli pozdější posun – kámen, se kterým push nehnul, pak nese hráč a hodí.
 * Exportované pro test.
 */
export function motionOpen(motion: Motion, state: ArcadeState, tick: number): boolean {
  return tick - motion.tick <= MOTION_TICKS && alive(state, motion.body) && heldOf(state) !== motion.body;
}

/** Ujelo tělo od výstřelu aspoň jednotku? Celočíselně, ať výsledek nezávisí na stroji. Exportované pro test. */
export function movedOf(motion: Motion, state: ArcadeState): string | null {
  const base = bodyBase(motion.body);
  const dx = (state[base + BODY.x] as number) - motion.x;
  const dy = (state[base + BODY.y] as number) - motion.y;
  const dz = (state[base + BODY.z] as number) - motion.z;
  const squared = dx * dx + dy * dy + dz * dz;
  if (squared < UNIT * UNIT) return null;
  return `body ${String(motion.body)} moved ${(Math.sqrt(squared) / UNIT).toFixed(1)} m after tick ${String(motion.tick)}`;
}

export const BOT_PROFILES = {
  novice: { extraReactionTicks: 12, errorPerThousand: 350, errorTicks: 12, decisionWindowTicks: 60 },
  intermediate: { extraReactionTicks: 4, errorPerThousand: 150, errorTicks: 4, decisionWindowTicks: 60 },
} as const;
export type BotProfile = keyof typeof BOT_PROFILES;

/**
 * Odehraje hru robotem. Robot v tiku *t* vidí stav z tiku *t − reactionTicks*
 * (kruhový buffer kopií) a vlastní stisky z té doby, které ještě nevidí.
 */
export function runBot(world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY, options: {
  readonly planner?: boolean;
  readonly seek?: ReadonlySet<string>;
  readonly roleBindings?: readonly RoleBinding[];
  readonly probeBody?: number;
  readonly runId?: string;
  readonly threatProofs?: readonly ActionWitness[];
  /** Measurement only: never changes the world's program or its default bot. */
  readonly profile?: BotProfile;
} = {}): BotRun {
  const piece = library.bots[world.bot.id];
  if (piece === undefined) throw new Error(`arcade: unknown bot ${world.bot.id}`);
  const params = piece.params.parse(world.bot.params);
  // Hru, kterou vyhrávají pravidla specu, hraje plánovač cílů (P29A); `planner: false` = kontrolní běh robotem světa.
  // `seek` = běh „na prohru“ (P36A T8): plánovač jde do pravidel prohry s těmi slovesy.
  const planner = options.seek !== undefined ? lossPlanner(world, options.seek) : options.planner === false ? null : rulesPlanner(world);
  // Robot světa obchází tělesa pravidel prohry (P36A F2); do nich jde jen běh „na prohru“.
  const bot = planner ?? { reactionTicks: piece.reactionTicks, decide: avoidingLosses(world, (observation: ArcadeObservation) => piece.decide(observation, params)) };
  // Slovesa pravidel: stav na začátku tiku, ať jde změnu po efektu změřit (P30B T2).
  const verbOf = world.rules.map(underlyingRule).map((ref) => (typeof ref.params.verb === 'string' ? ref.params.verb : null));
  // `interact` si rozdělanou práci píše do čítače každý tik držení: sloveso úkolu dokáže jen posun stavu cíle (P32G T3).
  const stateOnly = world.rules.map((ref) => underlyingRule(ref).id === 'interact');
  const measuring = verbOf.some((verb) => verb !== null);
  const isProbe = options.probeBody !== undefined || options.seek !== undefined;
  const witness = options.roleBindings === undefined ? null : new WitnessRecorder(world, options.roleBindings, isProbe ? 'probe' : 'winner', options.runId ?? (isProbe ? 'probe' : 'winner'));
  const program = loadProgram(world, witness?.observe(library) ?? library);
  const state = instantiate(world);
  const profile = options.profile === undefined ? undefined : BOT_PROFILES[options.profile];
  // Fresh private AI stream. Sampling errors cannot consume layout/spawn state,
  // alter the world hash, or depend on the order that profiles are measured.
  const errors = profile === undefined ? undefined : createStreams(world.seed).ai;
  const delay = bot.reactionTicks + (profile?.extraReactionTicks ?? 0);
  let errorFrom = -1;
  let errorUntil = -1;
  const history = Array.from({ length: delay + 1 }, () => state.slice());
  const issued: ArcadeInput[] = [];
  const inputs: InputEvent[] = [];
  const player = state[HEADER.player] as number;
  const firstFired = world.rules.map(() => -1);
  const changes = new Map<string, string>();
  const motions: Motion[] = [];
  /** Slovesa, jejichž `win` / `lose` v tomhle tiku vystřelilo; rozhodne výsledek na konci tiku. */
  const endings: [verb: string, outcome: ArcadeOutcome][] = [];
  const before = state.slice();
  // Kostky logiky (P45B T7); svět bez logiky a bez vln knihu nemá.
  const ledger = LogicLedger.of(world, state);
  let now = 0;
  const proveVerb = (rule: number, effect: ArcadeEffect): void => {
    const verb = verbOf[rule];
    if (verb === null || verb === undefined || changes.has(verb)) return;
    if (effect.kind === 'win' || effect.kind === 'lose') {
      endings.push([verb, effect.kind === 'win' ? 'won' : 'lost']);
      return;
    }
    if (stateOnly[rule] === true && effect.kind !== 'stateChange') return;
    const change = changeOf(effect, state, now, ledger?.prior ?? NO_LOGIC);
    if (change !== null) changes.set(verb, change);
    const motion = change === null ? motionOf(verb, effect, before, now) : null;
    if (motion !== null && !motions.some((known) => known.verb === verb && known.body === motion.body)) motions.push(motion);
  };
  const trace = (rule: number, effect: ArcadeEffect): void => {
    witness?.effect(rule, effect, state, now);
    if (firstFired[rule] === -1) firstFired[rule] = now;
    proveVerb(rule, effect);
    // Až po slovesu: to čte stín logiky před efektem, kniha ho posune.
    ledger?.traced(rule, effect, state, now);
  };

  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    now = tick;
    (history[tick % (delay + 1)] as Int32Array).set(state);
    const seenAt = Math.max(0, tick - delay);
    const seen = history[seenAt % (delay + 1)] as Int32Array;
    const observation = { state: seen, player, tick: seenAt, recent: issued.slice(issued.length - (tick - seenAt)) };
    let normal = bot.decide(observation);
    if (profile !== undefined && errors !== undefined) {
      if (tick % profile.decisionWindowTicks === 0) {
        // Fixed draws per window make novice/intermediate directly comparable.
        const chance = nextInt(errors, 0, 999);
        const offset = nextInt(errors, 0, profile.decisionWindowTicks - profile.errorTicks);
        errorFrom = chance < profile.errorPerThousand ? tick + offset : -1;
        errorUntil = errorFrom < 0 ? -1 : errorFrom + profile.errorTicks;
      }
      // A brief missed input, not a mutated world or a fabricated lost outcome.
      if (tick >= errorFrom && tick < errorUntil) normal = NO_INPUT;
    }
    const input = options.probeBody === undefined ? normal : threatProbeInput(world, options.probeBody, observation, normal);
    issued.push(input);
    if (input.buttons !== 0 || input.axis !== 0) inputs.push({ tick, ...input });
    if (measuring || witness !== null || ledger !== null) before.set(state);
    const effects = step(state, input, program, trace);
    witness?.afterTick(before, state, tick);
    if (ledger !== null) {
      ledger.issued(effects);
      ledger.settle(before, state, tick);
    }
    if (!measuring) continue;
    // Výhra či prohra je změna jen tehdy, když ji tik opravdu vyhlásil (prohra má přednost).
    for (const [verb, outcome] of endings) if (!changes.has(verb) && outcomeOf(state) === outcome) changes.set(verb, `${outcome} at tick ${String(tick)}`);
    endings.length = 0;
    for (let i = motions.length - 1; i >= 0; i -= 1) {
      const motion = motions[i] as Motion;
      const open = motionOpen(motion, state, tick);
      const moved = !open || changes.has(motion.verb) ? null : movedOf(motion, state);
      if (moved !== null) changes.set(motion.verb, moved);
      if (!open || changes.has(motion.verb)) motions.splice(i, 1);
    }
  }
  // Robot, který na horizontu nevyhrál, konec neohlásil: svět Rapieru uvolnit hned.
  releasePhysics(state);
  return {
    witnesses: witness === null ? [] : outcomeOf(state) === 'won' && !isProbe ? witness.escaped(options.threatProofs ?? [], state, state[HEADER.tick] as number) : witness.finish(outcomeOf(state)),
    inputs,
    outcome: outcomeOf(state),
    tick: state[HEADER.tick] as number,
    hash: hashArcade(state),
    distanceM: Math.round((state[bodyBase(player) + BODY.z] as number) / UNIT),
    firstFired,
    changes,
    logic: ledger === null ? [] : ledger.proofs(firstFired),
  };
}

/**
 * Slovesa pravidel světa v pořadí prvního výskytu. Sloveso vystřelilo, když
 * během robotova běhu vystřelilo kterékoli pravidlo, které ho nese, a je
 * dokázané, když po tom výstřelu robot naměřil změnu stavu (`changes`).
 * Pravidla bez `verb` (ručně psané kusy knihovny) se nepočítají.
 */
function verbsOf(world: ArcadeWorld, firstFired: readonly number[], changes: ReadonlyMap<string, string>): VerbProof[] {
  const proofs = new Map<string, number>();
  world.rules.forEach((ref, index) => {
    const verb = underlyingRule(ref).params.verb;
    if (typeof verb !== 'string') return;
    const tick = firstFired[index] ?? -1;
    const known = proofs.get(verb) ?? -1;
    proofs.set(verb, known === -1 ? tick : tick === -1 ? known : Math.min(known, tick));
  });
  return [...proofs].map(([verb, tick]) => {
    const evidence = tick >= 0 ? (changes.get(verb) ?? null) : null;
    return { verb, fired: tick >= 0, firstTick: tick >= 0 ? tick : null, changed: evidence !== null, evidence };
  });
}

/**
 * Pravidlo prohry či zranění („touch lava“) vítězný robot obchází, a tak ho
 * nevystřelí (P36A T8). Sloveso, které nesou jen taková pravidla a vítězný běh
 * ho nedokázal, dokazuje druhý běh robota, který do pravidla schválně vleze.
 * Co nedokáže ani ten (tělo nikdo nedosáhne, ovládání bez plánovače), zůstane
 * neprokázané. Vrací i ten běh (`probe`), ať jím ověření dokáže kostky logiky.
 */
function withLossProofs(world: ArcadeWorld, library: ArcadeLibrary, verbs: VerbProof[]): { readonly verbs: VerbProof[]; readonly probe: BotRun | null } {
  const losing = losingVerbs(world);
  const seek = new Set(verbs.filter((proof) => !proof.changed && losing.has(proof.verb)).map((proof) => proof.verb));
  if (seek.size === 0 || lossPlanner(world, seek) === null) return { verbs, probe: null };
  const probe = runBot(world, library, { seek });
  const found = new Map(verbsOf(world, probe.firstFired, probe.changes).map((proof) => [proof.verb, proof]));
  return {
    verbs: verbs.map((proof) => {
      const lost = seek.has(proof.verb) ? found.get(proof.verb) : undefined;
      return lost?.changed === true ? lost : proof;
    }),
    probe,
  };
}

/**
 * Kostky logiky (P45B T7): důkaz vítězného běhu, a co ten nedokázal, smí dokázat běh na
 * prohru – proměnnou „lives“, kterou ubírá jen láva, vítězný robot obchází stejně jako sloveso.
 */
function withLossLogic(logic: readonly LogicProof[], probe: BotRun | null): readonly LogicProof[] {
  if (probe === null) return logic;
  return logic.map((proof, index) => {
    const lost = probe.logic[index] as LogicProof;
    return proof.changed ? proof : lost.changed ? lost : { ...proof, fired: proof.fired || lost.fired };
  });
}

export interface ArcadeVerdict {
  readonly witnesses: readonly ActionWitness[];
  readonly bot: BotRun;
  readonly idle: { readonly outcome: ArcadeOutcome; readonly tick: number; readonly hash: string };
  readonly replayEqual: boolean;
  readonly withinLimits: boolean;
  readonly initialHash: string;
  /** Slovesa pravidel a jejich důkaz robotovým během (P29A); hra bez pravidel = []. */
  readonly verbs: readonly VerbProof[];
  /** Kostky logiky a jejich důkaz (P45B T7); hra bez logiky a bez vln = []. */
  readonly logic: readonly LogicProof[];
  /** Srozumitelné důvody, proč hra neprošla; prázdné = prošla. */
  readonly failures: readonly string[];
  readonly publishEligible: boolean;
}

/** S vazbami z `arcadeWorldOf` navíc změří trojice a samostatné sondy hrozeb; uložený svět ani publikační bránu nemění. */
/** Běh robota z `compileArcade` (týž svět, výchozí volby): kontrola publikace ho nepouští podruhé (P46B R4, běžec ≈ 1 s). */
const compiledRuns = new WeakMap<ArcadeWorld, BotRun>();
export function rememberBotRun(world: ArcadeWorld, run: BotRun): void {
  compiledRuns.set(world, run);
}

/**
 * `pacingProbe`: které sondy průběhu pustit (výchozí všechny). Sonda přidá jen svědky, jejichž aktérem je vazba,
 * kterou dostane – volající, který čte jen svědky některých aktérů (přiznání `honestyOf`), ostatní celé běhy ušetří.
 */
export function verifyArcade(world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY, roleBindings?: readonly RoleBinding[], options: { readonly pacingProbe?: (binding: RoleBinding) => boolean } = {}): ArcadeVerdict {
  const initial = instantiate(world);
  const bodies = initial[HEADER.bodyCount] as number;
  const withinLimits = bodies <= ARCADE_LIMITS.maxBodies && world.rules.length <= ARCADE_LIMITS.maxRules;
  const probes: ActionWitness[] = [];
  const probed = new Set<string>();
  for (const binding of roleBindings ?? []) {
    // Jedna sonda na roli; v neúspěchu se žádná hrozba nepředpokládá.
    if (binding.player || !['hazard', 'chaser', 'patrol'].includes(binding.roleKind) || probed.has(binding.roleId)) continue;
    probed.add(binding.roleId);
    const probe = runBot(world, library, { roleBindings, probeBody: binding.body, runId: `probe:${binding.roleId}` });
    probes.push(...probe.witnesses.filter(w => w.actor.roleId === binding.roleId));
  }
  // Průběh hry (P45C): první tělo každého chování a bosse má svou sondu – nepřítel, kterého sonda nevidí, by prošel jako kulisa.
  // Bez vazeb rolí (publikace, `reportFor`) sonda svědka nezapíše: každý svědek má hráče za aktéra nebo předmět a hráče
  // by navázala jen vazba z `roleBindings`. Celý běh robota na sondu by byl zbytečný (P46B R4: 4 sondy běžce ≈ 2,5 s).
  for (const { body, behaviour } of roleBindings === undefined ? [] : pacingProbeBodies(world)) {
    const binding: RoleBinding = { body, roleId: `pacing:${behaviour}`, label: behaviour, roleKind: 'hazard', player: false };
    if (options.pacingProbe?.(binding) === false) continue;
    const probe = runBot(world, library, { roleBindings: [...(roleBindings ?? []), binding], probeBody: body, runId: `probe:${binding.roleId}` });
    probes.push(...probe.witnesses.filter(w => w.actor.roleId === binding.roleId));
  }
  // Bez vazeb nemá běh svědka ani sondy (výš), takže je to týž běh jako `runBot(world)` v kompilaci.
  const known = roleBindings === undefined && library === ARCADE_LIBRARY ? compiledRuns.get(world) : undefined;
  const bot = known ?? runBot(world, library, { roleBindings, threatProofs: probes });
  const first = replay(world, bot.inputs, library);
  const second = replay(world, bot.inputs, library);
  const replayEqual = first.hash === second.hash && first.hash === bot.hash;
  const idle = replay(world, [], library);

  const failures: string[] = [];
  if (bot.outcome === 'lost') failures.push(`bot_wins: the bot lost at tick ${bot.tick}, ${bot.distanceM} m into the track`);
  else if (bot.outcome === 'running') failures.push(`bot_wins: the bot did not finish within ${ARCADE_LIMITS.maxTicks} ticks (${bot.distanceM} m)`);
  if (idle.outcome === 'won') failures.push(`idle_loses: a player who does nothing wins at tick ${idle.tick} – the game plays itself`);
  if (!replayEqual) failures.push('replay_equal: two replays of the bot record ended in different states');
  if (!withinLimits) failures.push(`within_limits: ${bodies} bodies / ${world.rules.length} rules exceed the kernel limits`);
  const { verbs, probe } = withLossProofs(world, library, verbsOf(world, bot.firstFired, bot.changes));
  for (const proof of verbs) {
    if (!proof.fired) failures.push(`verbs_proved: VERB_UNPROVED:${proof.verb} – no rule with the verb "${proof.verb}" fired while the bot played`);
    else if (!proof.changed) failures.push(`verbs_proved: VERB_NO_EFFECT:${proof.verb} – a rule with the verb "${proof.verb}" fired, but the bot saw nothing change that its effects promise`);
  }
  const logic = withLossLogic(bot.logic, probe);
  for (const proof of logic) {
    if (!proof.fired) failures.push(`logic_proved: LOGIC_UNPROVED:${proof.kind}:${proof.id} – ${LOGIC_WHY[proof.kind][0]} while the bot played`);
    else if (!proof.changed) failures.push(`logic_proved: LOGIC_NO_EFFECT:${proof.kind}:${proof.id} – ${LOGIC_WHY[proof.kind][1]} while the bot played`);
  }

  return { bot, witnesses: [...bot.witnesses, ...probes], idle, replayEqual, withinLimits, initialHash: hashArcade(initial), verbs, logic, failures, publishEligible: failures.length === 0 };
}

const CHECKS = ['bot_wins', 'idle_loses', 'replay_equal', 'within_limits'] as const;

/** Verdikt v tvaru `QualityReport`: každá kontrola je jeden keypoint s vlastním důvodem. */
export function arcadeReport(verdict: ArcadeVerdict, world: ArcadeWorld, ids: { readonly specHash: string; readonly worldHash: string }): QualityReport {
  // Hra bez sloves a bez logiky má report přesně jako dřív: kontrola se přidá, jen když je co dokazovat.
  const checks = [...CHECKS, ...(verdict.verbs.length > 0 ? ['verbs_proved' as const] : []), ...(verdict.logic.length > 0 ? ['logic_proved' as const] : [])];
  const keypoints = checks.map((check): KeypointEvidence => {
    const failures = verdict.failures.filter((failure) => failure.startsWith(`${check}:`));
    return {
      assertionId: check,
      mechanicId: world.control.id,
      passed: failures.length === 0,
      hashBefore: verdict.initialHash,
      hashAfter: check === 'idle_loses' ? verdict.idle.hash : verdict.bot.hash,
      ticks: check === 'idle_loses' ? verdict.idle.tick : verdict.bot.tick,
      failures,
    };
  });
  return {
    specHash: ids.specHash,
    worldHash: ids.worldHash,
    keypoints,
    witness: { certified: verdict.bot.outcome === 'won', winsAtTick: verdict.bot.outcome === 'won' ? verdict.bot.tick : null },
    replayEqual: verdict.replayEqual,
    budgets: { entities: world.initial[HEADER.bodyCount] as number, rules: world.rules.length, triangles: null },
    publishEligible: verdict.publishEligible,
    ...(verdict.verbs.length > 0 ? { verbs: verdict.verbs } : {}),
  };
}
