/**
 * Ovladače → vstup hry (P65 T2): páčka = šipky, spoušť = mezerník, A/X a B/Y = akce, jako klávesnice
 * každé rodiny ovládání. Otočená osa nebo drift by v testu „hra reaguje“ prošly a hráč by je cítil.
 */

import { describe, expect, it } from 'vitest';

import { AXIS_MAX, BUTTON, COUNTER, HEADER } from '@/play/arcade/contract';
import { arenaAxis } from '@/play/arcade/pieces/arena';
import { CLOCK_COUNTER } from '@/play/arcade/pieces/merge-drop';
import { STAGES, type Stage } from '@/play/compose/stage-registry';

import { DEAD_ZONE, IDLE, type Pad, type XrControl, analog, createXrDriver, mapPad } from '../input-map';

const control = (input: Stage['input'], extra: Partial<XrControl> = {}): XrControl => ({ input, fire: false, attack: false, use: false, abilities: 0, ...extra });
const pad = (over: Partial<Pad>): Pad => ({ ...IDLE, ...over });
const LEFT = pad({ x: -1 });
const RIGHT = pad({ x: 1 });
const UP = pad({ y: 1 });
const DOWN = pad({ y: -1 });
const TRIGGER = pad({ trigger: true });

/** Jeden snímek z klidu. */
const from = (input: Stage['input'], now: Pad, extra: Partial<XrControl> = {}) => mapPad(control(input, extra), now, IDLE);

