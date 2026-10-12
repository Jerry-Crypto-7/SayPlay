import { describe, expect, it } from 'vitest';

import { HEADER, type InputEvent, type ArcadeWorld } from '../../../contract';
import { replay } from '../../../kernel';
import { ARCADE_LIBRARY } from '../../../library';
import { runBot } from '../../../verify';
import { ARENA } from '../../arena';
import { type BehaviourSpace, overlaps, shotBodies, telegraphOf } from '../index';
import { SNIPER } from '../sniper';
import { HEALTH, behaviourHarness, healthAfter, play, read, refsOf, telegraphCheck } from './harness';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SPACES: readonly BehaviourSpace[] = ['plane', 'track'];

const botInputs = (world: ArcadeWorld): readonly InputEvent[] => runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs;

describe('sniper', () => {
  it.each(SPACES)('(a) hits the threat probe and a player standing on the line – %s', (space) => {
    for (const seed of [1, 2]) {
      const { world, body } = behaviourHarness(space, 'sniper', seed);
      expect(healthAfter(world, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs)).toBeLessThan(HEALTH);
      expect(healthAfter(world, [])).toBeLessThan(HEALTH);
    }
  });

  it.each(SPACES)('(b) the intermediate bot wins at least 7 of 8 seeds, idle wins none – %s', (space) => {
    const outcomes = SEEDS.map((seed) => {
      const { world } = behaviourHarness(space, 'sniper', seed);
      return { bot: runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).outcome, idle: replay(world, [], ARCADE_LIBRARY).outcome };
    });
    expect(outcomes.filter((run) => run.bot === 'won').length).toBeGreaterThanOrEqual(7);
    expect(outcomes.filter((run) => run.idle === 'won')).toEqual([]);
  });

  it.each(SPACES)('(c) every shot that hits was fired after a full telegraph – %s', (space) => {
    let hits = 0;
    for (const seed of SEEDS) {
      const { world } = behaviourHarness(space, 'sniper', seed);
      for (const inputs of [[], botInputs(world)]) {
        const check = telegraphCheck(world, inputs);
        expect(check.violations).toEqual([]);
        hits += check.hits;
      }
    }
    // Ne prázdně: nečinného hráče výstřel trefí.
    expect(hits).toBeGreaterThan(SEEDS.length);
  });

  it('(d) the shot flies along the line locked at the telegraph start and never turns after the player', () => {
    let moved = 0;
    let shots = 0;
    for (const seed of SEEDS) {
      const { world, body } = behaviourHarness('plane', 'sniper', seed);
      const locked = { x: 0, z: 0 };
      const velocity = new Map<number, string>();
      play(world, botInputs(world), (state) => {
        const telegraph = telegraphOf(state, body);
        if (telegraph !== null) Object.assign(locked, telegraph.aim);
        for (const shot of shotBodies(state, state[HEADER.player] as number, refsOf(world))) {
          const v = `${String(read(state, shot, 'vx'))},${String(read(state, shot, 'vz'))}`;
          const first = velocity.get(shot);
          if (first !== undefined) {
            expect(v).toBe(first);
            continue;
          }
          velocity.set(shot, v);
          shots += 1;
          const ux = locked.x - read(state, body, 'x');
          const uz = locked.z - read(state, body, 'z');
          const vx = read(state, shot, 'vx');
          const vz = read(state, shot, 'vz');
          expect(Math.abs(vx * uz - vz * ux)).toBeLessThanOrEqual(Math.hypot(vx, vz) * Math.hypot(ux, uz) * 0.02);
          expect(vx * ux + vz * uz).toBeGreaterThan(0);
          if (Math.hypot(read(state, 0, 'x') - locked.x, read(state, 0, 'z') - locked.z) > 1000) moved += 1;
        }
        for (const shot of [...velocity.keys()]) if (!shotBodies(state, 0, refsOf(world)).includes(shot)) velocity.delete(shot);
      });
    }
    // Ne prázdně: hráč se během varování z místa zamčení pohnul, výstřel přesto letí na zamčené místo.
    expect(shots).toBeGreaterThan(SEEDS.length);
    expect(moved).toBeGreaterThan(0);
  });

  it('(e) the intermediate bot lets a shot pass within 1.5 m without a hit in at least 4 of 8 seeds', () => {
    const nearMisses = SEEDS.filter((seed) => {
      const { world } = behaviourHarness('plane', 'sniper', seed);
      // Nejmenší vzdálenost středů výstřelu a hráče za let.
      const closest = new Map<number, number>();
      let near = false;
      play(world, botInputs(world), (state, _tick, effects) => {
        for (const shot of shotBodies(state, 0, refsOf(world))) {
          const gap = Math.hypot(read(state, shot, 'x') - read(state, 0, 'x'), read(state, shot, 'z') - read(state, 0, 'z'));
          closest.set(shot, Math.min(closest.get(shot) ?? Number.POSITIVE_INFINITY, gap));
        }
        for (const effect of effects) {
          if (effect.kind !== 'despawn') continue;
          const gap = closest.get(effect.body);
          if (gap === undefined) continue;
          if (!overlaps(state, effect.body, 0) && gap <= 1500) near = true;
          closest.delete(effect.body);
        }
      });
      return near;
    });
    expect(nearMisses.length).toBeGreaterThanOrEqual(4);
  });

  it.each(SPACES)('(f) at most 3 shots in the air, each vanishing past the arena edge or behind the player – %s', (space) => {
    for (const seed of [1, 2, 3]) {
      const { world } = behaviourHarness(space, 'sniper', seed);
      let fired = 0;
      play(world, botInputs(world), (state) => {
        const live = shotBodies(state, 0, refsOf(world));
        // Přes úhlopříčku arény (57 m / 120 za tik) letí výstřel déle než dva cykly ostřelovače (228 tiků).
        expect(live.length).toBeLessThanOrEqual(3);
        for (const shot of live) {
          fired += 1;
          if (space === 'plane') expect(Math.max(Math.abs(read(state, shot, 'x')), Math.abs(read(state, shot, 'z')))).toBeLessThanOrEqual(ARENA.half + SNIPER.plane.shot);
          // 3 m za hráčem zmizí; za tik se k němu přiblíží nejvýš o jeho tempo + výstřel.
          else expect(read(state, 0, 'z') - read(state, shot, 'z')).toBeLessThanOrEqual(3500);
        }
      });
      expect(fired).toBeGreaterThan(0);
    }
  });

  it.each(SPACES)('(g) replays the bot record to the same hash – %s', (space) => {
    const { world } = behaviourHarness(space, 'sniper', 3);
    const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
  });
});
