/**
 * Odpuštění skoku běžce (P36A T6, `feel: 2`): stejná okna jako skákačka –
 * skok ještě 100 ms po sběhnutí z hrany (coyote) a stisk až 120 ms před
 * dopadem skočí při dopadu (buffer). Žánr Běžec ho zapne vždy; uložený spec
 * a svět bez `feel` skáčou dál jen ze země v tiku stisku.
 */

import { describe, expect, it } from 'vitest';

import { compileGenre } from '@/play/genre/index';
import { readGameSpec } from '@/play/spec';

import runnerFixture from '../__fixtures__/runner.json';
import { arcadeWorldOf } from '../compile';
import { type ArcadeInput, type ArcadeWorld, BODY, BUTTON, type BodyInit, FLAG, NO_INPUT, bodyBase } from '../contract';
import { GRAVITY, buildWorld, instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { RUNNER } from '../pieces/runner';

const PLAYER: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: RUNNER.playerW, h: RUNNER.runH, d: RUNNER.playerD, solid: false };
/** Vyvýšená deska, ze které běžec sám seběhne: horní hrana 1 m, konec 6 m před startem. */
const LEDGE = { top: 1000, far: 6000 } as const;

/** Běžec krok po kroku na rovině, nebo na vyvýšené desce, ze které seběhne. */
function play(feel: 2 | undefined, ledge = false) {
  const bodies: BodyInit[] = ledge
    ? [{ ...PLAYER, y: LEDGE.top }, { role: 'platform', kind: 'platform', x: 0, y: 0, z: (LEDGE.far - 2000) / 2, w: 3 * RUNNER.laneWidth, h: LEDGE.top, d: LEDGE.far + 2000, solid: true }]
    : [PLAYER];
  const control = { id: 'runner', params: feel === undefined ? { speed: 'normal' } : { speed: 'normal', feel } };
  const built = buildWorld({ seed: 1, control, rules: [], bot: { id: 'runner_bot', params: {} }, level: { bodies, length: 100_000 } }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const state = instantiate(built.world);
  const program = loadProgram(built.world, ARCADE_LIBRARY);
  const base = bodyBase(0);
  return {
    step: (input: ArcadeInput = NO_INPUT) => step(state, input, program),
    grounded: () => ((state[base + BODY.flags] as number) & FLAG.grounded) !== 0,
    vy: () => state[base + BODY.vy] as number,
    h: () => state[base + BODY.h] as number,
  };
}

const TAP: ArcadeInput = { buttons: BUTTON.TAP, axis: 0 };
const DOWN: ArcadeInput = { buttons: BUTTON.DOWN, axis: 0 };
const JUMPED = RUNNER.jumpVy - GRAVITY;

/** Seběhne z desky: hra v prvním tiku, kdy běžec nestojí (a neskočil). */
function offTheEdge(feel: 2 | undefined) {
  const game = play(feel, true);
  game.step();
  expect(game.grounded(), 'starts on the ledge').toBe(true);
  for (let i = 0; i < 120 && game.grounded(); i += 1) game.step();
  expect(game.grounded()).toBe(false);
  expect(game.vy()).toBeLessThanOrEqual(0);
  return game;
}

/** Skok z roviny: kolik tiků po odrazu běžec znovu stojí. */
function landingTick(): number {
  const game = play(undefined);
  game.step();
  game.step(TAP);
  for (let tick = 1; tick < 200; tick += 1) {
    game.step();
    if (game.grounded()) return tick;
  }
  throw new Error('never landed');
}

/** Skok z roviny a druhý stisk `before` tiků před dopadem (`extra` přidá další vstup do vzduchu). */
function bufferedJump(feel: 2 | undefined, before: number, extra?: { readonly at: number; readonly input: ArcadeInput }) {
  const land = landingTick();
  const game = play(feel);
  game.step();
  game.step(TAP);
  for (let tick = 1; tick <= land; tick += 1) game.step(tick === land - before ? TAP : tick === extra?.at ? extra.input : NO_INPUT);
  expect(game.grounded(), 'lands').toBe(true);
  game.step();
  return { game };
}

describe('runner feel: 2 – coyote time', () => {
  it('a jump pressed 4 ticks after running off an edge still jumps; without feel it falls', () => {
    const felt = offTheEdge(2);
    for (let i = 0; i < 3; i += 1) felt.step();
    felt.step(TAP);
    expect(felt.vy()).toBe(JUMPED);
    const old = offTheEdge(undefined);
    for (let i = 0; i < 3; i += 1) old.step();
    old.step(TAP);
    expect(old.vy()).toBeLessThan(0);
  });

  it('the window closes after 100 ms (6 ticks)', () => {
    const late = offTheEdge(2);
    for (let i = 0; i < 6; i += 1) late.step();
    late.step(TAP);
    expect(late.vy()).toBeLessThan(0);
  });
});

describe('runner feel: 2 – jump buffer', () => {
  it('a press 5 ticks before landing jumps right after landing; without feel it is lost', () => {
    expect(bufferedJump(2, 5).game.vy(), 'buffered jump').toBe(JUMPED);
    expect(bufferedJump(undefined, 5).game.grounded(), 'old runner stays on the ground').toBe(true);
  });

  it('a press 9 ticks before landing is too early and does nothing', () => {
    expect(bufferedJump(2, 9).game.grounded()).toBe(true);
  });

  it('a slide pressed after the buffered jump wins: no jump, the runner slides', () => {
    const slid = bufferedJump(2, 5, { at: landingTick() - 2, input: DOWN }).game;
    expect(slid.grounded()).toBe(true);
    expect(slid.h()).toBe(RUNNER.slideH);
  });

  it('a tap from the ground jumps the same tick and the slide lasts as long as before', () => {
    const game = play(2);
    game.step();
    game.step(TAP);
    expect(game.vy()).toBe(JUMPED);
    const sliding = play(2);
    sliding.step();
    sliding.step(DOWN);
    expect(sliding.h()).toBe(RUNNER.slideH);
    for (let t = 0; t < RUNNER.slideTicks - 1; t += 1) sliding.step();
    expect(sliding.h()).toBe(RUNNER.slideH);
    sliding.step();
    expect(sliding.h()).toBe(RUNNER.runH);
  });
});

describe('runner feel: 2 – who gets it', () => {
  const controlOf = (world: ArcadeWorld): Record<string, unknown> => world.control.params as Record<string, unknown>;

  it('every runner genre game carries feel: 2 to the control', () => {
    const spec = compileGenre({ genre: 'runner', mode: 'default', hero: 'penguin', enemy: 'rock', collectible: 'snowflake', setting: 'icy mountain slope' });
    expect(spec.controlParams).toMatchObject({ feel: 2 });
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(controlOf(made.world)).toMatchObject({ feel: 2 });
  });

  it('a stored runner spec without feel builds a control without it', () => {
    const read = readGameSpec(runnerFixture);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const made = arcadeWorldOf(read.value, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(controlOf(made.world)).not.toHaveProperty('feel');
  });
});
