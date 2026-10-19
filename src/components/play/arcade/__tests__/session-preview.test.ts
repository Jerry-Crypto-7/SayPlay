/**
 * Náhled robota na kartě feedu (P54A T4): relace tiše dopočte stav do
 * `startTick`, pak v reálném čase hraje okno do `endTick` a vrací se na
 * začátek okna. Relace rozhoduje, co se počítá jako lidský běh (skóre, Dare,
 * hvězdy) – náhled, který prosákne do `humanRun`, do záznamu nebo do událostí
 * smyčky, tiše zkreslí čítače feedu.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import arenaFixture from '@/play/arcade/__fixtures__/arena.json';
import platformFixture from '@/play/arcade/__fixtures__/platform.json';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import shooterFixture from '@/play/arcade/__fixtures__/shooter.json';
import throwFixture from '@/play/arcade/__fixtures__/throw.json';
import timingFixture from '@/play/arcade/__fixtures__/timing.json';
import { compileArcade, preloadPhysics } from '@/play/arcade/compile';
import { AXIS_MAX, type ArcadeWorld, BUTTON } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { readGameSpec } from '@/play/spec';
import { previewOf } from '@/play/version/preview';
import type { FeedPreview } from '@/play/version/version';

import { type ArcadeSession, PREVIEW_GAP_MS, TICK_MS, createArcadeSession } from '../session';

const FIXTURES = [
  ['runner', runnerFixture],
  ['platform', platformFixture],
  ['shooter', shooterFixture],
  ['timing', timingFixture],
  ['arena', arenaFixture],
  ['throw', throwFixture],
] as const;

const games = new Map<string, { world: ArcadeWorld; preview: FeedPreview }>();

beforeAll(async () => {
  for (const [name, raw] of FIXTURES) {
    const spec = readGameSpec(raw);
    if (!spec.ok) throw new Error(spec.issues.join('; '));
    await preloadPhysics(spec.value, loadRapier);
    const compiled = [1, 2, 3, 4].map((seed) => compileArcade(spec.value, seed)).find((result) => result.ok);
    if (compiled === undefined || !compiled.ok || compiled.value.arcade === undefined) throw new Error(`${name}: does not compile`);
    const world = compiled.value.arcade;
    games.set(name, { world, preview: previewOf(world, runBot(world)) });
  }
}, 120_000);

const tick = (session: ArcadeSession): number => session.snapshot().tick;

/** Hraje okno snímek po snímku do `endTick`; vrací hash v `endTick`. */
function playWindow(session: ArcadeSession, preview: FeedPreview, poke = false): string {
  let frames = 0;
  while (tick(session) < preview.endTick && frames < 2_000) {
    if (poke && frames % 5 === 0) session.press(BUTTON.TAP | BUTTON.LEFT, AXIS_MAX);
    if (poke) session.hold(frames % 3 === 0 ? -AXIS_MAX : 0);
    session.advance(TICK_MS);
    frames += 1;
  }
  expect(tick(session)).toBe(preview.endTick);
  return hashArcade(session.state());
}

describe.each(FIXTURES.map(([name]) => name))('bot preview window (%s)', (name) => {
  it('computes silently up to startTick, then plays to the hash of endTick and loops back', () => {
    const { world, preview } = games.get(name)!;
    const session = createArcadeSession(world, { waitForInput: true, swallowFirst: true });
    const heard: number[] = [];
    session.onEvents((_events, at) => heard.push(at));
    let notified = 0;
    session.subscribe(() => (notified += 1));
    session.startPreview(preview);
    // Dopočet je jeden skok: kreslení dostane upozornění za restart a za konec dopočtu, ne za každý tik; posluchače efektů žádné.
    expect(notified).toBeLessThanOrEqual(2);
    expect(tick(session)).toBe(preview.startTick);
    expect(playWindow(session, preview)).toBe(preview.hash);

    // Pauza mezi opakováními: stav stojí v `endTick`, pak se vrátí na začátek okna.
    session.advance(PREVIEW_GAP_MS / 2);
    expect(tick(session)).toBe(preview.endTick);
    for (let frames = 0; frames < 200 && tick(session) !== preview.startTick; frames += 1) session.advance(TICK_MS);
    expect(tick(session)).toBe(preview.startTick);
    expect(playWindow(session, preview)).toBe(preview.hash);
    expect(heard).toEqual([]);
    expect(session.inputs()).toEqual([]);
  });

  it('drops the player\'s presses, is not a human run and reports a running preview', () => {
    const { world, preview } = games.get(name)!;
    const session = createArcadeSession(world, { waitForInput: true, swallowFirst: true });
    session.startPreview(preview);
    expect(session.humanRun()).toBe(false);
    expect(session.demo()).toEqual({ ended: false, verified: null, preview: true });
    expect(playWindow(session, preview, true)).toBe(preview.hash);
    expect(session.inputs()).toEqual([]);
    expect(session.humanRun()).toBe(false);
    expect(session.live({ kind: 'visual', weather: 'rain' })).not.toBeNull();
  });

  it('restart hands the player a clean session from tick 0', () => {
    const { world, preview } = games.get(name)!;
    const session = createArcadeSession(world, { waitForInput: true, swallowFirst: true });
    session.startPreview(preview);
    playWindow(session, preview);
    session.restart();
    expect(tick(session)).toBe(0);
    expect(session.demo()).toBeNull();
    expect(session.humanRun()).toBe(true);
    expect(session.playedOnce()).toBe(false);
    const heard: number[] = [];
    session.onEvents((_events, at) => heard.push(at));
    // Hodiny čekají na první stisk hráče; ten se spolkne, nebo padne do tiku 0.
    session.press(BUTTON.TAP);
    for (let frames = 0; frames < 30; frames += 1) {
      session.press(BUTTON.TAP);
      session.advance(TICK_MS);
    }
    expect(tick(session)).toBeGreaterThan(0);
    expect(session.inputs().length).toBeGreaterThan(0);
    expect(session.inputs()[0]!.tick).toBe(0);
  });
});