describe('each control family maps the stick and the trigger like its keyboard', () => {
  it('runner: stick sideways and down switch lane and slide, up and trigger jump', () => {
    expect(from('runner', LEFT).press).toBe(BUTTON.LEFT);
    expect(from('runner', RIGHT).press).toBe(BUTTON.RIGHT);
    expect(from('runner', DOWN).press).toBe(BUTTON.DOWN);
    expect(from('runner', UP).press).toBe(BUTTON.TAP);
    expect(from('runner', TRIGGER).press).toBe(BUTTON.TAP);
  });

  it('platform: stick holds the run axis, trigger jumps', () => {
    expect(from('platform', LEFT).axis).toBe(-AXIS_MAX);
    expect(from('platform', RIGHT).axis).toBe(AXIS_MAX);
    expect(from('platform', TRIGGER)).toMatchObject({ axis: 0, press: BUTTON.TAP });
  });

  it('flap and tap (timing, rhythm): up and trigger tap with axis 0', () => {
    for (const input of ['flap', 'tap'] as const) {
      expect(from(input, TRIGGER)).toMatchObject({ press: BUTTON.TAP, pressAxis: 0 });
      expect(from(input, UP).press).toBe(BUTTON.TAP);
      expect(from(input, LEFT).press).toBe(0);
    }
  });

  it('steer: stick leads the wheel smoothly, down brakes, trigger climbs or fires by mode', () => {
    expect(from('steer', RIGHT).axis).toBe(AXIS_MAX);
    expect(from('steer', LEFT).axis).toBe(-AXIS_MAX);
    expect(from('steer', pad({ x: 0.575 })).axis).toBe(500);
    expect(from('steer', DOWN).held).toBe(BUTTON.DOWN);
    expect(from('steer', TRIGGER, { drive: 'land' }).held).toBe(BUTTON.UP);
    expect(from('steer', TRIGGER, { drive: 'shoot' }).held).toBe(BUTTON.FIRE);
    expect(from('steer', TRIGGER, { drive: 'drive' }).held).toBe(0);
  });

  it('arena (move_free, fight, push): stick is the move direction, trigger taps, A fires', () => {
    expect(from('arena', RIGHT).axis).toBe(arenaAxis(AXIS_MAX, 0));
    expect(from('arena', UP).axis).toBe(arenaAxis(0, AXIS_MAX));
    expect(from('arena', RIGHT).axis).not.toBe(from('arena', LEFT).axis);
    expect(from('arena', TRIGGER).press).toBe(BUTTON.TAP);
    expect(from('arena', pad({ a: true })).press).toBe(BUTTON.FIRE);
  });

  it('shooter: stick holds left or right, trigger fires; with a ray aim it fires where the ray points', () => {
    expect(from('shooter-rig', LEFT).held).toBe(BUTTON.LEFT);
    expect(from('shooter-rig', RIGHT).held).toBe(BUTTON.RIGHT);
    expect(from('shooter-rig', TRIGGER).press).toBe(BUTTON.TAP);
    expect(mapPad(control('shooter-rig'), TRIGGER, IDLE, 300)).toMatchObject({ axis: 300, press: BUTTON.TAP, pressAxis: 300 });
  });

  it('throw: holding the trigger charges, releasing it throws, the stick tilts the angle', () => {
    expect(from('throw-rig', TRIGGER)).toMatchObject({ held: BUTTON.HOLD, press: 0 });
    expect(mapPad(control('throw-rig'), IDLE, TRIGGER)).toMatchObject({ held: 0, press: BUTTON.TAP, pressAxis: 0 });
    expect(from('throw-rig', UP).held).toBe(BUTTON.UP);
    expect(from('throw-rig', DOWN).held).toBe(BUTTON.DOWN);
  });

  it('duel: trigger strikes, stick down and A dodge', () => {
    expect(from('duel', TRIGGER).press).toBe(BUTTON.TAP);
    expect(from('duel', DOWN).press).toBe(BUTTON.DOWN);
    expect(from('duel', pad({ a: true })).press).toBe(BUTTON.DOWN);
  });

  it('lanes (lanes, crowd, catch, whack, defense, slice): stick steps a lane, trigger taps and holds', () => {
    expect(from('lanes', LEFT).press).toBe(BUTTON.LEFT);
    expect(from('lanes', RIGHT).press).toBe(BUTTON.RIGHT);
    expect(from('lanes', TRIGGER)).toMatchObject({ press: BUTTON.TAP, held: BUTTON.HOLD });
    expect(mapPad(control('lanes'), TRIGGER, IDLE, -600)).toMatchObject({ press: BUTTON.TAP, pressAxis: -600, axis: -600, held: BUTTON.HOLD });
  });

  it('hop: the stick hops in all four directions, trigger taps', () => {
    expect(from('hop', UP).press).toBe(BUTTON.UP);
    expect(from('hop', DOWN).press).toBe(BUTTON.DOWN);
    expect(from('hop', LEFT).press).toBe(BUTTON.LEFT);
    expect(from('hop', RIGHT).press).toBe(BUTTON.RIGHT);
    expect(from('hop', TRIGGER).press).toBe(BUTTON.TAP);
  });

  it('merge: stick moves the dropper target, trigger queues a drop', () => {
    expect(from('merge', LEFT).axis).toBe(-AXIS_MAX);
    expect(from('merge', RIGHT).axis).toBe(AXIS_MAX);
    expect(from('merge', TRIGGER)).toMatchObject({ drop: true, press: 0 });
  });

  it('glide and walker: stick sideways steers, up and down climb', () => {
    expect(from('glide', RIGHT).axis).toBe(AXIS_MAX);
    expect(from('glide', UP).held).toBe(BUTTON.UP);
    expect(from('glide', TRIGGER, { glideShoots: true }).held).toBe(BUTTON.FIRE);
    expect(from('walker', LEFT).axis).toBe(-AXIS_MAX);
    expect(from('walker', DOWN).held).toBe(BUTTON.DOWN);
  });

  it('every control kind the stage registry knows answers the stick or the trigger', () => {
    for (const [kind, stage] of Object.entries(STAGES)) {
      const moved = [LEFT, RIGHT, UP, DOWN, TRIGGER].some((now) => {
        const step = from(stage.input, now);
        return step.axis !== 0 || step.held !== 0 || step.press !== 0 || step.drop;
      });
      expect(moved, kind).toBe(true);
    }
  });
});

