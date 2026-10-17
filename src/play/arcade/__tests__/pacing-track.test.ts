/**
 * Průběh dráhových žánrů (P45C T11): každá živá buňka běžce, poletování a
 * závodu dostane fáze z křivky napětí a závěrečný sprint. Robot intermediate
 * vyhraje ≥ 7/8, nečinný hráč nikdy, délka 30–90 s, přehrání = hash.
 * Plošinovka: nález pod plánem P45C. Odchylka: závod do prvního nárazu
 * (`voyage.race`) si nechá rampu (`GENRE_PACING.voyage_race`).
 *
 * Běžec (R2) navíc s hrozbami v pruzích (`RUNNER_FOES`) na skutečné trati s řadami: dřívější uhnutí bez
 * řad poslalo robota do bedny (flanker i ostřelovač 0/8, všechny tři 0/8) – robot ≥ 7/8 je tu proto
 * hlavní tvrzení. Plánovač pruhů a férový úder mají vlastní malé scény dole.
 */

import { describe, expect, it } from 'vitest';

import { finaleOf, pressureRun } from '../../../../evals/play/p45c/pacing';
import { arcadeWorldOf, compileArcade, generatorOf, preloadPhysics } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, BUTTON, type BodyInit, HEADER, type InputEvent, NO_INPUT, type PieceRef, UNIT, bodyBase, nativeRule } from '../contract';
import { instantiate } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { behaviourBodies, behaviourPhaseOf, stepBehaviours } from '../pieces/behaviours';
import { behaviourHarness, play, refsOf, telegraphCheck } from '../pieces/behaviours/__tests__/harness';
import { planLanes } from '../pieces/behaviours/lanes';
import type { PacingRuleParams } from '../pieces/pacing';
import { RUNNER_FOES } from '../pieces/pacing-parts';
import { OBSTACLES, RUNNER } from '../pieces/runner';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GenreSpec } from '@/play/genre/contract';
import { compileGenre, readGenreSpec } from '@/play/genre/index';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

const TRACK = ['runner_track', 'flap_track', 'voyage_race'];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const CELLS = liveCells().filter((cell) => {
  const spec = compileRecipe(assemblyOfCell(cell));
  return spec.genre !== undefined && TRACK.includes(generatorOf(spec));
});
/** Odchylka T11: závod do prvního nárazu (`crashBudget` 1) jede s rampou, ne s křivkou. */
const RAMPED = ['voyage.race'];

