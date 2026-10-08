import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import runner from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BODY, COUNTER, FLAG, HEADER, ROLE, bodyBase, setTargetState } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { readGameSpec } from '@/play/spec';
import { createArcadeSession, TICK_MS } from '../../session';
import { HeroActionBody } from '../HeroActionBody';
import { BURST_S, actionAdvanced } from '../actions';

const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], effects: [] as (() => unknown)[], frame: null as null | ((_: unknown, delta: number) => void) }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => { const ref = { current }; hooks.refs.push(ref); return ref; },
  useEffect: (effect: () => unknown) => hooks.effects.push(effect),
}));
vi.mock('@react-three/fiber', () => ({ useFrame: (frame: typeof hooks.frame) => { hooks.frame = frame; } }));
vi.mock('@/play/audio', () => ({ playHeroActionSfx: vi.fn() }));

function world() {
  const spec = readGameSpec(runner);
  if (!spec.ok) throw new Error('fixture');
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error('world');
  return built.world;
}
function mount(session: Parameters<typeof HeroActionBody>[0]['session']) {
  HeroActionBody({ action: 'sweep', session, h: 1, children: null });
  hooks.refs[0].current = new Group();
  hooks.refs[1].current = new Group();
  hooks.effects.forEach(effect => effect());
  return hooks.refs.find(ref => ref.current !== null && typeof ref.current === 'object' && 'burstAt' in ref.current)!.current as { t: number; burstAt: number };
}
beforeEach(() => { hooks.refs = []; hooks.effects = []; hooks.frame = null; });

describe('state-driven hero swing', () => {
  it('ignores damage, motion and rewind, but catches score/items across skipped frames', () => {
    const before = Int32Array.from(world().initial);
    before[HEADER.tick] = 60;
    const after = before.slice();
    after[HEADER.tick] = 66;
    after[HEADER.counters + COUNTER.health]--;
    after[bodyBase(0) + BODY.x]++;
    expect(actionAdvanced(before, after)).toBe(false);
    after[HEADER.counters + COUNTER.items]++;
    expect(actionAdvanced(before, after)).toBe(true);
    after[HEADER.counters + COUNTER.items]--;
    after[HEADER.counters + COUNTER.score]++;
    expect(actionAdvanced(before, after)).toBe(true);
    after[HEADER.tick] = 0;
    expect(actionAdvanced(before, after)).toBe(false);
  });

  it('reacts to a robot collection on the next frame without changing its replay hash', () => {
    const made = world();
    const session = createArcadeSession(made);
    const control = createArcadeSession(made);
    const events = vi.fn();
    session.onEvents(events);
    session.startDemo(); control.startDemo();
    const clock = mount(session);
    hooks.frame!(null, 1 / 60);
    let collections = 0;
    let lastCollectionSwing = -Infinity;
    for (let frame = 0; frame < 2000 && session.snapshot().runState === 'running'; frame++) {
      const score = session.state()[HEADER.counters + COUNTER.score];
      session.advance(TICK_MS); control.advance(TICK_MS);
      hooks.frame!(null, 1 / 60);
      expect(hashArcade(session.state())).toBe(hashArcade(control.state()));
      if (session.state()[HEADER.counters + COUNTER.score] > score) {
        collections++;
        // An active swing finishes instead of restarting on every scoring tick.
        if (clock.t - lastCollectionSwing >= BURST_S) {
          expect(clock.t - clock.burstAt).toBeLessThanOrEqual(0.2);
          lastCollectionSwing = clock.burstAt;
        } else expect(clock.t - clock.burstAt).toBeLessThanOrEqual(BURST_S);
      }
    }
    expect(collections).toBeGreaterThan(0);
    expect(events).not.toHaveBeenCalled();
  });

  it.each(['target', 'enemy', 'collectible'] as const)('observes %s changes even without a score or event', kind => {
    const state = Int32Array.from(world().initial);
    state[HEADER.bodyCount] = 1;
    const base = bodyBase(0);
    state[base + BODY.role] = ROLE[kind];
    state[base + BODY.flags] = FLAG.alive;
    const clock = mount({ state: () => state, onEvents: () => () => undefined });
    for (let tick = 1; tick <= 60; tick++) { state[HEADER.tick] = tick; hooks.frame!(null, 1 / 60); }
    state[HEADER.tick]++;
    if (kind === 'target') setTargetState(state, 0, 1);
    else state[base + BODY.flags] &= ~FLAG.alive;
    const before = hashArcade(state);
    hooks.frame!(null, 1 / 60);
    expect(clock.burstAt).toBe(clock.t);
    expect(hashArcade(state)).toBe(before);
    const start = clock.burstAt;
    for (let frame = 0; frame < 10; frame++) hooks.frame!(null, 1 / 60);
    expect(clock.burstAt).toBe(start);
  });
});
