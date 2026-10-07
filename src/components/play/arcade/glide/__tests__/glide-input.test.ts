import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { buildWorld, hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { glideCourse, glideCourseParams } from '@/play/arcade/pieces/glide';
import { createArcadeSession, TICK_MS } from '../../session';
import { placeGlide } from '../camera';
import { glideInput } from '../glide-input';

// Native staged seam. The real session receives the same native control/rules;
// registration in the production library is owned by the integration task.
vi.mock('@/play/arcade/library', async importOriginal => {
  const original = await importOriginal<typeof import('@/play/arcade/library')>();
  const { glideControl, glideFinish } = await import('@/play/arcade/pieces/glide');
  const { glideBot } = await import('@/play/arcade/pieces/glide-bot');
  return { ...original, ARCADE_LIBRARY: {
    ...original.ARCADE_LIBRARY,
    controls: { ...original.ARCADE_LIBRARY.controls, glide: glideControl },
    rules: { ...original.ARCADE_LIBRARY.rules, glide_finish: glideFinish },
    bots: { ...original.ARCADE_LIBRARY.bots, glide_bot: glideBot },
  } };
});

function flight() {
  const parts = glideCourse.parts(1, glideCourseParams.parse({}), undefined);
  const built = buildWorld({ seed: 1, ...parts }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return createArcadeSession(built.world);
}

describe('native 3D glide input', () => {
  it.each(['touch', 'keys'] as const)('%s changes actual side and height simultaneously and replays identically', source => {
    const session = flight(), input = glideInput(true);
    const p = bodyBase(session.state()[HEADER.player]!);
    const startX = session.state()[p + BODY.x]!, startY = session.state()[p + BODY.y]!;
    if (source === 'touch') {
      input.down(1, 100, 100); input.move(1, 130, 60); input.down(2, 240, 100);
    } else {
      input.key('arrowright', true); input.key('arrowup', true); input.key(' ', true);
    }
    for (let tick = 0; tick < 20; tick++) {
      const held = input.snapshot(); session.hold(held.axis); session.holdButtons(held.buttons); session.advance(TICK_MS);
    }
    expect(session.state()[p + BODY.x]!).toBeGreaterThan(startX);
    expect(session.state()[p + BODY.y]!).toBeGreaterThan(startY);
    expect(session.inputs().every(event => event.axis > 0 && (event.buttons & BUTTON.UP) !== 0 && (event.buttons & BUTTON.FIRE) !== 0)).toBe(true);
    expect(replay(session.world, session.inputs(), ARCADE_LIBRARY, session.snapshot().tick).hash).toBe(hashArcade(session.state()));
  });

  it.each([1, 2])('release/cancel of pointer %i preserves the other ownership', released => {
    const input = glideInput(true);
    input.down(1, 100, 100); input.move(1, 145, 60); input.down(2, 240, 100);
    input.up(released);
    expect(input.snapshot().axis > 0).toBe(released === 2);
    expect((input.snapshot().buttons & BUTTON.UP) !== 0).toBe(released === 2);
    expect((input.snapshot().buttons & BUTTON.FIRE) !== 0).toBe(released === 1);
    input.clear(); expect(input.snapshot()).toEqual({ axis: 0, buttons: 0 });
  });

  it('brakes independently and never adds fire to a world without a blaster', () => {
    const input = glideInput(false);
    expect(input.key(' ', true)).toBe(false);
    input.key('shift', true); input.key('w', true); input.key('d', true);
    expect(input.snapshot()).toEqual({ axis: 1000, buttons: BUTTON.HOLD | BUTTON.UP });
  });
});

describe('glide camera follows real altitude', () => {
  it.each([390 / 844, 16 / 9])('frames the actual hero on aspect %f', aspect => {
    const camera = new PerspectiveCamera(50, aspect, 0.1, 300), look = new Vector3();
    for (const y of [1, 6, 12]) {
      placeGlide(camera, look, -4, y, 50);
      camera.updateMatrixWorld();
      const hero = new Vector3(-4, y + 0.35, 50).project(camera);
      expect(Math.abs(hero.x)).toBeLessThan(0.75);
      expect(Math.abs(hero.y)).toBeLessThan(0.85);
      expect(hero.z).toBeGreaterThan(-1); expect(hero.z).toBeLessThan(1);
      expect(look.y).toBe(y + 0.5);
    }
  });
});