const worldOf = (spec: GameSpecV1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
/** Tatáž hra uložená před průběhem (`genre.v1`). */
const storedOf = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v1' } });

const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const phasesOf = (world: ArcadeWorld): unknown => chain(world.control).find((ref) => ref.id === 'phase_control')?.params.phases;

/** Hrozby běžce ve světě: chování v pravidle `pacing`, jeho rozvrh a místa vstupu. */
function foesOf(world: ArcadeWorld): void {
  const rule = nativeRule(world.rules, 'pacing')?.params as PacingRuleParams;
  expect(rule.behaviours?.map((ref) => ref.id)).toEqual(['flanker', 'sniper', 'swarm', 'boss']);
  expect(rule.spots).toEqual([-RUNNER.laneWidth, 40 * UNIT, RUNNER.laneWidth, 40 * UNIT]);
  // Rozvrh hrozeb a mimo los boss finále (P46B T4).
  expect(rule.schedule).toHaveLength(RUNNER_FOES.budget + 1);
  expect(rule.schedule.at(-1)).toMatchObject({ atPermille: RUNNER_FOES.bossAt, template: rule.behaviours?.at(-1)?.template, count: 1 });
  // Flanker a ostřelovač od stupňování (200 ‰), hejno až od vrcholu (650 ‰).
  expect(Math.min(...rule.schedule.map((entry) => entry.atPermille))).toBeGreaterThanOrEqual(200);
  const swarm = rule.behaviours?.find((ref) => ref.id === 'swarm')?.template;
  expect(rule.schedule.filter((entry) => entry.template === swarm).every((entry) => entry.atPermille >= 650)).toBe(true);
}

/** Kolikrát tělo chování začalo varovat (nový úder) v přehrání záznamu. */
function strikesIn(world: ArcadeWorld, inputs: readonly InputEvent[]): number {
  const refs = refsOf(world);
  const phases = new Map<number, string>();
  let strikes = 0;
  play(world, inputs, (state) => {
    for (const body of behaviourBodies(state, state[HEADER.player] as number, refs)) {
      const phase = behaviourPhaseOf(state, body);
      if (phase === 'telegraph' && phases.get(body) !== 'telegraph') strikes += 1;
      phases.set(body, phase);
    }
  });
  return strikes;
}

describe('track genres are paced', () => {
  it('covers every live track cell with a genre', () => {
    expect(CELLS.map((cell) => cell.id).sort()).toEqual(expect.arrayContaining(['runner.default', 'run.escape', 'flap.default', 'flap.collect', 'voyage.race']));
  });

  for (const cell of CELLS.filter((candidate) => !RAMPED.includes(candidate.id))) {
    it(`${cell.id}: curve phases, final sprint, bot wins 7/8 in 30–90 s, idle loses, replay equal`, async () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      const runner = generatorOf(spec) === 'runner_track';
      await preloadPhysics(spec, loadRapier);
      let wins = 0;
      for (const seed of SEEDS) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const { world } = made;
        expect(chain(world.control).map((ref) => ref.id)).toContain('pacing_control');
        expect(phasesOf(world)).toEqual([{ start: 0, speedPercent: 90 }, { start: 200, speedPercent: 100 }, { start: 650, speedPercent: 115 }, expect.objectContaining({ start: 850, speedPercent: 125 })]);
        expect(finaleOf(world)).toBe(true);
        if (runner) foesOf(world);
        const verdict = verifyArcade(world, ARCADE_LIBRARY, made.roleBindings);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual).toBe(true);
        const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
        const run = pressureRun(world, bot.inputs);
        expect(run.hash).toBe(bot.hash);
        if (runner) {
          // Hrozby opravdu útočí (změřeno 19–38 úderů na hru), každý zásah až po celém varování.
          expect(strikesIn(world, bot.inputs), `${cell.id} seed ${seed}: strikes`).toBeGreaterThanOrEqual(10);
          expect(telegraphCheck(world, bot.inputs).violations).toEqual([]);
        }
        if (bot.outcome === 'won') {
          wins += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeLessThanOrEqual(90);
        }
      }
      expect(wins, `${cell.id}: intermediate wins`).toBeGreaterThanOrEqual(7);
    }, 300_000);
  }

  it('keeps the phases a spec brings over the curve', () => {
    const cell = CELLS.find((candidate) => candidate.id === 'runner.default')!;
    const own = [{ start: 0, speedPercent: 100 }, { start: 500, speedPercent: 110 }];
    const made = arcadeWorldOf(compileRecipe({ ...assemblyOfCell(cell), phases: own }), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(phasesOf(made.world)).toEqual(own);
    expect(chain(made.world.control).map((ref) => ref.id)).toContain('pacing_control');
  });

  it('keeps the ramp in a race lost on the first crash (deviation T11)', () => {
    const recipe = compileRecipe(assemblyOfCell(CELLS.find((candidate) => candidate.id === 'voyage.race')!));
    // `genre.v2`: průběh bez power-upů (P46C), ty závod mění samy.
    const spec = { ...recipe, genre: { ...recipe.genre!, compilerVersion: 'genre.v2' } };
    const world = worldOf(spec);
    expect(chain(world.control).map((ref) => ref.id)).not.toContain('pacing_control');
    expect(world).toEqual(worldOf(storedOf(spec)));
  });

  it('checks a paced race with a ramp corner by corner: only the final sprint stretches the river', () => {
    const race = compileRecipe(assemblyOfCell(CELLS.find((candidate) => candidate.id === 'voyage.race')!));
    // Tentýž závod se třemi nárazy průběh dostane.
    const spec = { ...race, controlParams: { ...race.controlParams, crashBudget: 3 } };
    const paced = worldOf(spec), stored = worldOf(storedOf(spec));
    expect(phasesOf(paced)).toBeDefined();
    // Celá trať natažená o 125/120 by byla o 4 % delší; jen finále (od 850 ‰) přidá 0,6 %.
    expect(paced.length / stored.length).toBeGreaterThan(1);
    expect(paced.length / stored.length).toBeLessThan(1.01);
  });

  it('runs the runner curve over the ramp middle level and stretches only from the peak', () => {
    const spec = compileRecipe(assemblyOfCell(CELLS.find((candidate) => candidate.id === 'runner.default')!));
    const paced = worldOf(spec), stored = worldOf(storedOf(spec));
    const runner = chain(paced.control).find((ref) => ref.id === 'runner')!;
    // Jedna značka na startu (+10 %), druhá za cílem se nepřejede.
    expect(runner.params.ramp).toEqual([0, expect.any(Number)]);
    expect((runner.params.ramp as number[])[1]).toBeGreaterThan(paced.length);
    // Vrchol 115 % nad úrovní 110 % přesáhne vrchol rampy 120 %: od 650 ‰ natažení 126,5/120, před ním trať beze změny.
    expect(paced.length / stored.length).toBeGreaterThan(1.04);
    expect(paced.length / stored.length).toBeLessThan(1.06);
  });
});

