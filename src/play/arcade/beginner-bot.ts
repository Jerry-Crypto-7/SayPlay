/**
 * Bot „začátečník“ (P70A T1): měřidlo, jestli běžný hráč hru napoprvé nebo napodruhé vyhraje.
 *
 * Rozhoduje stejně jako vítězný robot `runBot` ve `verify.ts` (plánovač pravidel specu, jinak robot světa, který
 * obchází tělesa prohry), jen jako člověk: svět vidí o 350–500 ms později (21–30 tiků při 60 Hz) a ve 20 % oken
 * po 250 ms se splete – vstup buď vynechá, nebo zmáčkne jiné ovládání, které ve hře už použil. Zpoždění, chyba
 * i volba špatného vstupu se losují z vlastního streamu `pure-rand` (`createStreams(seed).ai`), takže týž svět
 * a týž seed dají týž běh a svět ani jeho hash se nepohnou.
 *
 * Měří jen: program hry, výchozí robot ani brána publikace ho nečtou.
 */

import { createStreams, nextInt } from '@/sim/rng';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeInput, type ArcadeObservation, type ArcadeWorld, COUNTER, HEADER, type InputEvent, NO_INPUT } from './contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, step } from './kernel';
import { ARCADE_LIBRARY } from './library';
import { releasePhysics } from './physics/step';
import { avoidingLosses, rulesPlanner } from './rules/bot';

export const BEGINNER = {
  /** Zpoždění vnímání v ticích: 350 ms … 500 ms při 60 Hz. */
  reactionMinTicks: 21,
  reactionMaxTicks: 30,
  /** Okno jednoho rozhodnutí (250 ms); zpoždění i chyba se losují jednou za okno. */
  windowTicks: 15,
  /** Podíl oken, ve kterých se hráč splete (vynechá nebo zmáčkne jiné ovládání). */
  errorPerThousand: 200,
} as const;

export interface BeginnerRun {
  readonly inputs: readonly InputEvent[];
  readonly outcome: ArcadeOutcome;
  readonly tick: number;
  readonly hash: string;
  /** Tik, kdy hráč poprvé přišel o život (čítač `health` klesl) nebo prohrál; `null` = ani jedno. */
  readonly firstLifeLostTick: number | null;
  /** Okna s chybou a z nich ta, kde hráč zmáčkl jiné ovládání (zbytek vstup vynechal). */
  readonly errorWindows: number;
  readonly wrongInputWindows: number;
}

const sameInput = (a: ArcadeInput, b: ArcadeInput): boolean => a.buttons === b.buttons && a.axis === b.axis;

/** Sekundy simulace z tiků (60 Hz). */
export const secondsOf = (ticks: number): number => ticks / ARCADE_HZ;

/** Odehraje svět začátečníkem; `seed` volí jeho zpoždění a chyby (výchozí seed světa). */
export function runBeginner(world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY, options: { readonly seed?: number } = {}): BeginnerRun {
  const piece = library.bots[world.bot.id];
  if (piece === undefined) throw new Error(`arcade: unknown bot ${world.bot.id}`);
  const params = piece.params.parse(world.bot.params);
  const planner = rulesPlanner(world);
  const decide = planner?.decide ?? avoidingLosses(world, (observation: ArcadeObservation) => piece.decide(observation, params));
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const player = state[HEADER.player] as number;
  const errors = createStreams(options.seed ?? world.seed).ai;
  const ring = BEGINNER.reactionMaxTicks + 1;
  const history = Array.from({ length: ring }, () => state.slice());
  const issued: ArcadeInput[] = [];
  const inputs: InputEvent[] = [];
  /** Ovládání, které hráč ve hře už použil – špatný vstup je jedno z nich, ne tlačítko, o kterém neví. */
  const known: ArcadeInput[] = [];
  const healthAt = HEADER.counters + COUNTER.health;
  let health = state[healthAt] as number;
  let firstLifeLostTick: number | null = null;
  let delay: number = BEGINNER.reactionMinTicks;
  let wrong: ArcadeInput | null = null;
  let errorWindows = 0;
  let wrongInputWindows = 0;

  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    (history[tick % ring] as Int32Array).set(state);
    if (tick % BEGINNER.windowTicks === 0) {
      // Pevný počet losů na okno: běh nezávisí na tom, co hra zrovna dělá.
      delay = nextInt(errors, BEGINNER.reactionMinTicks, BEGINNER.reactionMaxTicks);
      const chance = nextInt(errors, 0, 999);
      const kind = nextInt(errors, 0, 1);
      const pick = nextInt(errors, 0, 999);
      wrong = null;
      if (chance < BEGINNER.errorPerThousand) {
        errorWindows += 1;
        const other = kind === 1 && known.length > 0 ? (known[pick % known.length] as ArcadeInput) : null;
        if (other !== null) wrongInputWindows += 1;
        wrong = other ?? NO_INPUT;
      }
    }
    const seenAt = Math.max(0, tick - delay);
    const observation = { state: history[seenAt % ring] as Int32Array, player, tick: seenAt, recent: issued.slice(seenAt) };
    const meant = decide(observation);
    if ((meant.buttons !== 0 || meant.axis !== 0) && !known.some((input) => sameInput(input, meant))) known.push(meant);
    const input = wrong ?? meant;
    issued.push(input);
    if (input.buttons !== 0 || input.axis !== 0) inputs.push({ tick, ...input });
    step(state, input, program);
    const now = state[healthAt] as number;
    if (firstLifeLostTick === null && (now < health || outcomeOf(state) === 'lost')) firstLifeLostTick = tick;
    health = now;
  }
  releasePhysics(state);
  return { inputs, outcome: outcomeOf(state), tick: state[HEADER.tick] as number, hash: hashArcade(state), firstLifeLostTick, errorWindows, wrongInputWindows };
}
