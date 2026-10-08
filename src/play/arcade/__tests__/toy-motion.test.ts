import { describe, expect, it } from 'vitest';

import { ARCADE_HZ, BODY, BODY_STRIDE, COUNTER, FLAG, HEADER, HEADER_SIZE, ROLE, RUN_STATE, TARGET_STATE_SHIFT, UNIT, bodyBase } from '../contract';
import { type BodyClass, type ToyPose, type ToyView, BODY_CLASSES, toyPoseOf, toyViewOf } from '../toy-motion';

/** Rychlost v m/s → jednotky za tik (60 Hz). */
const perTick = (metresPerSecond: number): number => Math.round((metresPerSecond * UNIT) / ARCADE_HZ);

const view = (over: Partial<ToyView> = {}): ToyView => ({
  vx: 0, vy: 0, vz: 0, grounded: true, alive: true, hit: false, shot: false,
  won: false, carrying: false, attack: false, turn: 0, opened: false, ...over,
});

/** Pózy pohledů po tiku od `from`, každá s pamětí předchozí. */
function run(views: readonly ToyView[], body: BodyClass = 'biped', reduced = false, from = 0): ToyPose[] {
  const poses: ToyPose[] = [];
  let previous: ToyPose | null = null;
  views.forEach((v, i) => {
    previous = toyPoseOf(v, body, previous, from + i, reduced);
    poses.push(previous);
  });
  return poses;
}

const repeat = (count: number, v: ToyView): ToyView[] => Array.from({ length: count }, () => v);
const walking = (count: number, metresPerSecond = 4): ToyView[] => repeat(count, view({ vz: perTick(metresPerSecond) }));
const seconds = (s: number): number => Math.round(s * ARCADE_HZ);

/** Amplitudy pózy – co se kreslí; paměť (časy událostí, ujetá dráha) sem nepatří. */
const AMPLITUDES = ['hop', 'roll', 'pitch', 'yaw', 'squash', 'lunge', 'recoil', 'wobble', 'fall', 'cheer', 'flash', 'flap', 'wheel', 'sway', 'stride', 'open'] as const;
const amplitudes = (pose: ToyPose): Record<string, number> => Object.fromEntries(AMPLITUDES.map((key) => [key, pose[key]]));
const ZERO = Object.fromEntries(AMPLITUDES.map((key) => [key, 0]));
const max = (poses: readonly ToyPose[], key: (typeof AMPLITUDES)[number]): number => Math.max(...poses.map((pose) => Math.abs(pose[key])));

