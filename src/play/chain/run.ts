/**
 * Přehrávač řetězu (P56C T5): globální tiky přes všechna kola, karta `cardTicks` mezi koly (vstupy se
 * zahodí), životy a skóre v hlavičce řetězu. Kolo r začne v tiku, kdy skončila karta po kole r − 1; první
 * kolo v tiku 0, bez karty. Kolo končí výhrou, prohrou, nebo `ARCADE_LIMITS.maxTicks` (= prohra).
 *
 * Hash `chain-v1` = FNV-1a (`hashHex`) nad jedním polem: konečné stavy odehraných kol za sebou, rozehrané
 * kolo a hlavička `[lives, score, round, tick]`. Tempo (`rate`) je jen rychlost přehrávání v klientovi.
 */

import { arcadeWorldOf } from '../arcade/compile';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeInput, type ArcadeState, type ArcadeWorld, COUNTER, HEADER, type InputEvent, NO_INPUT, underlyingRule } from '../arcade/contract';
import { type ArcadeLibrary, type ArcadeOutcome, type ArcadeProgram, hashArcade, instantiate, loadProgram, outcomeOf, step } from '../arcade/kernel';
import { ARCADE_LIBRARY } from '../arcade/library';
import { hashHex } from '../../sim/hash';
import { createStreams, nextInt } from '../../sim/rng';
import type { GameSpecV1 } from '../spec';
import { CARD_TICKS, CHAIN_LIVES, CHAIN_RUNTIME_VERSION, type ChainRound, type ChainWorld, RATE_STEPS } from './contract';
import type { MicroKey } from './micro';

/** Semínka kol ze streamu `chain` – jediný los řetězu. */
export function roundSeeds(seed: number, count: number): number[] {
  const stream = createStreams(seed).chain;
  return Array.from({ length: count }, () => nextInt(stream, 1, 0x7fffffff));
}

export interface RoundPlan {
  readonly spec: GameSpecV1;
  readonly key: MicroKey;
  readonly card: string;
  readonly boss: boolean;
  readonly mutator?: string;
  /** Semínko světa kola, které už vybral stavitel (`buildChain`); bez něj los ze streamu `chain`. */
  readonly seed?: number;
}

/** Tempo kola `index` (od 0) v promile. */
export const roundRate = (index: number): number => RATE_STEPS[Math.min(index, RATE_STEPS.length - 1)]!;

