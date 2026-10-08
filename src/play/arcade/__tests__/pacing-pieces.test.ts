import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ArcadeParts } from '../addons';
import { type ArcadeEffect, BODY, type BodyInit, type BotPiece, type ControlPiece, FLAG, HEADER, NO_INPUT, bodyBase, stateSize } from '../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { PACING, makePacingBot, makePacingControl, pacingRule, scaledParams, withPacing } from '../pieces/pacing';
import { runBot } from '../verify';

const partsOf = (generator: string, seed: number): ArcadeParts => {
  const mode = MODE_GENERATORS[generator];
  if (mode === undefined) throw new Error(generator);
  return mode.parts(seed, mode.params.parse({}), undefined) as ArcadeParts;
};

const chaserTemplate: BodyInit = { role: 'chaser', kind: 'chaser', x: 0, y: 0, z: 0, w: 900, h: 1400, d: 900, solid: false, kinematic: true };

describe('pacing pieces', () => {
  it('(a) replays a paced world to the same hash, twice in one process', () => {
    const parts = withPacing(partsOf('arena_escape', 3), { seed: 3, goal: { by: 'time', need: 3600, limit: 3600 }, space: 'plane', spots: [-15_000, -15_000, 15_000, -15_000, 15_000, 15_000, -15_000, 15_000], behaviours: [{ body: chaserTemplate }], budget: 6 });
    const made = buildWorld({ seed: 3, ...parts, health: 3 }, ARCADE_LIBRARY);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const run = runBot(made.world);
    const first = replay(made.world, run.inputs, ARCADE_LIBRARY);
    const second = replay(made.world, run.inputs, ARCADE_LIBRARY);
    expect(first.hash).toBe(run.hash);
    expect(second.hash).toBe(run.hash);
  });

  it('(b) leaves a world without pacing pieces on the hash it had on origin/main', () => {
    // Hash výhry robota, semínko 1, změřený na `0714a352` před registrací kusů průběhu.
    const pinned: Record<string, string> = { arena_escape: '09957dae', fight: '11826107', glide_course: 'bc501795' };
    const measured = Object.fromEntries(Object.keys(pinned).map((generator) => {
      const parts = partsOf(generator, 1);
      const made = buildWorld({ seed: 1, ...parts, ...(parts.health === undefined ? {} : { health: parts.health }) }, ARCADE_LIBRARY);
      if (!made.ok) throw new Error(made.issues.join('; '));
      return [generator, runBot(made.world).hash];
    }));
    expect(measured).toEqual(pinned);
  });

  describe('on a hand-built world', () => {
    const still: ControlPiece<Record<string, never>> = { id: 'still', params: z.object({}).strict(), roles: ['player'], cost: () => ({ bodies: 1, rules: 0 }), step: () => undefined };
    const idle: BotPiece<Record<string, never>> = { id: 'idle', params: z.object({}).strict(), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT };
    const library: ArcadeLibrary = { controls: { pacing_control: makePacingControl({ still }) as ControlPiece }, rules: { pacing: pacingRule as never }, generators: {}, bots: { pacing_bot: makePacingBot({ idle }) as BotPiece } };
    const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 800, h: 1000, d: 800, solid: false };
    const foe = (kind: string): BodyInit => ({ role: 'enemy', kind, x: 0, y: 0, z: 0, w: 800, h: 800, d: 800, solid: false, kinematic: true });

    it('(c) spawns in schedule order and never keeps more than maxActors alive', () => {
      const base: ArcadeParts = { control: { id: 'still', params: {} }, bot: { id: 'idle', params: {} }, level: { bodies: [player], length: 0, spawnSlots: 40 }, rules: [] };
      const parts = withPacing(base, { seed: 5, goal: { by: 'time', need: 1200, limit: 1200 }, space: 'plane', spots: [-9000, 0, 9000, 0, 0, 9000, 0, -9000], behaviours: [{ body: foe('a') }, { body: foe('b') }], budget: 14 });
      const made = buildWorld({ seed: 5, ...parts }, library);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const schedule = (parts.rules.at(-1)?.params as { schedule: { atPermille: number; template: number; count: number }[] }).schedule;
      expect(schedule.reduce((sum, entry) => sum + entry.count, 0)).toBeGreaterThan(PACING.maxActors);
      const program = loadProgram(made.world, library);
      const state = instantiate(made.world);
      const spawned: number[] = [];
      for (let tick = 0; tick < 1300; tick += 1) {
        step(state, NO_INPUT, program, (_rule: number, effect: ArcadeEffect) => { if (effect.kind === 'spawn') spawned.push(effect.template); });
        let alive = 0;
        for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) if (((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0) alive += 1;
        expect(alive).toBeLessThanOrEqual(PACING.maxActors);
      }
      expect(spawned).toEqual(schedule.flatMap((entry) => Array.from({ length: entry.count }, () => entry.template)).slice(0, PACING.maxActors));
    });

    it('(d) scales a knob with intensity and never past its bound', () => {
      const chase = (speed: number) => ({ half: 20_000, chase: { speed, lead: 30 } });
      expect((scaledParams('move_free', chase(70), 1100).chase as { speed: number }).speed).toBe(77);
      expect((scaledParams('move_free', chase(70), 700).chase as { speed: number }).speed).toBe(50);
      expect((scaledParams('move_free', chase(70), 1500).chase as { speed: number }).speed).toBe(90);
      expect(scaledParams('move_free', chase(70), 1100).half).toBe(20_000);
      expect(scaledParams('runner', { speed: 300 }, 1500)).toEqual({ speed: 300 });
    });

    it('(e) hands the bot the same scaled parameters the control used', () => {
      const seen: unknown[] = [];
      const spyControl: ControlPiece<unknown> = { id: 'move_free', params: z.unknown(), roles: [], cost: () => ({ bodies: 0, rules: 0 }), step: (_s, _p, _i, params) => { seen.push(params); } };
      const spyBot: BotPiece<unknown> = { id: 'arena_bot', params: z.unknown(), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: (_o, params) => { seen.push(params); return NO_INPUT; } };
      const control = makePacingControl({ move_free: spyControl });
      const bot = makePacingBot({ arena_bot: spyBot });
      const raw = { half: 20_000, chase: { speed: 70, lead: 30 } };
      const state = new Int32Array(stateSize(2));
      state[HEADER.bodyCount] = 2;
      state[HEADER.tick] = 1000;
      control.step(state, 0, NO_INPUT, { base: { id: 'move_free', params: raw }, goal: { by: 'time', need: 1200, limit: 1200 }, keeper: 1 });
      bot.decide({ state, player: 0, tick: 1000, recent: [] }, { base: { id: 'arena_bot', params: raw }, control: 'move_free', keeper: 1 });
      expect((seen[0] as { chase: { speed: number } }).chase.speed).toBe(90);
      expect(seen[1]).toEqual(seen[0]);
    });
  });
});
