import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BODY, BODY_STRIDE, COUNTER, FLAG, HEADER, HEADER_SIZE, ROLE, RUN_STATE, UNIT, bodyBase } from '../contract';
import { type MotionView, type Pose, clipOf, poseOf, viewOf } from '../motion';

/** Rychlost v m/s → jednotky za tik (60 Hz). */
const perTick = (metresPerSecond: number): number => Math.round((metresPerSecond * UNIT) / 60);

const view = (over: Partial<MotionView> = {}): MotionView => ({ vx: 0, vy: 0, vz: 0, grounded: true, alive: true, hit: false, shot: false, ...over });

/** Póza po `ticks` ticích stejného pohledu, s pamětí z předchozích. */
function run(views: readonly MotionView[], from = 0): Pose[] {
  const poses: Pose[] = [];
  let previous: Pose | null = null;
  views.forEach((v, i) => {
    previous = poseOf(v, previous, from + i);
    poses.push(previous);
  });
  return poses;
}

const maxBob = (poses: readonly Pose[]): number => Math.max(...poses.map((pose) => pose.bob));

describe('poseOf – póza z pohledu těla', () => {
  it('stojící tělo na zemi je v klidu', () => {
    const [pose] = run([view()]);
    expect(pose).toMatchObject({ bob: 0, lean: 0, squash: 0, flash: 0 });
  });

  it('běžící tělo poskakuje a rychlejší běh poskakuje víc', () => {
    const slow = run(Array.from({ length: 60 }, () => view({ vz: perTick(4) })));
    const fast = run(Array.from({ length: 60 }, () => view({ vz: perTick(10) })));
    expect(maxBob(slow)).toBeGreaterThan(0.01);
    expect(maxBob(fast)).toBeGreaterThan(maxBob(slow));
    // Poskok je pohyb, ne posun: během cyklu se vrací k zemi.
    expect(Math.min(...fast.map((pose) => pose.bob))).toBeLessThan(0.01);
  });

  it('běh se naklání do směru pohybu', () => {
    const [forward] = run([view({ vz: perTick(8) })]);
    const [back] = run([view({ vz: -perTick(8) })]);
    expect(forward!.lean).toBeGreaterThan(0);
    expect(back!.lean).toBeLessThan(0);
  });

  it('tělo ve vzduchu se natáhne a neposkakuje', () => {
    const [air] = run([view({ grounded: false, vy: perTick(6), vz: perTick(8) })]);
    expect(air!.squash).toBeLessThan(0);
    expect(air!.bob).toBe(0);
  });

  it('dopad tělo zmáčkne a zmáčknutí dozní', () => {
    const poses = run([view({ grounded: false, vy: -perTick(6) }), ...Array.from({ length: 20 }, () => view())]);
    expect(poses[1]!.squash).toBeGreaterThan(0.1);
    expect(poses[4]!.squash).toBeLessThan(poses[1]!.squash);
    expect(poses[20]!.squash).toBe(0);
  });

  it('zásah blikne a bliknutí dozní', () => {
    const poses = run([view({ hit: true }), ...Array.from({ length: 30 }, () => view())]);
    expect(poses[0]!.flash).toBe(1);
    expect(poses[5]!.flash).toBeGreaterThan(0);
    expect(poses[5]!.flash).toBeLessThan(1);
    expect(poses[30]!.flash).toBe(0);
  });

  it('mrtvé tělo nemá pózu', () => {
    const [dead] = run([view({ alive: false, vz: perTick(8), grounded: false })]);
    expect(dead).toMatchObject({ bob: 0, lean: 0, squash: 0, flash: 0 });
  });

  it('stejný vstup dá stejnou pózu – póza jde jen z ticku, ne z hodin', () => {
    const script = Array.from({ length: 90 }, (_, i) => view({ vz: perTick(6), grounded: i % 30 > 10, vy: i % 30 > 10 ? 0 : perTick(3), hit: i === 45 }));
    expect(run(script, 1234)).toEqual(run(script, 1234));
  });

  it('funkce nesahá na hodiny ani náhodu', () => {
    const source = readFileSync(join(__dirname, '..', 'motion.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(source).not.toMatch(/Date\.|performance\.|Math\.random/);
  });
});

describe('clipOf – klip riggované postavy ze stavu těla (P26B T5)', () => {
  /** Klip po celém skriptu pohledů – póza nese paměť zásahu a výstřelu. */
  function clipAfter(views: readonly MotionView[]): string {
    let pose: Pose | null = null;
    views.forEach((v, tick) => {
      pose = poseOf(v, pose, tick);
    });
    return clipOf(views[views.length - 1]!, pose!, views.length - 1);
  }

  it('stojící tělo je v klidu', () => expect(clipAfter([view()])).toBe('idle'));
  it('běh po trati (vz) i do strany (vx) je běh', () => {
    expect(clipAfter([view({ vz: perTick(8) })])).toBe('run');
    expect(clipAfter([view({ vx: perTick(5) })])).toBe('run');
  });
  it('tělo ve vzduchu skáče, i když se nehýbe dopředu', () => {
    expect(clipAfter([view({ grounded: false, vy: perTick(5) })])).toBe('jump');
    // Skok podle `vy`/země, ne podle `vx` – plošinovka skáče na místě.
    expect(clipAfter([view({ grounded: false, vx: perTick(6), vz: 0 })])).toBe('jump');
  });
  it('výstřel hraje klip střelby a pak se vrátí k běhu', () => {
    const shot = [view({ shot: true, vz: perTick(6) }), ...Array.from({ length: 5 }, () => view({ vz: perTick(6) }))];
    expect(clipAfter(shot)).toBe('shoot');
    expect(clipAfter([...shot, ...Array.from({ length: 30 }, () => view({ vz: perTick(6) }))])).toBe('run');
  });
  it('zásah přebije běh i skok, pak dozní', () => {
    const hit = [view({ hit: true, grounded: false }), view({ grounded: false })];
    expect(clipAfter(hit)).toBe('hit');
    expect(clipAfter([...hit, ...Array.from({ length: 30 }, () => view())])).toBe('idle');
  });
  it('mrtvé tělo umírá', () => expect(clipAfter([view({ alive: false, vz: perTick(8) })])).toBe('die'));
});

describe('viewOf – co scéna čte ze stavu jádra', () => {
  function world(): { state: Int32Array; prev: Int32Array; base: number } {
    const state = new Int32Array(HEADER_SIZE + 4 * BODY_STRIDE);
    state[HEADER.bodyCount] = 1;
    const base = bodyBase(0);
    state[base + BODY.role] = ROLE.player;
    state[base + BODY.flags] = FLAG.alive | FLAG.gravity | FLAG.grounded;
    return { state, prev: state.slice(), base };
  }

  it('naskočené čekání zbraně je výstřel, ubylý život zásah', () => {
    const { state, prev } = world();
    state[HEADER.counters + COUNTER.cooldown] = 12;
    state[HEADER.counters + COUNTER.health] = 2;
    prev[HEADER.counters + COUNTER.health] = 3;
    expect(viewOf(state, prev, 0)).toMatchObject({ shot: true, hit: true, alive: true });
  });

  it('hráč prohraného běhu je mrtvý, i když tělo trvá', () => {
    const { state, prev } = world();
    state[HEADER.runState] = RUN_STATE.lost;
    expect(viewOf(state, prev, 0).alive).toBe(false);
  });

  it('tělo bez gravitace je na zemi, s gravitací ve vzduchu ne', () => {
    const { state, prev, base } = world();
    state[base + BODY.flags] = FLAG.alive | FLAG.gravity;
    expect(viewOf(state, prev, 0).grounded).toBe(false);
    state[base + BODY.flags] = FLAG.alive;
    expect(viewOf(state, prev, 0).grounded).toBe(true);
  });
});
