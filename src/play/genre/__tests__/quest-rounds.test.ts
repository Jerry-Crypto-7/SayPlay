/**
 * Úkol po kolech (P36A T4, část 3): úkol v prostoru i na místě trvá perfektnímu
 * robotovi 30–90 s, víc cílů ve větě dá delší běh, vyhrává se až v posledním
 * kole a každé další kolo je těžší – v prostoru víc nebo rychlejší
 * pronásledovatelé a nové cíle jinde, na místě kratší lhůta přetečení.
 *
 * Co by vypadalo dobře a bylo špatně: kola existují, ale výhra přijde už
 * s prvním (pravidlo `interact` vyhraje, jakmile jsou hotové všechny živé
 * cíle); další kolo položí cíle na stejná místa; počet z věty se zahodí a každá
 * věta trvá stejně; a uložená hra bez kol by se po změně přehrála jinak.
 */

import { describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileArcade } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '@/play/arcade/contract';
import { instantiate, loadProgram, replay, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { waveOf } from '@/play/arcade/pieces/waves';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

interface Published {
  readonly mode: string;
  readonly spec: GameSpecV1;
  readonly seed: number;
  readonly world: ArcadeWorld;
  readonly winSeconds: number;
  readonly idle: string;
}

/** Jako dveře publikace: první semínko, na kterém robot vyhraje a nečinný hráč ne. */
function publish(sentence: string, edit: (spec: GameSpecV1) => GameSpecV1 = (spec) => spec): Published {
  const spec = edit(draftGameSpecWithMeta(sentence, 1).spec);
  for (const seed of derivedSeeds(seedFrom(sentence))) {
    const compiled = compileArcade(spec, seed);
    if (!compiled.ok) continue;
    const { arcade: world, winsAtTick } = compiled.value;
    if (world == null || winsAtTick === null) continue;
    return { mode: `${spec.genre?.id ?? ''}.${spec.genre?.mode ?? ''}`, spec, seed, world, winSeconds: winsAtTick / ARCADE_HZ, idle: replay(world, [], ARCADE_LIBRARY).outcome };
  }
  throw new Error(`${sentence}: no seed publishes`);
}

const tuningOf = (spec: GameSpecV1) => (spec.controlParams as { tuning: Record<string, unknown> }).tuning;

interface Round {
  /** Živí pronásledovatelé na začátku kola a nejvyšší rychlost pronásledovatele během kola. */
  readonly chasers: number;
  speed: number;
  /** Místa cílů na začátku kola (x, z). */
  readonly targets: readonly (readonly [number, number])[];
}

/** Přehraje robotův záznam: co hráči hrozí v každém kole a v kterém kole vyhrál. */
function roundsOf(world: ArcadeWorld): { rounds: Round[]; wonInRound: number } {
  const inputs = runBot(world).inputs;
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const rounds: Round[] = [];
  let next = 0;
  for (let tick = 0; tick < 90 * ARCADE_HZ && state[HEADER.runState] === 0; tick += 1) {
    while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    const live = (role: number) =>
      Array.from({ length: state[HEADER.bodyCount] as number }, (_, i) => bodyBase(i)).filter((base) => state[base + BODY.role] === role && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0);
    if (waveOf(state) === rounds.length) {
      rounds.push({ chasers: live(ROLE.chaser).length, speed: 0, targets: live(ROLE.target).map((base) => [state[base + BODY.x] as number, state[base + BODY.z] as number] as const) });
    }
    const current = rounds[rounds.length - 1]!;
    for (const base of live(ROLE.chaser)) current.speed = Math.max(current.speed, Math.hypot(state[base + BODY.vx] as number, state[base + BODY.vz] as number));
  }
  return { rounds, wonInRound: state[HEADER.runState] === 1 ? waveOf(state) : -1 };
}

const PAIRS = [
  ['quest.spatial', 'light two candles before the ghost catches you', 'light eight candles before the ghost catches you'],
  ['quest.station', 'flip one pancake in the kitchen', 'flip three pancakes in the kitchen'],
] as const;

describe('quest in rounds – 30 to 90 s for the robot, the count of the sentence sets the length', () => {
  it.each(PAIRS)('%s: "%s" and "%s" both land in the band, the longer one runs longer, an idle player loses', (mode, short, long) => {
    const a = publish(short);
    const b = publish(long);
    for (const game of [a, b]) {
      expect(game.mode).toBe(mode);
      expect(game.winSeconds).toBeGreaterThanOrEqual(30);
      expect(game.winSeconds).toBeLessThanOrEqual(90);
      expect(game.idle).toBe('lost');
    }
    expect(b.winSeconds).toBeGreaterThan(a.winSeconds);
  });

  it('spatial: the win comes only in the last round, every round lays fresh targets elsewhere and brings more or faster chasers', () => {
    const game = publish('light five candles before the ghost catches you');
    const planned = tuningOf(game.spec).rounds as number;
    expect(planned).toBeGreaterThanOrEqual(2);
    const { rounds, wonInRound } = roundsOf(game.world);
    expect(rounds).toHaveLength(planned);
    expect(wonInRound).toBe(planned - 1);
    for (let k = 1; k < rounds.length; k += 1) {
      const before = rounds[k - 1]!;
      const now = rounds[k]!;
      expect(now.targets).toHaveLength(5);
      // Žádný cíl nového kola neleží tam, kde ležel cíl předchozího.
      expect(now.targets.some(([x, z]) => before.targets.some(([bx, bz]) => bx === x && bz === z))).toBe(false);
      expect(now.chasers).toBeGreaterThanOrEqual(before.chasers);
      expect(now.chasers > before.chasers || now.speed > before.speed).toBe(true);
    }
  });

  it('station: the same stations start over each round, the win comes in the last one and the boil-over limit shrinks', () => {
    const game = publish('flip two pancakes in the kitchen');
    const planned = tuningOf(game.spec).rounds as number;
    const { rounds, wonInRound } = roundsOf(game.world);
    expect(rounds).toHaveLength(planned);
    expect(wonInRound).toBe(planned - 1);
    expect(new Set(rounds.map((round) => JSON.stringify(round.targets))).size).toBe(1);
    const boil = game.world.rules.find((rule) => rule.id === 'boil_over')?.params as { ticks: number; step: number; floor: number };
    const limit = (round: number) => Math.max(boil.floor, boil.ticks - boil.step * round);
    expect(limit(planned - 1)).toBeLessThan(limit(0));
    expect(limit(planned - 1)).toBeGreaterThanOrEqual(4 * ARCADE_HZ);
  });
});

/**
 * Uložené hry z `play-compiler-v8` (bez kol): semínko a tik výhry robota
 * změřené tehdy v `evals/play/p36/depth.json`. Spec bez `rounds` a `hold`
 * a se starými hodinami musí hrát stejně.
 */
const STORED = [
  { sentence: 'build the tallest pancake tower before it falls over', seed: 1256944565, tick: 240 },
  { sentence: 'I want a game where a tiny astronaut repairs a broken spaceship by collecting glowing crystals on an icy moon while avoiding cracks in the ice and a grumpy alien that throws snowballs at him', seed: 559306708, tick: 60 },
  { sentence: 'A space marine shoots alien bugs in a mining colony', seed: 867901906, tick: 980 },
] as const;

describe('stored quest games without rounds', () => {
  it.each(STORED)('$sentence: same seed, the robot wins on the same tick', ({ sentence, seed, tick }) => {
    const spec = draftGameSpecWithMeta(sentence, 1).spec;
    const { rounds: _rounds, hold: _hold, ...tuning } = tuningOf(spec);
    const steps = (tuning.count as number) * ((tuning.states as number) - 1);
    const old = Math.min(80, Math.max(40, steps * ((tuning.chasers as number | undefined) ? 7 : 3)));
    const stored = {
      ...spec,
      controlParams: { ...spec.controlParams, tuning },
      mechanics: spec.mechanics.map((mechanic) => (mechanic.id === 'timer' ? { ...mechanic, params: { ...mechanic.params, seconds: old } } : mechanic)),
    } as GameSpecV1;
    const compiled = compileArcade(stored, seed);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    expect(compiled.value.winsAtTick).toBe(tick);
  });
});
