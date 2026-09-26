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

import { ARCADE_LIMITS, type ArcadeInput, type ArcadeObservation, type ArcadeWorld, BODY, HEADER, type InputEvent, UNIT, bodyBase } from './contract';
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
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const delay = bot.reactionTicks;
  const history = Array.from({ length: delay + 1 }, () => state.slice());
  const issued: ArcadeInput[] = [];
  const inputs: InputEvent[] = [];
  const player = state[HEADER.player] as number;
  const firstFired = world.rules.map(() => -1);
  let now = 0;
  const trace = (rule: number): void => {
    if (firstFired[rule] === -1) firstFired[rule] = now;
  };

  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    now = tick;
    (history[tick % (delay + 1)] as Int32Array).set(state);
    const seenAt = Math.max(0, tick - delay);
    const seen = history[seenAt % (delay + 1)] as Int32Array;
    const input = bot.decide({ state: seen, player, tick: seenAt, recent: issued.slice(issued.length - (tick - seenAt)) });
    issued.push(input);
    if (input.buttons !== 0 || input.axis !== 0) inputs.push({ tick, ...input });
    step(state, input, program, trace);
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
  };
}

/**
 * Slovesa pravidel světa v pořadí prvního výskytu. Sloveso je dokázané, když
 * během robotova běhu vystřelilo kterékoli pravidlo, které ho nese. Pravidla
 * bez `verb` (ručně psané kusy knihovny) se nepočítají.
 */
function verbsOf(world: ArcadeWorld, firstFired: readonly number[]): VerbProof[] {
  const proofs = new Map<string, number>();
  world.rules.forEach((ref, index) => {
    const verb = ref.params.verb;
    if (typeof verb !== 'string') return;
    const tick = firstFired[index] ?? -1;
    const known = proofs.get(verb) ?? -1;
    proofs.set(verb, known === -1 ? tick : tick === -1 ? known : Math.min(known, tick));
  });
  return [...proofs].map(([verb, tick]) => ({ verb, fired: tick >= 0, firstTick: tick >= 0 ? tick : null }));
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
  const verbs = verbsOf(world, bot.firstFired);
  for (const proof of verbs) {
    if (!proof.fired) failures.push(`verbs_proved: VERB_UNPROVED:${proof.verb} – no rule with the verb "${proof.verb}" fired while the bot played`);
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
