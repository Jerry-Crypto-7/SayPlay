/**
 * Pohyb ruky → vstup hry (P65 T3): hod máchnutím, švih krájení, úder do díry a míření paprskem. Hod, který letí
 * vždy rovně, nebo švih, který sekne dvakrát, by v testu „hod proběhl“ prošly – tady se drží směr, síla a hrana.
 */

import { describe, expect, it } from 'vitest';

import { AXIS_MAX, BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { axisOfLane, laneX } from '@/play/arcade/pieces/lanes';
import { SHOOTER, aimAt } from '@/play/arcade/pieces/shooter';
import { THROW } from '@/play/arcade/pieces/throw';
import type { Stage } from '@/play/compose/stage-registry';

import { IDLE, type Pad, SWING, type XrControl, type XrMotion, aimOfPoint, createSwing, createXrDriver, throwOf } from '../input-map';

const control = (input: Stage['input'], extra: Partial<XrControl> = {}): XrControl => ({ input, fire: false, attack: false, use: false, abilities: 0, ...extra });
const deg = (angle: number) => (angle * Math.PI) / 180;
/** Ruka letí rychlostí `speed` m/s pod úhlem `angle` nad vodorovnou rovinou, dopředu. */
const swing = (speed: number, angle: number) => ({ vy: speed * Math.sin(deg(angle)), vz: speed * Math.cos(deg(angle)) });
const throwAt = (speed: number, angle: number) => {
  const { vy, vz } = swing(speed, angle);
  return throwOf(vy, vz);
};

describe('throwOf: hand speed and direction at release → throw force and angle', () => {
  it('no swing, a swing under the threshold and a backward swing throw nothing', () => {
    expect(throwOf(0, 0)).toBeNull();
    expect(throwAt(SWING.throwMin * 0.9, 45)).toBeNull();
    expect(throwOf(2, -3)).toBeNull();
    expect(throwOf(3, 0)).toBeNull();
  });

  it('the force grows with speed from one tick of charge to full and is clipped above the top speed', () => {
    expect(throwAt(SWING.throwMin * 1.001, 30)?.charge).toBe(1);
    expect(throwAt(SWING.throwMax, 30)?.charge).toBe(THROW.maxCharge);
    expect(throwAt(SWING.throwMax * 3, 30)?.charge).toBe(THROW.maxCharge);
    const middle = throwAt((SWING.throwMin + SWING.throwMax) / 2, 30)?.charge ?? 0;
    expect(middle).toBeGreaterThan(THROW.maxCharge * 0.4);
    expect(middle).toBeLessThan(THROW.maxCharge * 0.6);
    const slow = throwAt(2, 30)?.charge ?? 0;
    const fast = throwAt(4, 30)?.charge ?? 0;
    expect(fast).toBeGreaterThan(slow);
  });

  it('the angle follows the hand: steep swings lob, flat swings fly low, both clipped to the throw range', () => {
    // Úhel hodu: osa 0 = 45°, ±1000 = ±40°; 45° je 1, protože osa 0 znamená „beze změny“.
    expect(throwAt(3, 45)?.aim).toBe(1);
    expect(throwAt(3, 75)?.aim).toBe(750);
    expect(throwAt(3, 15)?.aim).toBe(-750);
    expect(throwAt(3, 89)?.aim).toBe(AXIS_MAX);
    expect(throwAt(3, 2)?.aim).toBe(-AXIS_MAX);
    expect(throwAt(3, -20)?.aim).toBe(-AXIS_MAX);
  });

  it('force and angle are independent: the same speed at two angles has one charge', () => {
    expect(throwAt(3.5, 20)?.charge).toBe(throwAt(3.5, 70)?.charge);
    expect(throwAt(2, 60)?.aim).toBe(throwAt(5, 60)?.aim);
  });
});

describe('createSwing: one cut per swing over the threshold', () => {
  it('fires once when the speed crosses the threshold and again only after the hand slows down', () => {
    const swung = createSwing(2);
    expect(swung(0)).toBe(false);
    expect(swung(1.9)).toBe(false);
    expect(swung(2)).toBe(true);
    expect(swung(3)).toBe(false);
    expect(swung(1.5)).toBe(false);
    // Nad polovinou prahu se nenabije: chvění ruky na vrcholu švihu nesekne podruhé.
    expect(swung(2.5)).toBe(false);
    expect(swung(0.9)).toBe(false);
    expect(swung(2.1)).toBe(true);
  });
});

/** Relace, která drží nabití hodu v těle hráče jako jádro (`aux1`) a zapisuje volání. */
function fakeSession() {
  const state = new Int32Array(1 << 14);
  state[HEADER.player] = 0;
  const charge = bodyBase(0) + BODY.aux1;
  const calls = { press: [] as [number, number][], held: 0, axis: 0 };
  return {
    calls,
    /** Jeden tik jádra: držené nabíjení přidá tik nabití, ťuk ho spotřebuje. */
    tick() {
      if ((calls.held & BUTTON.HOLD) !== 0) state[charge] = Math.min(THROW.maxCharge, (state[charge] as number) + 1);
      if (calls.press.some(([buttons]) => (buttons & BUTTON.TAP) !== 0)) state[charge] = 0;
    },
    charge: () => state[charge] as number,
    session: {
      press: (buttons: number, axis = 0) => void calls.press.push([buttons, axis]),
      hold: (axis: number) => void (calls.axis = axis),
      holdButtons: (buttons: number) => void (calls.held = buttons),
      state: () => state,
    },
  };
}

const TRIGGER: Pad = { ...IDLE, trigger: true };
const moving = (velocity: XrMotion['velocity'], laneAxis: number | null = null): XrMotion => ({ aim: null, velocity, laneAxis });

describe('the driver throws with the swing: charge up to the swing force, release throws at its angle', () => {
  it('holds the charge while the trigger swings, throws on release once the charge matches the swing', () => {
    const fake = fakeSession();
    const driver = createXrDriver(fake.session, control('throw-rig'));
    const { vy, vz } = swing(3, 60);
    const wanted = throwOf(vy, vz)!;
    driver.frame(TRIGGER, moving({ x: 0, y: vy, z: vz }));
    expect(fake.calls.held & BUTTON.HOLD).toBe(BUTTON.HOLD);
    // Spoušť puštěná dřív, než se nabilo: nabíjí se dál, hod letí až s plnou silou švihu.
    driver.frame(IDLE, moving({ x: 0, y: 0, z: 0 }));
    let frames = 0;
    while (fake.calls.press.length === 0 && frames < 2 * THROW.maxCharge) {
      fake.tick();
      driver.frame(IDLE, moving({ x: 0, y: 0, z: 0 }));
      frames += 1;
    }
    expect(fake.calls.press).toEqual([[BUTTON.TAP, wanted.aim]]);
    expect(fake.charge()).toBe(wanted.charge);
    expect(fake.calls.held & BUTTON.HOLD).toBe(0);
  });

  it('a stronger swing charges longer than a weaker one', () => {
    const ticksFor = (speed: number): number => {
      const fake = fakeSession();
      const driver = createXrDriver(fake.session, control('throw-rig'));
      const { vy, vz } = swing(speed, 40);
      driver.frame(TRIGGER, moving({ x: 0, y: vy, z: vz }));
      driver.frame(IDLE, moving({ x: 0, y: 0, z: 0 }));
      let ticks = 0;
      while (fake.calls.press.length === 0 && ticks < 2 * THROW.maxCharge) {
        fake.tick();
        driver.frame(IDLE, moving({ x: 0, y: 0, z: 0 }));
        ticks += 1;
      }
      return ticks;
    };
    expect(ticksFor(5)).toBeGreaterThan(ticksFor(2));
  });

  it('pressing and releasing the trigger without a swing neither charges nor throws', () => {
    const fake = fakeSession();
    const driver = createXrDriver(fake.session, control('throw-rig'));
    driver.frame(TRIGGER, moving({ x: 0, y: 0, z: 0 }));
    fake.tick();
    driver.frame(IDLE, moving({ x: 0, y: 0, z: 0 }));
    fake.tick();
    expect(fake.calls.held & BUTTON.HOLD).toBe(0);
    expect(fake.calls.press).toEqual([]);
    expect(fake.charge()).toBe(0);
  });
});

describe('the driver cuts and whacks in the lane under the hand', () => {
  const lane3 = axisOfLane(3);

  it('slice: a fast swing in any direction cuts once in the lane under the hand', () => {
    const fake = fakeSession();
    const driver = createXrDriver(fake.session, control('lanes', { swing: 'slice' }));
    driver.frame(IDLE, moving({ x: 0, y: 0, z: 0 }, lane3));
    driver.frame(IDLE, moving({ x: SWING.slice + 1, y: 0, z: 0 }, lane3));
    driver.frame(IDLE, moving({ x: SWING.slice + 1, y: 0.5, z: 0 }, lane3));
    expect(fake.calls.press).toEqual([[BUTTON.TAP, lane3]]);
  });

  it('whack: only a downward strike hits; an upward or sideways swing of the same speed does not', () => {
    const fake = fakeSession();
    const driver = createXrDriver(fake.session, control('lanes', { swing: 'whack' }));
    driver.frame(IDLE, moving({ x: 0, y: SWING.whack + 1, z: 0 }, lane3));
    driver.frame(IDLE, moving({ x: SWING.whack + 1, y: 0, z: 0 }, lane3));
    expect(fake.calls.press).toEqual([]);
    driver.frame(IDLE, moving({ x: 0, y: -(SWING.whack + 1), z: 0 }, lane3));
    expect(fake.calls.press).toEqual([[BUTTON.TAP, lane3]]);
  });

  it('lanes without a swing rule ignore the hand speed', () => {
    const fake = fakeSession();
    const driver = createXrDriver(fake.session, control('lanes'));
    driver.frame(IDLE, moving({ x: 0, y: -10, z: 0 }, lane3));
    expect(fake.calls.press).toEqual([]);
  });
});

describe('aimOfPoint: the ray hit → the same aim a finger gives', () => {
  const state = new Int32Array(1 << 14);
  state[HEADER.player] = 0;
  state[bodyBase(0) + BODY.x] = 500;
  state[bodyBase(0) + BODY.z] = 1000;
  const muzzleZ = 1000 + SHOOTER.playerD / 2;

  it('shooter: a point ahead aims from the muzzle, a point behind it gives no aim', () => {
    expect(aimOfPoint('shooter-rig', 2500, muzzleZ + 4000, state)).toBe(aimAt(2000, 4000));
    expect(aimOfPoint('shooter-rig', 2500, muzzleZ - 10, state)).toBeNull();
  });

  it('lanes: a point picks the lane it lies in, edge lanes take everything beyond', () => {
    expect(aimOfPoint('lanes', laneX(1), 2400, state)).toBe(axisOfLane(1));
    expect(aimOfPoint('lanes', laneX(4) + 9000, 2400, state)).toBe(axisOfLane(4));
  });

  it('other families have no aim', () => {
    expect(aimOfPoint('runner', 0, 5000, state)).toBeNull();
  });
});
