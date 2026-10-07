import { describe, expect, it } from 'vitest';
import { BODY, BODY_STRIDE, BUTTON, HEADER, NO_INPUT, bodyBase, type ArcadeWorld } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step, type ArcadeLibrary } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { GLIDE, GLIDE_MODES, checkGlideLevel, glideControl, glideCourse, glideFinish, type GlideCourseParams } from '../pieces/glide';
import { glideBot } from '../pieces/glide-bot';
import { runBot } from '../verify';

// Pieces can be pinned before production registry/compile integration lands.
const library: ArcadeLibrary = { controls: { ...ARCADE_LIBRARY.controls, glide: glideControl }, rules: { ...ARCADE_LIBRARY.rules, glide_finish: glideFinish }, bots: { ...ARCADE_LIBRARY.bots, glide_bot: glideBot }, generators: { ...ARCADE_LIBRARY.generators, glide_course: glideCourse } };
function worldOf(seed: number, extra: Partial<GlideCourseParams> = {}): ArcadeWorld {
  const params = glideCourse.params.parse(extra);
  const parts = glideCourse.parts(seed, params, undefined);
  expect(parts.issues).toEqual([]);
  const built = buildWorld({ seed, ...parts }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('native glide course', () => {
  it.each(GLIDE_MODES)('%s wins seeds 1–20 with delayed steering and deterministic replay, idle cannot win', mode => {
    for (let seed = 1; seed <= 20; seed++) {
      const world = worldOf(seed, { mode });
      expect(worldOf(seed, { mode })).toEqual(world);
      const bot = runBot(world, library, { planner: false });
      expect(bot.outcome, `${mode}/${seed}`).toBe('won');
      expect(bot.inputs.some(input => input.axis !== 0)).toBe(true);
      expect(bot.inputs.some(input => (input.buttons & (BUTTON.UP | BUTTON.DOWN)) !== 0)).toBe(true);
      const again = replay(world, bot.inputs, library);
      expect(again.hash).toBe(bot.hash);
      expect(again.tick).toBe(bot.tick);
      expect(replay(world, [], library).outcome).toBe('lost');
    }
  }, 120_000);

  it('validates the hardest, fastest route with reaction and acceleration reserve', () => {
    expect(glideBot.reactionTicks).toBe(8);
    for (let seed = 1; seed <= 20; seed++) {
      const params = glideCourse.params.parse({ difficulty: 'hard', topSpeed: 240, lengthM: 400 });
      expect(checkGlideLevel(glideCourse.generate(seed, params), params.topSpeed)).toEqual([]);
      expect(runBot(worldOf(seed, params), library, { planner: false }).outcome).toBe('won');
    }
  }, 120_000);

  it('steering changes both horizontal and vertical position, with inertia on release', () => {
    const world = worldOf(1), state = instantiate(world), program = loadProgram(world, library);
    const p = bodyBase(0), y0 = state[p + BODY.y]!;
    for (let tick = 0; tick < 10; tick++) step(state, { axis: 1000, buttons: BUTTON.UP }, program);
    const x = state[p + BODY.x]!, y = state[p + BODY.y]!;
    expect(x).toBeGreaterThan(0); expect(y).toBeGreaterThan(y0);
    step(state, NO_INPUT, program);
    expect(state[p + BODY.x]).toBeGreaterThan(x); expect(state[p + BODY.y]).toBeGreaterThan(y);
  });

  it('a rival with physically excessive speed beats the player', () => {
    const world = worldOf(2, { mode: 'race' });
    const initial = [...world.initial];
    const rival = world.kinds.indexOf('glide-rival');
    for (let i = 0; i < initial[HEADER.bodyCount]!; i++) if (initial[bodyBase(i) + BODY.kind] === rival) initial[bodyBase(i) + BODY.vz] = 1000;
    expect(runBot({ ...world, initial }, library, { planner: false }).outcome).toBe('lost');
  });

  it('the pursuer moves and catches a stalled player through actual contact', () => {
    const world = worldOf(1, { mode: 'escape' });
    const state = instantiate(world), program = loadProgram(world, library);
    const pursuer = world.initial.findIndex((value, index) => index >= bodyBase(0) && (index - bodyBase(0)) % BODY_STRIDE === BODY.kind && value === world.kinds.indexOf('glide-pursuer'));
    expect(pursuer).toBeGreaterThan(0);
    const at = pursuer - BODY.kind;
    const start = state[at + BODY.z]!;
    for (let tick = 0; tick < 150 && outcomeOf(state) === 'running'; tick++) step(state, { axis: 0, buttons: BUTTON.HOLD }, program);
    expect(state[at + BODY.z]).toBeGreaterThan(start);
    expect(outcomeOf(state)).toBe('lost');
    expect(state[bodyBase(0) + BODY.z]).toBeLessThan(GLIDE.spacing);
  });
});