describe('runner lane threats see the rows (R2)', () => {
  const { w, h, d } = OBSTACLES.crate;
  const crate = (lane: number, z: number): BodyInit => ({ role: 'obstacle', kind: 'crate', x: lane * RUNNER.laneWidth, y: 0, z, w, h, d, solid: true });
  /** Prázdná trať běžce s flankerem v `place` a řadou beden `crates` (pruh, z). */
  const scene = (flankers: readonly { x: number; z: number }[], crates: readonly (readonly [number, number])[]) => {
    const { world, body } = behaviourHarness('track', 'flanker', 1, {
      place: () => flankers,
      extra: (parts) => ({ ...parts, level: { ...parts.level, bodies: [...parts.level.bodies, ...crates.map(([lane, z]) => crate(lane, z))] } }),
    });
    const state = instantiate(world);
    state[bodyBase(0) + BODY.vz] = 150;
    return { world, body, state };
  };

  it('steps out of the strike into the lane the row leaves open, not into the crate', () => {
    // Úder v pruhu 0 dojede hráč za 5 tiků; bedna stojí v pruhu −1 (dřívější uhnutí by šlo na stranu, kde je volno napříč), +1 je volný.
    for (const [blocked, away] of [[-1, BUTTON.RIGHT], [1, BUTTON.LEFT]] as const) {
      const { state } = scene([], [[blocked, 1700]]);
      const strike = { x: 0, y: 0, z: 1700, w: 900, h: 1500, d: 900 };
      const input = planLanes({ state, player: 0, tick: 0, recent: [] }, [() => strike], NO_INPUT);
      expect(input.buttons & (BUTTON.LEFT | BUTTON.RIGHT), `crate in lane ${blocked}`).toBe(away);
    }
  });

  it('plans past its first move: dodges toward the crate it can leave again after the strike, not the later one', () => {
    // Úder v pruhu 0 (kroky 5–16); bedna v pruhu −1 od kroku 21, v pruhu +1 od 31. Vlevo projde jen plán, který se po
    // úderu vrátí do pruhu 0 (vpravo v kroku 16); plán jen z prvního tahu by vybral pozdější bednu vpravo.
    const { state } = scene([], [[-1, 4100], [1, 5600]]);
    const strike = { x: 0, y: 0, z: 1700, w: 900, h: 1500, d: 900 };
    const input = planLanes({ state, player: 0, tick: 0, recent: [] }, [() => strike], NO_INPUT);
    expect(input.buttons & (BUTTON.LEFT | BUTTON.RIGHT)).toBe(BUTTON.LEFT);
  });

  it('a flanker waits rather than lock the only lane a row leaves open where the player meets it', () => {
    // Flanker 10 m před hráčem ve vedlejším pruhu je připravený; výpad do pruhu 0 dojede hráč kolem 19 m.
    const open = scene([{ x: RUNNER.laneWidth, z: 10 * UNIT }], []);
    stepBehaviours(open.state, 0, refsOf(open.world), 'track', 1000);
    expect(behaviourPhaseOf(open.state, open.body)).toBe('telegraph');
    // Řada s bednami v pruzích ±1 právě tam: jediný volný pruh by flanker zavřel – počká.
    const trap = scene([{ x: RUNNER.laneWidth, z: 10 * UNIT }], [[-1, 19 * UNIT], [1, 19 * UNIT]]);
    stepBehaviours(trap.state, 0, refsOf(trap.world), 'track', 1000);
    expect(behaviourPhaseOf(trap.state, trap.body)).toBe('idle');
  });

  it('an add-on steering for coins still dodges: its lane press goes through the planner and the game publishes', () => {
    // Běžec „+collect“ ze žánru (varianta P41): bez plánovače za doplňkem robot na semínku 1 prohrál – mince ho střídavě
    // s uhnutím táhla do pruhu výstřelu.
    const genre = readGenreSpec({ genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest' });
    if (!genre.ok) throw new Error(genre.issues.join('; '));
    const read = readGameSpec({ ...compileGenre(genre.value as GenreSpec), addons: ['collect'] });
    if (!read.ok) throw new Error(read.issues.join('; '));
    for (const seed of [1, 2, 3]) expect(compileArcade(read.value, seed).ok, `seed ${seed}`).toBe(true);
  }, 60_000);
});