describe('toyPoseOf – hračkový pohyb z pohledu těla a třídy těla', () => {
  it('stejné tiky dají stejnou pózu', () => {
    const views = [...walking(40), view({ grounded: false, vy: perTick(5) }), ...repeat(10, view()), view({ hit: true }), ...repeat(20, view())];
    for (const body of BODY_CLASSES) expect(run(views, body)).toEqual(run(views, body));
  });

  it('stojící tělo bez události je v klidu – žádná klidová smyčka', () => {
    for (const body of BODY_CLASSES) {
      for (const pose of run(repeat(seconds(3), view()), body)) expect(amplitudes(pose)).toEqual(ZERO);
    }
  });

  it('tělo, které zastaví, přestane poskakovat i kolébat', () => {
    const poses = run([...walking(60), ...repeat(5, view())], 'biped');
    expect(max(poses.slice(0, 60), 'hop')).toBeGreaterThan(0.02);
    expect(poses.at(-1)).toMatchObject({ hop: 0, roll: 0, stride: 0 });
  });

  it('biped poskakuje a kolébá se, náklon mění znaménko krok od kroku', () => {
    const poses = run(walking(seconds(2)), 'biped');
    expect(max(poses, 'hop')).toBeGreaterThan(0.03);
    expect(Math.max(...poses.map((pose) => pose.roll))).toBeGreaterThan(0.05);
    expect(Math.min(...poses.map((pose) => pose.roll))).toBeLessThan(-0.05);
  });

  it('quadruped se houpe dopředu a dozadu', () => {
    const poses = run(walking(seconds(2)), 'quadruped');
    const swing = poses.map((pose) => pose.pitch - poses[0]!.pitch);
    expect(Math.max(...swing)).toBeGreaterThan(0.04);
    expect(Math.min(...swing)).toBeLessThan(-0.04);
  });

  it('vozidlo nikdy neposkakuje, točí kola podle ujeté dráhy a pruží', () => {
    const poses = run([...walking(seconds(2), 6), view({ grounded: false, vy: perTick(6) }), ...repeat(10, view()), view({ won: true }), ...repeat(seconds(1), view({ won: true }))], 'vehicle');
    expect(max(poses, 'hop')).toBe(0);
    expect(max(poses.slice(0, seconds(2)), 'squash')).toBeGreaterThan(0);
    const slow = run(walking(seconds(1), 3), 'vehicle').at(-1)!;
    const fast = run(walking(seconds(1), 6), 'vehicle').at(-1)!;
    expect(fast.travel).toBeGreaterThan(slow.travel * 1.9);
    expect(max(run(walking(seconds(1), 3), 'vehicle'), 'wheel')).toBeGreaterThan(0);
  });

  it('létavec mává podle rychlosti a neposkakuje, plavec se vlní', () => {
    const flyer = run(walking(seconds(1), 5), 'flyer');
    expect(max(flyer, 'hop')).toBe(0);
    expect(max(flyer, 'flap')).toBeGreaterThan(0.5);
    const swimmer = run(walking(seconds(1), 3), 'swimmer');
    expect(max(swimmer, 'hop')).toBe(0);
    expect(max(swimmer, 'sway')).toBeGreaterThan(0.5);
  });

  it('skok natáhne, dopad zmáčkne', () => {
    const poses = run([view({ grounded: false, vy: perTick(6) }), ...repeat(5, view({ grounded: false, vy: perTick(3) })), view(), view()], 'biped');
    expect(poses[3]!.squash).toBeLessThan(0);
    expect(poses[6]!.squash).toBeGreaterThan(0.1);
    expect(poses[7]!.squash).toBeLessThan(poses[6]!.squash);
  });

  it('útok je nápřah dozadu, výpad dopředu a dojezd do klidu', () => {
    const poses = run([view({ attack: true }), ...repeat(seconds(1), view())], 'biped');
    expect(Math.min(...poses.slice(0, 8).map((pose) => pose.lunge))).toBeLessThan(0);
    expect(max(poses, 'lunge')).toBeGreaterThan(0.1);
    expect(Math.max(...poses.map((pose) => pose.lunge))).toBeGreaterThan(0.1);
    expect(poses.at(-1)!.lunge).toBe(0);
  });

  it('zásah cukne, zakymácí a blikne, pak dozní', () => {
    const poses = run([view({ hit: true }), ...repeat(seconds(1), view())], 'quadruped');
    expect(poses[0]!.recoil).toBeGreaterThan(0.2);
    expect(poses[0]!.flash).toBe(1);
    expect(max(poses, 'wobble')).toBeGreaterThan(0.05);
    expect(amplitudes(poses.at(-1)!)).toEqual(ZERO);
  });

  it('smrt převrhne tělo monotónně až na zem', () => {
    const poses = run([view(), ...repeat(seconds(1), view({ alive: false }))], 'biped');
    const fall = poses.map((pose) => pose.fall);
    expect(fall[0]).toBe(0);
    expect(fall.at(-1)).toBe(1);
    const toFloor = fall.slice(0, fall.findIndex((value) => value >= 1) + 1);
    toFloor.slice(1).forEach((value, i) => expect(value).toBeGreaterThanOrEqual(toFloor[i]!));
  });

  it('výhra je jedna oslava: poskoky s otočkou do 1,5 s, pak klid', () => {
    const poses = run([view(), ...repeat(seconds(2), view({ won: true }))], 'biped');
    expect(poses[0]!.cheer).toBe(0);
    expect(max(poses.slice(1, seconds(1.5)), 'cheer')).toBeGreaterThan(0.5);
    expect(max(poses.slice(1, seconds(1.5)), 'yaw')).toBeGreaterThan(1);
    expect(amplitudes(poses[seconds(1.5)]!)).toEqual(ZERO);
    expect(max(run(walking(seconds(2))), 'cheer')).toBe(0);
  });

  it('nesení zakloní tělo a zkrátí krok', () => {
    const free = run(walking(seconds(2)), 'biped');
    const carrying = run(repeat(seconds(2), view({ vz: perTick(4), carrying: true })), 'biped');
    expect(Math.min(...carrying.map((pose) => pose.pitch))).toBeLessThan(Math.min(...free.map((pose) => pose.pitch)));
    const steps = (poses: readonly ToyPose[]): number => poses.slice(1).filter((pose, i) => Math.sign(pose.roll) !== Math.sign(poses[i]!.roll)).length;
    expect(steps(carrying)).toBeGreaterThan(steps(free));
  });

  it('cíl otevře díl při posunu stavu a nechá ho otevřený', () => {
    const poses = run([view(), ...repeat(seconds(1), view({ opened: true }))], 'prop');
    expect(poses[0]!.open).toBe(0);
    expect(poses[2]!.open).toBeGreaterThan(0);
    expect(poses[2]!.open).toBeLessThan(1);
    expect(poses.at(-1)!.open).toBe(1);
  });

  it('omezený pohyb: žádná amplituda, mrtvý leží od prvního snímku, zásah jen blikne', () => {
    const lively = [...walking(30), view({ grounded: false, vy: perTick(6) }), view(), view({ attack: true }), view({ hit: true }), ...repeat(10, view({ won: true, carrying: true }))];
    for (const body of BODY_CLASSES) {
      for (const pose of run(lively, body, true)) expect({ ...amplitudes(pose), flash: 0 }).toEqual(ZERO);
    }
    const [dead] = run([view({ alive: false })], 'biped', true);
    expect(dead!.fall).toBe(1);
    expect(run([view({ hit: true })], 'biped', true)[0]!.flash).toBe(1);
    expect(run([view({ opened: true })], 'prop', true)[0]!.open).toBe(1);
  });

  it('podíl tiku mezi dvěma tiky nezačne událost znovu', () => {
    let pose = toyPoseOf(view({ hit: true }), 'biped', null, 10, false);
    pose = toyPoseOf(view({ hit: true }), 'biped', pose, 10.5, false);
    expect(pose.recoil).toBeLessThan(toyPoseOf(view({ hit: true }), 'biped', null, 10, false).recoil);
  });
});

