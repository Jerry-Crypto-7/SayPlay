/**
 * Nečinná vrstva hračkové pózy (P54B T6): stojící tělo bez události dýchá a občas
 * se rozhlédne, letec se vznáší, plavec se vlní. Vrstva, která se nikdy nezapne,
 * vypadá přesně jako dnešek – proto se tu měří, že se póza stojícího těla v čase
 * opravdu mění, a zároveň že pohyb, událost, omezený pohyb a těla bez vrstvy
 * (riggovaná postava s klipem `idle`, předmět, vozidlo) zůstanou jako dřív.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ARCADE_HZ, UNIT } from '../contract';
import { type BodyClass, type ToyIdle, type ToyPose, type ToyView, BODY_CLASSES, toyPoseOf } from '../toy-motion';

const perTick = (metresPerSecond: number): number => Math.round((metresPerSecond * UNIT) / ARCADE_HZ);
const seconds = (s: number): number => Math.round(s * ARCADE_HZ);

const view = (over: Partial<ToyView> = {}): ToyView => ({
  vx: 0, vy: 0, vz: 0, grounded: true, alive: true, hit: false, shot: false,
  won: false, carrying: false, attack: false, turn: 0, opened: false, ...over,
});
const repeat = (count: number, v: ToyView): ToyView[] => Array.from({ length: count }, () => v);
const still = (count: number): ToyView[] => repeat(count, view());
const walking = (count: number): ToyView[] => repeat(count, view({ vz: perTick(4) }));

const AMPLITUDES = ['hop', 'roll', 'pitch', 'yaw', 'squash', 'lunge', 'recoil', 'wobble', 'fall', 'cheer', 'flash', 'flap', 'wheel', 'sway', 'stride', 'open'] as const;
type Amplitude = (typeof AMPLITUDES)[number];
const amplitudes = (pose: ToyPose): Record<string, number> => Object.fromEntries(AMPLITUDES.map((key) => [key, pose[key]]));
const ZERO = Object.fromEntries(AMPLITUDES.map((key) => [key, 0]));
const peak = (poses: readonly ToyPose[], key: Amplitude): number => Math.max(...poses.map((pose) => Math.abs(pose[key])));

const SEED = 1_234_567;
const idleOf = (index: number, seed = SEED): ToyIdle => ({ index, seed });

/** Pózy pohledů po tiku od 0, každá s pamětí předchozí. */
function run(views: readonly ToyView[], { body = 'biped', reduced = false, idle }: { body?: BodyClass; reduced?: boolean; idle?: ToyIdle } = {}): ToyPose[] {
  const poses: ToyPose[] = [];
  let previous: ToyPose | null = null;
  views.forEach((v, tick) => {
    previous = toyPoseOf(v, body, previous, tick, reduced, idle);
    poses.push(previous);
  });
  return poses;
}

/** Tiky, kdy `value` přešla z ≤ 0 na > 0 (začátek nádechu, začátek rozhlédnutí). */
function risesOf(poses: readonly ToyPose[], value: (pose: ToyPose) => number): number[] {
  const rises: number[] = [];
  for (let tick = 1; tick < poses.length; tick += 1) if (value(poses[tick - 1]!) <= 0 && value(poses[tick]!) > 0) rises.push(tick);
  return rises;
}
const gapsOf = (ticks: readonly number[]): number[] => ticks.slice(1).map((tick, i) => (tick - ticks[i]!) / ARCADE_HZ);

afterEach(() => vi.restoreAllMocks());

