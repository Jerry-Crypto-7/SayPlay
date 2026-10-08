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

import { ARCADE_LIMITS, type ArcadeEffect, type ArcadeInput, type ArcadeObservation, type ArcadeState, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, UNIT, bodyBase, bodyHp, targetStateOf } from './contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, replay, step } from './kernel';
import { underlyingRule } from './addons';
import { ARCADE_LIBRARY } from './library';
import { releasePhysics } from './physics/step';
import { avoidingLosses, lossPlanner, losingVerbs, rulesPlanner } from './rules/bot';
import { type ActionWitness, type RoleBinding, WitnessRecorder, threatProbeInput } from './witness';

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
  let now = 0;
  const trace = (rule: number, effect: ArcadeEffect): void => {
    witness?.effect(rule, effect, state, now);
    if (firstFired[rule] === -1) firstFired[rule] = now;
    const verb = verbOf[rule];
    if (verb === null || verb === undefined || changes.has(verb)) return;
    if (effect.kind === 'win' || effect.kind === 'lose') {
      endings.push([verb, effect.kind === 'win' ? 'won' : 'lost']);
      return;
    }
    if (stateOnly[rule] === true && effect.kind !== 'stateChange') return;
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
    if (measuring || witness !== null) before.set(state);
    step(state, input, program, trace);
    witness?.afterTick(before, state, tick);
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
 * neprokázané.
 */
function withLossProofs(world: ArcadeWorld, library: ArcadeLibrary, verbs: VerbProof[]): VerbProof[] {
  const losing = losingVerbs(world);
  const seek = new Set(verbs.filter((proof) => !proof.changed && losing.has(proof.verb)).map((proof) => proof.verb));
  if (seek.size === 0 || lossPlanner(world, seek) === null) return verbs;
  const probe = runBot(world, library, { seek });
  const found = new Map(verbsOf(world, probe.firstFired, probe.changes).map((proof) => [proof.verb, proof]));
  return verbs.map((proof) => {
    const lost = seek.has(proof.verb) ? found.get(proof.verb) : undefined;
    return lost?.changed === true ? lost : proof;
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
  /** Srozumitelné důvody, proč hra neprošla; prázdné = prošla. */
  readonly failures: readonly string[];
  readonly publishEligible: boolean;
}

/** S vazbami z `arcadeWorldOf` navíc změří trojice a samostatné sondy hrozeb; uložený svět ani publikační bránu nemění. */
export function verifyArcade(world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY, roleBindings?: readonly RoleBinding[]): ArcadeVerdict {
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
  const bot = runBot(world, library, { roleBindings, threatProofs: probes });
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
  const verbs = withLossProofs(world, library, verbsOf(world, bot.firstFired, bot.changes));
  for (const proof of verbs) {
    if (!proof.fired) failures.push(`verbs_proved: VERB_UNPROVED:${proof.verb} – no rule with the verb "${proof.verb}" fired while the bot played`);
    else if (!proof.changed) failures.push(`verbs_proved: VERB_NO_EFFECT:${proof.verb} – a rule with the verb "${proof.verb}" fired, but the bot saw nothing change that its effects promise`);
  }

  return { bot, witnesses: [...bot.witnesses, ...probes], idle, replayEqual, withinLimits, initialHash: hashArcade(initial), verbs, failures, publishEligible: failures.length === 0 };
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