describe('toyViewOf – co hračkový pohyb čte ze stavu jádra', () => {
  function world(): { state: Int32Array; prev: Int32Array } {
    const state = new Int32Array(HEADER_SIZE + 4 * BODY_STRIDE);
    state[HEADER.bodyCount] = 4;
    const put = (index: number, role: number, x: number, z: number): void => {
      const base = bodyBase(index);
      state[base + BODY.role] = role;
      state[base + BODY.flags] = FLAG.alive | FLAG.grounded;
      state[base + BODY.x] = x;
      state[base + BODY.z] = z;
    };
    put(0, ROLE.player, 0, 0);
    put(1, ROLE.enemy, 800, 0);
    put(2, ROLE.chaser, 1500, 0);
    put(3, ROLE.target, 9000, 0);
    state[HEADER.counters + COUNTER.health] = 3;
    return { state, prev: state.slice() };
  }

  it('výhra a nesení jen u hráče', () => {
    const { state, prev } = world();
    state[HEADER.runState] = RUN_STATE.won;
    state[HEADER.held] = 4;
    expect(toyViewOf(state, prev, 0)).toMatchObject({ won: true, carrying: true });
    expect(toyViewOf(state, prev, 1)).toMatchObject({ won: false, carrying: false });
  });

  it('útočí nejbližší nepřítel v tiku, kdy hráči ubyl život, a hráč při výstřelu', () => {
    const { state, prev } = world();
    expect(toyViewOf(state, prev, 1).attack).toBe(false);
    state[HEADER.counters + COUNTER.health] = 2;
    expect(toyViewOf(state, prev, 1).attack).toBe(true);
    expect(toyViewOf(state, prev, 2).attack).toBe(false);
    expect(toyViewOf(state, prev, 0).attack).toBe(false);
    state[HEADER.counters + COUNTER.cooldown] = 10;
    expect(toyViewOf(state, prev, 0).attack).toBe(true);
  });

  it('vzdálený nepřítel při zásahu neútočí', () => {
    const { state, prev } = world();
    state[bodyBase(1) + BODY.x] = 20_000;
    state[bodyBase(2) + BODY.x] = 25_000;
    state[HEADER.counters + COUNTER.health] = 2;
    expect([1, 2].map((index) => toyViewOf(state, prev, index).attack)).toEqual([false, false]);
  });

  it('otočka je změna směru pohybu za tik, cíl je otevřený od posunu stavu', () => {
    const { state, prev } = world();
    const base = bodyBase(2);
    prev[base + BODY.vz] = perTick(4);
    state[base + BODY.vx] = perTick(1);
    state[base + BODY.vz] = perTick(4);
    expect(Math.abs(toyViewOf(state, prev, 2).turn)).toBeGreaterThan(0.1);
    expect(toyViewOf(prev, prev, 2).turn).toBe(0);
    expect(toyViewOf(state, prev, 3).opened).toBe(false);
    state[bodyBase(3) + BODY.flags] |= 1 << TARGET_STATE_SHIFT;
    expect(toyViewOf(state, prev, 3).opened).toBe(true);
  });

  it('čte stav, nikdy ho nepíše', () => {
    const { state, prev } = world();
    state[HEADER.counters + COUNTER.health] = 2;
    const before = state.slice();
    for (let index = 0; index < 4; index += 1) toyViewOf(state, prev, index);
    expect(state).toEqual(before);
  });
});
