import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { BODY, BUTTON, COUNTER, HEADER, bodyBase } from '@/play/arcade/contract';
import { buildWorld, hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { ballParams, ballPitch } from '@/play/arcade/pieces/ball';
import { loadRapier } from '@/play/arcade/physics/world';
import { releasePhysics } from '@/play/arcade/physics/step';
import { createArcadeSession } from '../../session';
import { ballInput } from '../ball-input';
import { placeBall } from '../camera';

vi.mock('@/play/arcade/library', async importOriginal => {
  const original = await importOriginal<typeof import('@/play/arcade/library')>();
  const { ballControl, ballLaunch, ballScore } = await import('@/play/arcade/pieces/ball');
  const { ballBot } = await import('@/play/arcade/pieces/ball-bot');
  return { ...original, ARCADE_LIBRARY: { ...original.ARCADE_LIBRARY, controls: { ...original.ARCADE_LIBRARY.controls, ball: ballControl }, rules: { ...original.ARCADE_LIBRARY.rules, ball_launch: ballLaunch, ball_score: ballScore }, bots: { ...original.ARCADE_LIBRARY.bots, ball_bot: ballBot } } };
});
beforeAll(async () => { await loadRapier(); });
function game() {
  const built = buildWorld({ seed: 1, ...ballPitch.parts(1, ballParams.parse({}), undefined) }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return createArcadeSession(built.world);
}

describe('real ball gestures', () => {
  it('two contrasting drags change direction, force and actual physics flight; both replay exactly', () => {
    const velocities: { vx: number; vz: number; x: number; z: number }[] = [];
    for (const [dx, dy] of [[-35, 30], [45, 135]]) {
      const session = game(), input = ballInput(session);
      try {
        input.down(1, 100, 100); input.move(1, 100 + dx!, 100 + dy!);
        for (let t = 0; t < 55; t++) session.stepOnce();
        const p = bodyBase(session.state()[HEADER.player]!);
        expect(session.state()[p + BODY.aux1]).toBe(Math.round(dy! / 3));
        input.up(1); session.stepOnce();
        const b = bodyBase(session.state()[HEADER.spawnBase]!);
        const vx = session.state()[b + BODY.vx]!, vz = session.state()[b + BODY.vz]!;
        for (let t = 0; t < 5; t++) session.stepOnce();
        velocities.push({ vx, vz, x: session.state()[b + BODY.x]!, z: session.state()[b + BODY.z]! });
        expect(session.inputs().some(event => event.buttons & BUTTON.TAP)).toBe(true);
        expect(replay(session.world, session.inputs(), ARCADE_LIBRARY, session.snapshot().tick).hash).toBe(hashArcade(session.state()));
      } finally { input.dispose(); releasePhysics(session.state()); }
    }
    expect(velocities[0]!.vx).toBeLessThan(0); expect(velocities[1]!.vx).toBeGreaterThan(0);
    expect(velocities[1]!.vz).toBeGreaterThan(velocities[0]!.vz);
    expect(velocities[1]!.z).toBeGreaterThan(velocities[0]!.z);
    expect(velocities[0]!.x).toBeLessThan(0); expect(velocities[1]!.x).toBeGreaterThan(0);
  });

  it('keyboard aim and space duration reach the same real charging and release path', () => {
    const session = game(), input = ballInput(session);
    try {
      input.key('arrowright', true); input.key(' ', true);
      for (let t = 0; t < 25; t++) session.stepOnce();
      input.key(' ', false); session.stepOnce();
      const b = bodyBase(session.state()[HEADER.spawnBase]!);
      expect(session.state()[b + BODY.vx]).toBeGreaterThan(0);
      expect(session.state()[b + BODY.vz]).toBe(200);
      expect(replay(session.world, session.inputs(), ARCADE_LIBRARY, session.snapshot().tick).hash).toBe(hashArcade(session.state()));
    } finally { input.dispose(); releasePhysics(session.state()); }
  });

  it('cancel clears charge without firing or allowing another finger to release', () => {
    const session = game(), input = ballInput(session);
    try {
      input.down(1, 0, 0); input.move(1, 30, 120);
      for (let t = 0; t < 20; t++) session.stepOnce();
      input.down(2, 20, 20); input.up(2);
      expect(session.inputs().some(event => event.buttons & BUTTON.TAP)).toBe(false);
      input.cancel(1); session.stepOnce();
      const p = bodyBase(session.state()[HEADER.player]!);
      expect(session.state()[p + BODY.aux1]).toBe(0);
      expect(session.state()[HEADER.counters + COUNTER.ammo]).toBe(3);
      input.down(3, 0, 0); input.move(3, 10, 15); session.stepOnce();
      expect(session.state()[p + BODY.aux1]).toBe(1);
    } finally { input.dispose(); releasePhysics(session.state()); }
  });
});

it.each([390 / 844, 16 / 9])('ball camera frames shooting origin and far hoop on aspect %f', aspect => {
  const camera = new PerspectiveCamera(50, aspect, 0.1, 300), look = new Vector3();
  placeBall(camera, look); camera.updateMatrixWorld();
  for (const point of [new Vector3(0, 1, 0), new Vector3(0, 3.5, 18)]) {
    const projected = point.project(camera);
    expect(Math.abs(projected.x)).toBeLessThan(0.95); expect(Math.abs(projected.y)).toBeLessThan(0.95);
  }
});