/** Řetěz z hotových specu kol: svět každého kola ze semínka streamu `chain`, tempo podle pořadí kola. */
export function chainFromSpecs(seed: number, plans: readonly RoundPlan[]): { readonly ok: true; readonly chain: ChainWorld } | { readonly ok: false; readonly issues: readonly string[] } {
  const seeds = roundSeeds(seed, plans.length);
  const rounds: ChainRound[] = [];
  const issues: string[] = [];
  plans.forEach(({ seed: own, ...plan }, index) => {
    const made = arcadeWorldOf(plan.spec, own ?? seeds[index]!);
    if (!made.ok) issues.push(...made.issues.map((issue) => `round ${index + 1} (${plan.key}): ${issue}`));
    else rounds.push({ ...plan, world: made.world, rate: roundRate(index) });
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, chain: { runtimeVersion: CHAIN_RUNTIME_VERSION, seed, lives: CHAIN_LIVES, cardTicks: CARD_TICKS, rounds } };
}

/** Stav běžícího řetězu; `stepChain` ho mění na místě jako jádro svůj stav. */
export interface ChainState {
  readonly chain: ChainWorld;
  readonly library: ArcadeLibrary;
  /** Index kola, které se hraje, nebo po kartě začne. */
  round: number;
  /** Tiky karty, které zbývají; 0 = hraje se kolo `round`. */
  card: number;
  state: ArcadeState;
  program: ArcadeProgram;
  lives: number;
  score: number;
  /** Globální tik řetězu. */
  tick: number;
  outcome: ArcadeOutcome;
  readonly finals: ArcadeState[];
  readonly results: ('won' | 'lost')[];
}

/**
 * Svět kola, jak ho otevře přehrávač: boss dostane jako životy těla zbývající životy řetězu (má-li hra životy).
 * Sdílí ho `openRound` i relace řetězu v prohlížeči (T11), ať boss u obou začne týmž stavem.
 */
export function roundWorld(chain: ChainWorld, index: number, lives: number): ArcadeWorld {
  const round = chain.rounds[index]!;
  if (!round.boss) return round.world;
  const initial = instantiate(round.world);
  if ((initial[HEADER.counters + COUNTER.health] as number) <= 0) return round.world;
  initial[HEADER.counters + COUNTER.health] = lives;
  return { ...round.world, initial: Array.from(initial) };
}

function openRound(chain: ChainWorld, index: number, lives: number, library: ArcadeLibrary): { readonly state: ArcadeState; readonly program: ArcadeProgram } {
  const world = roundWorld(chain, index, lives);
  return { state: instantiate(world), program: loadProgram(world, library) };
}

export function startChain(chain: ChainWorld, library: ArcadeLibrary = ARCADE_LIBRARY): ChainState {
  return { chain, library, round: 0, card: 0, ...openRound(chain, 0, chain.lives, library), lives: chain.lives, score: 0, tick: 0, outcome: 'running', finals: [], results: [] };
}

/** Jeden globální tik. Během karty se vstup zahodí; po konci řetězu nedělá nic. */
export function stepChain(run: ChainState, input: ArcadeInput): void {
  if (run.outcome !== 'running') return;
  run.tick += 1;
  if (run.card > 0) {
    run.card -= 1;
    if (run.card === 0) Object.assign(run, openRound(run.chain, run.round, run.lives, run.library));
    return;
  }
  step(run.state, input, run.program);
  const outcome = outcomeOf(run.state);
  if (outcome === 'running' && (run.state[HEADER.tick] as number) < ARCADE_LIMITS.maxTicks) return;
  const won = outcome === 'won';
  run.results.push(won ? 'won' : 'lost');
  run.finals.push(run.state);
  run.score += run.state[HEADER.counters + COUNTER.score] as number;
  if (!won) run.lives -= 1;
  const last = run.round === run.chain.rounds.length - 1;
  if (run.lives <= 0 || (last && !won)) run.outcome = 'lost';
  else if (last) run.outcome = 'won';
  else {
    run.round += 1;
    run.card = run.chain.cardTicks;
  }
}

/** Co hash čte; relace v prohlížeči (T11) ho skládá ze svých kol, ne z `ChainState`. */
export type ChainHashInput = Pick<ChainState, 'outcome' | 'card' | 'finals' | 'state' | 'lives' | 'score' | 'round' | 'tick'>;

export function hashChain(run: ChainHashInput): string {
  const playing = run.outcome === 'running' && run.card === 0;
  const states = playing ? [...run.finals, run.state] : run.finals;
  const words = new Int32Array(states.reduce((sum, state) => sum + state.length, 0) + 4);
  let at = 0;
  for (const state of states) {
    words.set(state, at);
    at += state.length;
  }
  words.set([run.lives, run.score, run.round, run.tick], at);
  return hashHex(new Uint32Array(words.buffer));
}

export interface ChainReplay {
  readonly hash: string;
  readonly outcome: ArcadeOutcome;
  readonly tick: number;
  readonly lives: number;
  readonly score: number;
  readonly results: readonly ('won' | 'lost')[];
  /** `hashArcade` konečného stavu každého odehraného kola. */
  readonly roundHashes: readonly string[];
}

/** Nejdelší možný řetěz: každé kolo do stropu jádra a karta za ním. */
export const chainHorizon = (chain: ChainWorld): number => chain.rounds.length * (ARCADE_LIMITS.maxTicks + chain.cardTicks);

/**
 * Hodiny kola v tikách: prohrávací `time_limit`, nebo bezpodmínečné pravidlo `every`, které kolo vyhraje či prohraje
 * (`micro_clock` u přežití). Více hodin = ty nejkratší; `null` = kolo bez hodin, jeho běh může trvat do stropu jádra.
 */
export function roundClock(world: ArcadeWorld): number | null {
  const clocks = world.rules.map(underlyingRule).flatMap((ref) => {
    // Prohra `time_limit` padne až tik po vypršení (`replay`: 10 s → tik 601).
    if (ref.id === 'time_limit') return [(ref.params as { readonly seconds: number }).seconds * ARCADE_HZ + 1];
    const rule = ref.params as { readonly when?: { readonly every?: number }; readonly if?: readonly unknown[]; readonly do?: readonly { readonly win?: boolean; readonly lose?: boolean }[] };
    const ends = rule.do?.some((action) => action.win === true || action.lose === true) === true;
    return ref.id === 'rule_tick' && rule.when?.every !== undefined && (rule.if ?? []).length === 0 && ends ? [rule.when.every] : [];
  });
  return clocks.length === 0 ? null : Math.min(...clocks);
}

/** Nejdelší možný běh řetězu: hodiny všech kol a karty mezi nimi; `null`, když některé kolo hodiny nemá. */
export function chainMaxTicks(chain: ChainWorld): number | null {
  const clocks = chain.rounds.map((round) => roundClock(round.world));
  if (clocks.includes(null)) return null;
  return clocks.reduce<number>((sum, ticks) => sum + ticks!, 0) + (chain.rounds.length - 1) * chain.cardTicks;
}

/** Přehraje řídký záznam s globálními tiky (seřazený) od tiku 0 do konce řetězu nebo horizontu. */
export function replayChain(chain: ChainWorld, inputs: readonly InputEvent[], library: ArcadeLibrary = ARCADE_LIBRARY, horizon: number = chainHorizon(chain)): ChainReplay {
  const run = startChain(chain, library);
  let next = 0;
  while (run.outcome === 'running' && run.tick < horizon) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < run.tick) next += 1;
    const event = inputs[next];
    stepChain(run, event !== undefined && event.tick === run.tick ? event : NO_INPUT);
  }
  return { hash: hashChain(run), outcome: run.outcome, tick: run.tick, lives: run.lives, score: run.score, results: [...run.results], roundHashes: run.finals.map(hashArcade) };
}
