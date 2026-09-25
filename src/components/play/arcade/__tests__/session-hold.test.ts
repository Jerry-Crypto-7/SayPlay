/**
 * Držený vstup relace (P28B T5): brzda závodu je držené tlačítko, takže
 * při 30 i 60 snímcích za sekundu brzdí stejně; se `swallowFirst` míření
 * hodiny nepustí a první klik střelnice (míř + střel) jen spustí hru.
 */

import { describe, expect, it } from 'vitest';

import shooterFixture from '@/play/arcade/__fixtures__/shooter.json';
import steerFixture from '@/play/arcade/__fixtures__/steer.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { readGameSpec } from '@/play/spec';

import { type ArcadeSession, TICK_MS, createArcadeSession } from '../session';

const worldOf = (raw: unknown): ArcadeWorld => {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
};

const speedOf = (session: ArcadeSession): number => session.state()[bodyBase(session.state()[HEADER.player] as number) + BODY.vz] as number;

/** 1,5 s plynu, pak 1 s brzdy, při `fps` snímcích za sekundu. */
function brakeRun(fps: number, perFrame: (session: ArcadeSession) => void): number {
  const session = createArcadeSession(worldOf(steerFixture));
  const frame = TICK_MS * (60 / fps);
  for (let t = 0; t < 1.5 * fps; t += 1) session.advance(frame);
  session.holdButtons(BUTTON.DOWN);
  for (let t = 0; t < fps; t += 1) {
    perFrame(session);
    session.advance(frame);
  }
  return speedOf(session);
}

describe('held input', () => {
  it('a held brake slows the car the same at 30 and 60 fps', () => {
    const at60 = brakeRun(60, () => undefined);
    const at30 = brakeRun(30, () => undefined);
    const cruise = (() => {
      const session = createArcadeSession(worldOf(steerFixture));
      for (let t = 0; t < 150; t += 1) session.advance(TICK_MS);
      return speedOf(session);
    })();
    // Brzda opravdu brzdí – jinak by rovnost nic neříkala.
    expect(at60).toBeLessThan(cruise);
    expect(Math.abs(at30 - at60)).toBeLessThanOrEqual(Math.abs(at60) * 0.01);
  });

  it('with swallowFirst an aim hold does not start the clock and the first click does not fire', () => {
    const range = worldOf(shooterFixture);
    const session = createArcadeSession(range, { waitForInput: true, swallowFirst: true });
    const shots = session.snapshot().shots;
    session.hold(-600);
    session.advance(TICK_MS * 2);
    expect(session.snapshot().tick).toBe(0);
    // Klik = míř + střel; tenhle jen spustí hru.
    session.press(BUTTON.TAP, -600);
    session.advance(TICK_MS * 2);
    expect(session.snapshot().shots).toBe(shots);
    expect(session.inputs().every((input) => (input.buttons & BUTTON.TAP) === 0)).toBe(true);
    // Druhý klik už střílí.
    session.press(BUTTON.TAP, -600);
    session.advance(TICK_MS * 2);
    expect(session.snapshot().shots).toBe(shots - 1);
  });
});
