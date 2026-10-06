import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { buildWorld, hashArcade, instantiate, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { walkerMaze, walkerParamsSchema, walkerStealth } from '@/play/arcade/pieces/walker';
import { createArcadeSession, TICK_MS } from '../../session';
import { walkerInput } from '../walker-input';
import { placeWalker, walkerCone } from '../view';

vi.mock('@/play/arcade/library', async importOriginal => {
  const original = await importOriginal<typeof import('@/play/arcade/library')>();
  const { walkerControl, walkerCaught } = await import('@/play/arcade/pieces/walker');
  const { walkerBot } = await import('@/play/arcade/pieces/walker-bot');
  return { ...original, ARCADE_LIBRARY: {
    ...original.ARCADE_LIBRARY,
    controls: { ...original.ARCADE_LIBRARY.controls, walker: walkerControl },
    rules: { ...original.ARCADE_LIBRARY.rules, walker_caught: walkerCaught },
    bots: { ...original.ARCADE_LIBRARY.bots, walker_bot: walkerBot },
  } };
});

function built() {
  const parts = walkerStealth.parts(1, walkerParamsSchema.parse({}), undefined);
  const made = buildWorld({ seed: 1, ...parts }, ARCADE_LIBRARY);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return { world: made.world, guard: parts.level.bodies.length - 1 };
}

describe('walker input and native session', () => {
  it.each(['keys', 'touch'] as const)('%s moves along both axes and keeps the recorded replay hash', source => {
    const { world } = built(), session = createArcadeSession(world), input = walkerInput();
    const p = bodyBase(session.state()[HEADER.player]!);
    const startX = session.state()[p + BODY.x]!, startZ = session.state()[p + BODY.z]!;
    if (source === 'keys') { input.key('d', true); input.key('w', true); }
    else { input.down(1, 100, 100); input.move(1, 140, 60); }
    for (let tick = 0; tick < 10; tick++) {
      const held = input.snapshot(); session.hold(held.axis); session.holdButtons(held.buttons); session.advance(TICK_MS);
    }
    expect(session.state()[p + BODY.x]!).toBeGreaterThan(startX);
    expect(session.state()[p + BODY.z]!).toBeGreaterThan(startZ);
    expect(session.inputs().every(event => event.axis > 0 && (event.buttons & BUTTON.UP) !== 0)).toBe(true);
    expect(replay(world, session.inputs(), ARCADE_LIBRARY, session.snapshot().tick).hash).toBe(hashArcade(session.state()));
  });

  it('emits all eight directions through arrows and through the touch stick', () => {
    const keys = [['arrowleft'], ['arrowright'], ['arrowup'], ['arrowdown'], ['arrowleft', 'arrowup'], ['arrowleft', 'arrowdown'], ['arrowright', 'arrowup'], ['arrowright', 'arrowdown']];
    const vectors = [[-40, 0], [40, 0], [0, -40], [0, 40], [-40, -40], [-40, 40], [40, -40], [40, 40]];
    const signatures: string[] = [];
    keys.forEach((combo, index) => {
      const key = walkerInput(), touch = walkerInput();
      for (const name of combo) key.key(name, true);
      touch.down(1, 100, 100); touch.move(1, 100 + vectors[index]![0]!, 100 + vectors[index]![1]!);
      expect(touch.snapshot()).toEqual(key.snapshot());
      signatures.push(JSON.stringify(key.snapshot()));
    });
    expect(new Set(signatures).size).toBe(8);
  });

  it('ignores an unrelated finger release and clears actual ownership on cancellation', () => {
    const input = walkerInput();
    input.down(1, 100, 100); input.move(1, 140, 100); input.down(2, 200, 200); input.up(2);
    expect(input.snapshot().axis).toBe(1000);
    input.up(1); expect(input.snapshot()).toEqual({ axis: 0, buttons: 0 });
    input.key('w', true); input.clear(); expect(input.snapshot().buttons).toBe(0);
  });
});

describe('walker scene follows real geometry', () => {
  it.each([390 / 844, 16 / 9])('frames the hero with top-down movement at aspect %f', aspect => {
    const camera = new PerspectiveCamera(50, aspect, 0.1, 200), look = new Vector3();
    placeWalker(camera, look, -20, 24); camera.updateMatrixWorld();
    const hero = new Vector3(-20, 0.6, 24).project(camera);
    expect(Math.abs(hero.x)).toBeLessThan(0.7); expect(Math.abs(hero.y)).toBeLessThan(0.7);
    expect(hero.z).toBeGreaterThan(-1); expect(hero.z).toBeLessThan(1);
    // Runtime +x is rendered -x and appears to the right of the player.
    expect(new Vector3(-21, 0.6, 24).project(camera).x).toBeGreaterThan(hero.x);
    expect(new Vector3(-20, 0.6, 25).project(camera).y).toBeGreaterThan(hero.y);
  });

  it('draws only the guard forward cone with its real range and clips against walls', () => {
    const { world, guard } = built(), state = instantiate(world), map = walkerMaze(1, 11), base = bodyBase(guard);
    state[base + BODY.x] = 4000; state[base + BODY.z] = 0; state[base + BODY.vz] = 40;
    const forward = walkerCone(state, guard, map, 5000);
    expect(forward.length).toBe(24 * 9);
    const points = Array.from({ length: forward.length / 3 }, (_, index) => ({ x: forward[index * 3]!, z: forward[index * 3 + 2]! }));
    expect(points.every(point => point.z >= 0 && Math.hypot(point.x + 4, point.z) <= 5.001)).toBe(true);
    expect(points.some(point => point.z > 4)).toBe(true);
    state[base + BODY.vz] = -40;
    const backward = walkerCone(state, guard, map, 5000);
    expect(Array.from({ length: backward.length / 3 }, (_, index) => backward[index * 3 + 2]!).every(z => z <= 0)).toBe(true);
    state[base + BODY.vz] = 40;
    const blocked = walkerCone(state, guard, { ...map, open: map.open.filter(cell => cell !== 1) }, 5000);
    expect(Array.from({ length: blocked.length / 3 }, (_, index) => blocked[index * 3 + 2]!).every(z => z === 0)).toBe(true);
  });
});
