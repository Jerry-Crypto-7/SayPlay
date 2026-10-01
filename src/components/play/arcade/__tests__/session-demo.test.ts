/**
 * Ukázka „Show me how“ (P27D T3): relace v reálném čase přehraje záznam robota
 * ověřovače a skončí týmž výsledkem a hashem jako publikace. Stisky hráče
 * během ukázky do hry ani do lidského záznamu nejdou; restart ukázku ukončí.
 */

import { describe, expect, it, vi } from 'vitest';

import platformFixture from '@/play/arcade/__fixtures__/platform.json';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import shooterFixture from '@/play/arcade/__fixtures__/shooter.json';
import timingFixture from '@/play/arcade/__fixtures__/timing.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { AXIS_MAX, type ArcadeWorld, BUTTON } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { runBot } from '@/play/arcade/verify';
import { readGameSpec } from '@/play/spec';

import { type ArcadeSession, TICK_MS, createArcadeSession, loopDemo } from '../session';

const worldOf = (raw: unknown): ArcadeWorld => {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
};

describe.each([
  ['runner', runnerFixture],
  ['platform', platformFixture],
  ['shooter', shooterFixture],
  ['timing', timingFixture],
])('demo of the verified run (%s)', (_name, fixture) => {
  const world = worldOf(fixture);
  const bot = runBot(world);

  it('ends with the outcome and hash the publish check saw, frame by frame', () => {
    const session = createArcadeSession(world, { waitForInput: true, swallowFirst: true });
    session.startDemo();
    expect(session.demo()).toEqual({ ended: false, verified: null });
    let frames = 0;
    while (session.snapshot().runState === 'running' && frames < 20_000) {
      // Hráč mačká a drží, ukázka to nesmí vzít za své.
      if (frames % 7 === 0) session.press(BUTTON.TAP | BUTTON.LEFT, AXIS_MAX);
      session.hold(frames % 11 === 0 ? -AXIS_MAX : 0);
      session.advance(TICK_MS);
      frames += 1;
    }
    expect(session.snapshot().runState).toBe(bot.outcome);
    expect(session.snapshot().tick).toBe(bot.tick);
    expect(hashArcade(session.state())).toBe(bot.hash);
    expect(session.demo()).toEqual({ ended: true, verified: true });
    // Lidský záznam zůstal prázdný: ukázka není hráč.
    expect(session.inputs()).toEqual([]);
  });

  it('restart leaves the demo and takes the player input again', () => {
    const session = createArcadeSession(world);
    session.startDemo();
    for (let frame = 0; frame < 30; frame += 1) session.advance(TICK_MS);
    session.restart();
    expect(session.demo()).toBeNull();
    expect(session.snapshot().tick).toBe(0);
    session.press(BUTTON.TAP);
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([{ tick: 0, buttons: BUTTON.TAP, axis: 0 }]);
  });

  it('only a player run is a human run: not the demo, not a bot replay (P27D T4)', () => {
    const session = createArcadeSession(world);
    expect(session.humanRun()).toBe(true);
    session.startDemo();
    expect(session.humanRun()).toBe(false);
    session.restart();
    expect(session.humanRun()).toBe(true);
    session.playInputs(session.botInputs(), 100_000);
    expect(session.snapshot().runState).toBe(bot.outcome);
    expect(session.humanRun()).toBe(false);
    session.restart();
    expect(session.humanRun()).toBe(true);
  });

  it('a pause in the middle of the demo does not change where it ends', () => {
    const session = createArcadeSession(world);
    session.startDemo();
    for (let frame = 0; frame < 40; frame += 1) session.advance(TICK_MS);
    session.pause();
    for (let frame = 0; frame < 40; frame += 1) session.advance(TICK_MS);
    session.resume();
    expect(session.demo()).not.toBeNull();
    let frames = 0;
    while (session.snapshot().runState === 'running' && frames < 20_000) {
      session.advance(TICK_MS);
      frames += 1;
    }
    expect(hashArcade(session.state())).toBe(bot.hash);
    expect(session.demo()?.verified).toBe(true);
  });
});

// Výloha vstupní stránky (P28D T7): po konci ukázky za pauzu hraje znovu od začátku, úklid smyčku zastaví.
describe('landing demo loops (P28D T7)', () => {
  const world = worldOf(runnerFixture);

  const playOut = (session: ArcadeSession) => {
    let frames = 0;
    while (session.snapshot().runState === 'running' && frames < 20_000) {
      session.advance(TICK_MS);
      frames += 1;
    }
  };

  it('starts the demo, replays it a pause after it ends and stops on cleanup', () => {
    vi.useFakeTimers();
    try {
      const session = createArcadeSession(world, { waitForInput: true, swallowFirst: true });
      const stop = loopDemo(session, 1000);
      expect(session.demo()).toEqual({ ended: false, verified: null });
      playOut(session);
      expect(session.demo()?.ended).toBe(true);
      vi.advanceTimersByTime(999);
      expect(session.demo()?.ended).toBe(true);
      vi.advanceTimersByTime(1);
      expect(session.demo()).toEqual({ ended: false, verified: null });
      expect(session.snapshot()).toMatchObject({ runState: 'running', tick: 0 });
      stop();
      playOut(session);
      vi.advanceTimersByTime(5000);
      expect(session.demo()?.ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
