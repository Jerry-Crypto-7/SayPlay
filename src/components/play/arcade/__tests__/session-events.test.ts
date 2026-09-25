/**
 * Události pro zvuk a odezvu (P28C T1): hráčův tik je předá posluchačům,
 * ukázka a přehrání ne, a stav ani hash se tím nezmění.
 */

import { describe, expect, it } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import type { ArcadeEffect, InputEvent } from '@/play/arcade/contract';
import { hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { readGameSpec } from '@/play/spec';

import { type ArcadeSession, createArcadeSession } from '../session';

const world = (() => {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

/** Hráč „ručně“ zahraje záznam robota tik po tiku – tytéž stisky, které by přišly z klávesnice. */
function playByHand(session: ArcadeSession, inputs: readonly InputEvent[], ticks: number): void {
  let next = 0;
  for (let tick = 0; tick < ticks && session.snapshot().runState === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    if (event !== undefined && event.tick === tick) {
      session.hold(event.axis);
      session.press(event.buttons);
    } else session.hold(0);
    session.stepOnce();
  }
}

describe('arcade session events (P28C T1)', () => {
  it('one pickup is one score event, on the tick the score moves', () => {
    const session = createArcadeSession(world);
    const heard: { tick: number; events: readonly ArcadeEffect[] }[] = [];
    session.onEvents((events, tick) => heard.push({ tick, events }));
    const scoreAt = new Map<number, number>();
    session.subscribe(() => scoreAt.set(session.snapshot().tick, session.snapshot().score));
    playByHand(session, session.botInputs(), 90 * 60);

    expect(session.snapshot().runState).toBe('won');
    const scored = heard.filter((entry) => entry.events.some((event) => event.kind === 'score'));
    expect(scored.length).toBeGreaterThan(0);
    // Každý tik, kdy skóre vyskočí, má právě jednu událost `score` – a žádný jiný ji nemá.
    const rises = [...scoreAt].filter(([tick, score]) => score > (scoreAt.get(tick - 1) ?? 0)).map(([tick]) => tick - 1);
    expect(scored.map((entry) => entry.tick)).toEqual(rises);
    for (const entry of scored) expect(entry.events.filter((event) => event.kind === 'score')).toHaveLength(1);
    expect(heard.at(-1)?.events.some((event) => event.kind === 'win')).toBe(true);
  });

  it('the demo and a replay never call the listener', () => {
    const session = createArcadeSession(world);
    let calls = 0;
    session.onEvents(() => {
      calls += 1;
    });
    expect(session.playInputs(session.botInputs(), 90 * 60).runState).toBe('won');
    session.startDemo();
    for (let frame = 0; frame < 600; frame += 1) session.stepOnce();
    expect(calls).toBe(0);
  });

  it('a listener leaves the hash after 600 ticks where the kernel puts it', () => {
    const inputs = createArcadeSession(world).botInputs();
    const session = createArcadeSession(world);
    session.onEvents(() => undefined);
    playByHand(session, inputs, 600);
    expect(session.snapshot().tick).toBe(600);
    const pinned = replay(world, inputs, ARCADE_LIBRARY, 600).hash;
    expect(hashArcade(session.state())).toBe(pinned);
    // Před rampou rychlosti (P28C T6) '28ef2d9e'; svět teď nese značky rampy.
    expect(pinned).toBe('1b7cf2ba');
  });
});