describe('nečinná vrstva hračkové pózy (P54B T6)', () => {
  it('stojící biped: póza na tiku t a t + 30 se liší', () => {
    const t = seconds(3);
    const poses = run(still(t + 31), { idle: idleOf(0) });
    expect(amplitudes(poses[t + 30]!)).not.toEqual(amplitudes(poses[t]!));
    expect(amplitudes(poses[t]!)).not.toEqual(ZERO);
  });

  it('dvě těla s různým indexem nejsou ve fázi a jiné semínko hry dá jinou fázi', () => {
    const from = seconds(1);
    const breath = (idle: ToyIdle): number[] => run(still(seconds(10)), { idle }).slice(from).map((pose) => pose.squash);
    const apart = (a: readonly number[], b: readonly number[]): number => a.filter((value, i) => Math.abs(value - b[i]!) > 1e-4).length / a.length;
    const first = breath(idleOf(0));
    expect(apart(first, breath(idleOf(1)))).toBeGreaterThan(0.9);
    expect(apart(first, breath(idleOf(0, SEED + 1)))).toBeGreaterThan(0.9);
  });

  it('reduced-motion: póza stojícího těla se neliší – vrstva je vypnutá', () => {
    for (const body of BODY_CLASSES) {
      for (const pose of run(still(seconds(10)), { body, reduced: true, idle: idleOf(3) })) expect(amplitudes(pose), body).toEqual(ZERO);
    }
  });

  it('pohyb vrstvu přebije: jdoucí tělo má pózu jako bez vrstvy', () => {
    const views = [...still(seconds(3)), ...walking(seconds(2))];
    for (const body of BODY_CLASSES) {
      const plain = run(views, { body }).slice(seconds(3)).map(amplitudes);
      expect(run(views, { body, idle: idleOf(2) }).slice(seconds(3)).map(amplitudes), body).toEqual(plain);
    }
  });

  it('událost vrstvu přebije: zásah, skok, úder a výhra mají pózu jako bez vrstvy', () => {
    const at = seconds(3);
    const events: Readonly<Record<string, ToyView[]>> = {
      hit: [view({ hit: true }), ...still(seconds(0.25))],
      jump: [...repeat(seconds(0.4), view({ grounded: false, vy: perTick(4) })), ...still(seconds(0.15))],
      attack: [view({ attack: true }), ...still(seconds(0.33))],
      won: repeat(seconds(1.25), view({ won: true })),
    };
    for (const [name, event] of Object.entries(events)) {
      const views = [...still(at), ...event];
      const plain = run(views).slice(at).map(amplitudes);
      expect(run(views, { idle: idleOf(5) }).slice(at).map(amplitudes), name).toEqual(plain);
    }
  });

  it('po zastavení nebo události se vrstva rozjede plynule, bez skoku do půlky rozhlédnutí', () => {
    for (let index = 0; index < 8; index += 1) {
      const views = [...still(seconds(2)), ...walking(seconds(1)), ...still(seconds(4)), view({ hit: true }), ...still(seconds(4))];
      const poses = run(views, { idle: idleOf(index) });
      // Od zastavení (tik 3 s) dál; vlastní zásah (tik 7 s) vrstvu utne, to je „událost přebije“.
      for (let tick = seconds(3); tick < poses.length; tick += 1) {
        if (tick === seconds(7)) continue;
        expect(Math.abs(poses[tick]!.yaw - poses[tick - 1]!.yaw), `index ${index}, tick ${tick}`).toBeLessThan(0.03);
        expect(Math.abs(poses[tick]!.squash - poses[tick - 1]!.squash), `index ${index}, tick ${tick}`).toBeLessThan(0.003);
      }
    }
  });

  it('dech ±2 % s periodou 2,5–3,5 s, rozhlédnutí ±15° jednou za 4–7 s (biped i čtyřnožec)', () => {
    const glance = (15 * Math.PI) / 180;
    for (const body of ['biped', 'quadruped'] as const) {
      for (let index = 0; index < 6; index += 1) {
        const poses = run(still(seconds(30)), { body, idle: idleOf(index, SEED + index * 7) }).slice(seconds(1));
        expect(peak(poses, 'squash')).toBeLessThanOrEqual(0.02 + 1e-12);
        expect(peak(poses, 'squash')).toBeGreaterThan(0.018);
        expect(peak(poses, 'yaw')).toBeLessThanOrEqual(glance + 1e-12);
        expect(peak(poses, 'yaw')).toBeGreaterThan(glance * 0.99);
        // Kraje intervalů o tik volněji: přechod se měří po tiku.
        for (const gap of gapsOf(risesOf(poses, (pose) => pose.squash))) expect(gap, `${body} ${index} breath`).toBeGreaterThanOrEqual(2.5 - 1 / 60);
        for (const gap of gapsOf(risesOf(poses, (pose) => pose.squash))) expect(gap, `${body} ${index} breath`).toBeLessThanOrEqual(3.5 + 1 / 60);
        const glances = gapsOf(risesOf(poses, (pose) => Math.abs(pose.yaw)));
        expect(glances.length, `${body} ${index}`).toBeGreaterThanOrEqual(3);
        for (const gap of glances) expect(gap, `${body} ${index} glance`).toBeGreaterThanOrEqual(4 - 1 / 60);
        for (const gap of glances) expect(gap, `${body} ${index} glance`).toBeLessThanOrEqual(7 + 1 / 60);
        // Rozhlédnutí střídá strany.
        const sides = risesOf(poses, (pose) => Math.abs(pose.yaw)).map((tick) => Math.sign(poses[tick + seconds(0.5)]!.yaw));
        expect(new Set(sides)).toEqual(new Set([-1, 1]));
      }
    }
  });

  it('letec se vznáší ±4 % výšky, plavec se vlní; předmět a vozidlo stojí', () => {
    const flyer = run(still(seconds(10)), { body: 'flyer', idle: idleOf(4) }).slice(seconds(1));
    expect(peak(flyer, 'hop')).toBeLessThanOrEqual(0.04 + 1e-12);
    expect(peak(flyer, 'hop')).toBeGreaterThan(0.036);
    expect(Math.min(...flyer.map((pose) => pose.hop))).toBeLessThan(0);
    const swimmer = run(still(seconds(10)), { body: 'swimmer', idle: idleOf(4) }).slice(seconds(1));
    expect(peak(swimmer, 'sway')).toBeGreaterThan(0.1);
    for (const body of ['prop', 'vehicle'] as const) {
      for (const pose of run(still(seconds(10)), { body, idle: idleOf(4) })) expect(amplitudes(pose), body).toEqual(ZERO);
    }
  });

  it('bez nečinné vrstvy (riggovaná postava hraje klip `idle`) stojí tělo jako dnes', () => {
    for (const body of BODY_CLASSES) {
      for (const pose of run(still(seconds(10)), { body })) expect(amplitudes(pose), body).toEqual(ZERO);
    }
  });

  it('čas jen z tiku: žádná náhoda ani hodiny, stejné tiky = stejná póza', () => {
    const random = vi.spyOn(Math, 'random');
    const date = vi.spyOn(Date, 'now');
    const clock = vi.spyOn(performance, 'now');
    const views = [...still(seconds(5)), ...walking(seconds(1)), ...still(seconds(5))];
    for (const body of BODY_CLASSES) expect(run(views, { body, idle: idleOf(1) })).toEqual(run(views, { body, idle: idleOf(1) }));
    expect(random).not.toHaveBeenCalled();
    expect(date).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
  });
});
