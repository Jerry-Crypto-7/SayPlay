import { describe, expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BUTTON } from '@/play/arcade/contract';
import { hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { driveSpec } from '@/play/compose/drive';
import { createArcadeSession, TICK_MS } from '../../session';
import { driveInput } from '../drive-input';
import { keySteer } from '../key-steer';

function driven() {
  const made = arcadeWorldOf(driveSpec({ move: 'drive', actions: ['shoot'], objective: 'race', threats: ['rival'] },
    { genre: 'voyage', mode: 'race', hero: 'car', setting: 'city' }), 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const session = createArcadeSession(made.world);
  const input = driveInput('shoot');
  const sync = () => {
    const held = input.snapshot(wheel.axis());
    session.hold(held.axis);
    session.holdButtons(held.buttons);
  };
  const wheel = keySteer(session, sync);
  const tick = () => { sync(); session.advance(TICK_MS); };
  const key = (name: string, down: boolean) => { input.key(name, down); wheel.aim(input.keyAxis()); sync(); };
  return { session, input, wheel, tick, key };
}

describe('simultaneous native drive input', () => {
  it.each([1, 2])('releasing or cancelling pointer %i leaves the other action intact', released => {
    const { session, input, wheel, tick } = driven();
    input.down(1, 100);
    input.move(1, 130);
    input.down(2, 250);
    for (let count = 0; count < 20; count++) tick();
    expect(session.inputs().every(event => event.axis > 0 && (event.buttons & BUTTON.FIRE) !== 0)).toBe(true);
    expect(session.inputs().every(event => (event.buttons & BUTTON.DOWN) === 0)).toBe(true);
    input.up(released);
    tick();
    const last = session.inputs().at(-1)!;
    expect(last.axis > 0).toBe(released === 2);
    expect((last.buttons & BUTTON.FIRE) !== 0).toBe(released === 1);
    // Both pointerup and pointercancel enter the same helper up operation.
    input.up(released === 1 ? 2 : 1);
    tick();
    expect(input.snapshot()).toEqual({ axis: 0, buttons: 0 });
    expect(replay(session.world, session.inputs(), ARCADE_LIBRARY, session.snapshot().tick).hash).toBe(hashArcade(session.state()));
    wheel.dispose();
  });

  it('records arrow steering and held Space together; discrete F/J/Enter fire remains independent', () => {
    const { session, input, wheel, tick, key } = driven();
    key('arrowright', true);
    key(' ', true);
    for (let count = 0; count < 10; count++) tick();
    expect(session.inputs().every(event => event.axis > 0 && (event.buttons & BUTTON.FIRE) !== 0)).toBe(true);
    key(' ', false);
    // useFireInput calls press; holdButtons must not overwrite pending fire.
    session.press(BUTTON.FIRE);
    tick();
    expect(session.inputs().at(-1)!.buttons & BUTTON.FIRE).toBe(BUTTON.FIRE);
    expect(input.key('f', true)).toBe(false);
    expect(replay(session.world, session.inputs(), ARCADE_LIBRARY, session.snapshot().tick).hash).toBe(hashArcade(session.state()));
    wheel.dispose();
  });

  it.each(['drive', 'land'] as const)('preserves the legacy second-finger %s action', mode => {
    const input = driveInput(mode);
    input.down(1, 10);
    input.move(1, 40);
    input.down(2, 100);
    expect(input.snapshot()).toEqual({ axis: 333, buttons: mode === 'land' ? BUTTON.UP : BUTTON.DOWN });
    input.up(1);
    expect(input.snapshot().buttons).toBe(0);
    if (mode === 'land') {
      input.key(' ', true);
      expect(input.snapshot().buttons).toBe(BUTTON.UP);
    }
  });

  it('keeps keyboard and touch fire independent, clears blur state and preserves Down/S braking', () => {
    const input = driveInput('shoot');
    input.down(1, 10); input.down(2, 100);
    input.key(' ', true); input.up(2);
    expect(input.snapshot().buttons).toBe(BUTTON.FIRE);
    input.key('s', true);
    expect(input.snapshot().buttons).toBe(BUTTON.FIRE | BUTTON.DOWN);
    input.clear();
    expect(input.snapshot()).toEqual({ axis: 0, buttons: 0 });
  });
});
