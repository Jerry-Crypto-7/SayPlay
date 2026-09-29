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

import { ARCADE_LIMITS, type ArcadeEffect, type ArcadeInput, type ArcadeObservation, type ArcadeState, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, type InputEvent, UNIT, bodyBase, bodyHp, targetStateOf } from './contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, replay, step } from './kernel';
import { ARCADE_LIBRARY } from './library';
import { releasePhysics } from './physics/step';
import { rulesPlanner } from './rules/bot';

export interface BotRun {
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
 * Změna, kterou třída efektu slibuje. `after` je stav hned po tom efektu (stopa
 * jádra); `null` = efekt se provedl naprázdno. Výsledek hry (`win` / `lose`)
 * rozhodne až konec tiku a posun těla po `push` / `throwHeld` další tiky – ty
 * měří volající.
 *
 * Mimo čítače se všechno soudí podmínkou na `after`, ne srovnáním se začátkem
 * tiku: jádro efekt ohlásí jen za provedenou změnu, a co se v tiku stalo dřív
 * (míč zanikl a spawn dostal jeho slot, hráč vyběhl ze startu, první značka
 * posunula bod návratu), by srovnání se začátkem tiku schovalo nebo přičetlo
 * (revize fáze 1 P30B, R1).
 */
function changeOf(effect: ArcadeEffect, after: ArcadeState, tick: number): string | null {
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
      return null;
    // Švy P32-0 T4: jádro efekt ohlásí jen za skutečnou změnu HP nebo stavu cíle.
    case 'hit':
      return `body ${String(effect.body)} hit, hp now ${String(bodyHp(after, effect.body))} ${at}`;
    case 'stateChange':
      return `body ${String(effect.body)} now in state ${String(targetStateOf(after, effect.body))} ${at}`;
  }
}

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

/**
 * Odehraje hru robotem. Robot v tiku *t* vidí stav z tiku *t − reactionTicks*
 * (kruhový buffer kopií) a vlastní stisky z té doby, které ještě nevidí.
 */
export function runBot(world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY, options: { readonly planner?: boolean } = {}): BotRun {
  const piece = library.bots[world.bot.id];
  if (piece === undefined) throw new Error(`arcade: unknown bot ${world.bot.id}`);
  const params = piece.params.parse(world.bot.params);
  // Hru, kterou vyhrávají pravidla specu, hraje plánovač cílů (P29A); `planner: false` = kontrolní běh robotem světa.
  const planner = options.planner === false ? null : rulesPlanner(world);
  const bot = planner ?? { reactionTicks: piece.reactionTicks, decide: (observation: ArcadeObservation) => piece.decide(observation, params) };
  // Slovesa pravidel: stav na začátku tiku, ať jde změnu po efektu změřit (P30B T2).
  const verbOf = world.rules.map((ref) => (typeof ref.params.verb === 'string' ? ref.params.verb : null));
  const measuring = verbOf.some((verb) => verb !== null);
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const delay = bot.reactionTicks;
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
  let now = 0;
  const trace = (rule: number, effect: ArcadeEffect): void => {
    if (firstFired[rule] === -1) firstFired[rule] = now;
    const verb = verbOf[rule];
    if (verb === null || verb === undefined || changes.has(verb)) return;
    if (effect.kind === 'win' || effect.kind === 'lose') {
      endings.push([verb, effect.kind === 'win' ? 'won' : 'lost']);
      return;
    }
    const change = changeOf(effect, state, now);
    if (change !== null) changes.set(verb, change);
    const motion = change === null ? motionOf(verb, effect, before, now) : null;
    if (motion !== null && !motions.some((known) => known.verb === verb && known.body === motion.body)) motions.push(motion);
  };

  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    now = tick;
    (history[tick % (delay + 1)] as Int32Array).set(state);
    const seenAt = Math.max(0, tick - delay);
    const seen = history[seenAt % (delay + 1)] as Int32Array;
    const input = bot.decide({ state: seen, player, tick: seenAt, recent: issued.slice(issued.length - (tick - seenAt)) });
    issued.push(input);
    if (input.buttons !== 0 || input.axis !== 0) inputs.push({ tick, ...input });
    if (measuring) before.set(state);
    step(state, input, program, trace);
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
    inputs,
    outcome: outcomeOf(state),
    tick: state[HEADER.tick] as number,
    hash: hashArcade(state),
    distanceM: Math.round((state[bodyBase(player) + BODY.z] as number) / UNIT),
    firstFired,
    changes,
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
    const verb = ref.params.verb;
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

export interface ArcadeVerdict {
  readonly bot: BotRun;
  readonly idle: { readonly outcome: ArcadeOutcome; readonly tick: number; readonly hash: string };
  readonly replayEqual: boolean;
  readonly withinLimits: boolean;
  readonly initialHash: string;
  /** Slovesa pravidel a jejich důkaz robotovým během (P29A); hra bez pravidel = []. */
  readonly verbs: readonly VerbProof[];
  /** Srozumitelné důvody, proč hra neprošla; prázdné = prošla. */
  readonly failures: readonly string[];
  readonly publishEligible: boolean;
}

export function verifyArcade(world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY): ArcadeVerdict {
  const initial = instantiate(world);
  const bodies = initial[HEADER.bodyCount] as number;
  const withinLimits = bodies <= ARCADE_LIMITS.maxBodies && world.rules.length <= ARCADE_LIMITS.maxRules;
  const bot = runBot(world, library);
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
  const verbs = verbsOf(world, bot.firstFired, bot.changes);
  for (const proof of verbs) {
    if (!proof.fired) failures.push(`verbs_proved: VERB_UNPROVED:${proof.verb} – no rule with the verb "${proof.verb}" fired while the bot played`);
    else if (!proof.changed) failures.push(`verbs_proved: VERB_NO_EFFECT:${proof.verb} – a rule with the verb "${proof.verb}" fired, but the bot saw nothing change that its effects promise`);
  }

  return { bot, idle, replayEqual, withinLimits, initialHash: hashArcade(initial), verbs, failures, publishEligible: failures.length === 0 };
}

const CHECKS = ['bot_wins', 'idle_loses', 'replay_equal', 'within_limits'] as const;

/** Verdikt v tvaru `QualityReport`: každá kontrola je jeden keypoint s vlastním důvodem. */
export function arcadeReport(verdict: ArcadeVerdict, world: ArcadeWorld, ids: { readonly specHash: string; readonly worldHash: string }): QualityReport {
  // Hra bez sloves má report přesně jako dřív: kontrola sloves se přidá, jen když je co dokazovat.
  const checks = verdict.verbs.length > 0 ? [...CHECKS, 'verbs_proved' as const] : CHECKS;
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