describe('actions shared by every family', () => {
  it('abilities take A and B, a blaster takes B, a fight takes A, interact takes the grip', () => {
    expect(from('runner', pad({ a: true }), { abilities: 2 }).press).toBe(BUTTON.ACTION_A);
    expect(from('runner', pad({ b: true }), { abilities: 2 }).press).toBe(BUTTON.ACTION_B);
    expect(from('arena', pad({ b: true }), { fire: true }).press).toBe(BUTTON.FIRE);
    expect(from('arena', pad({ a: true }), { attack: true }).press).toBe(BUTTON.ATTACK);
    expect(from('arena', pad({ grip: true }), { use: true }).held).toBe(BUTTON.INTERACT);
    expect(from('arena', pad({ grip: true })).held).toBe(0);
  });
});

describe('stick drift and edges', () => {
  it('drift under the dead zone is no movement, analog or as an arrow', () => {
    expect(analog(DEAD_ZONE - 0.01)).toBe(0);
    expect(analog(-(DEAD_ZONE - 0.01))).toBe(0);
    expect(analog(DEAD_ZONE + 0.1)).toBeGreaterThan(0);
    for (const input of ['steer', 'arena', 'platform', 'runner'] as const) {
      expect(from(input, pad({ x: 0.14, y: -0.14 }))).toMatchObject({ axis: 0, held: 0, press: 0 });
    }
  });

  it('a light push is not an arrow press: a lane needs half the stick', () => {
    expect(from('runner', pad({ x: -0.3 })).press).toBe(0);
    expect(from('runner', pad({ x: -0.6 })).press).toBe(BUTTON.LEFT);
  });

  it('a held trigger or stick presses once, on the edge', () => {
    expect(mapPad(control('runner'), TRIGGER, TRIGGER).press).toBe(0);
    expect(mapPad(control('runner'), LEFT, LEFT).press).toBe(0);
  });
});

describe('driver', () => {
  const recorder = () => {
    const calls: string[] = [];
    const state = new Int32Array(64);
    return {
      calls,
      session: {
        press: (buttons: number, axis = 0) => calls.push(`press ${buttons} ${axis}`),
        hold: (axis: number) => calls.push(`hold ${axis}`),
        holdButtons: (buttons: number) => calls.push(`holdButtons ${buttons}`),
        state: () => state,
      },
    };
  };

  it('sends the axis and held buttons only when they change, and presses at once', () => {
    const { calls, session } = recorder();
    const driver = createXrDriver(session, control('steer', { drive: 'land' }));
    driver.frame(pad({ x: 1, trigger: true }));
    driver.frame(pad({ x: 1, trigger: true }));
    expect(calls).toEqual([`hold ${AXIS_MAX}`, `holdButtons ${BUTTON.UP}`]);
  });

  it('a disconnected controller releases everything and throws nothing', () => {
    const { calls, session } = recorder();
    const driver = createXrDriver(session, control('throw-rig'));
    driver.frame(pad({ trigger: true, y: 1 }));
    calls.length = 0;
    expect(() => driver.frame(null)).not.toThrow();
    expect(calls).toEqual([`holdButtons 0`, `press ${BUTTON.TAP} 0`]);
    calls.length = 0;
    driver.frame(null);
    expect(calls).toEqual([]);
  });

  it('merge drops only when the item is ready (clock 0), like the key', () => {
    const { calls, session } = recorder();
    const clock = HEADER.counters + COUNTER[CLOCK_COUNTER];
    session.state()[clock] = 5;
    const driver = createXrDriver(session, control('merge'));
    driver.frame(TRIGGER);
    driver.frame(IDLE);
    expect(calls).toEqual([]);
    session.state()[clock] = 0;
    driver.frame(IDLE);
    expect(calls).toEqual([`press ${BUTTON.TAP} 0`]);
    driver.frame(IDLE);
    expect(calls).toHaveLength(1);
  });
});
