/**
 * Pohyb hrdiny běžce (P32A T5): co oko na snímku nepozná. Náklon do úhybu
 * přijde do 150 ms na správnou stranu a zase povolí, odraz tělo zmáčkne a skok
 * natáhne, pták a věta s jízdou dostanou pózu jízdy a pohyb do hry nesáhne –
 * replay má s ním i bez něj tentýž hash.
 */

import { describe, expect, it } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BUTTON, HEADER, type InputEvent } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { type Pose, poseOf, viewOf } from '@/play/arcade/motion';
import { readGameSpec } from '@/play/spec';

import { HERO_MOTION, type Ride, blinksOnHit, createHeroMotion, rideOf } from '../runner/heroMotion';
import { type ArcadeSession, createArcadeSession } from '../session';

function worldOf(): ArcadeWorld {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const world = worldOf();
const DEG = 180 / Math.PI;
/** 150 ms v tikách jádra. */
const LEAN_DEADLINE_TICKS = Math.floor((150 * ARCADE_HZ) / 1000);

/** Hráč „ručně“ zahraje záznam tik po tiku (postup z `effects.test.ts`); `each` běží po každém tiku. */
function playByHand(session: ArcadeSession, inputs: readonly InputEvent[], each: () => void = () => undefined): void {
  let next = 0;
  for (let tick = 0; tick < 90 * 60 && session.snapshot().runState === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    if (event !== undefined && event.tick === tick) {
      session.hold(event.axis);
      session.press(event.buttons);
    } else session.hold(0);
    session.stepOnce();
    each();
  }
}

/** Relace po `ticks` tikách běhu bez vstupu, s pohybem, který se čte každý tik. */
function running(ticks: number, ride: Ride = null) {
  const session = createArcadeSession(world);
  const motion = createHeroMotion(session, ride);
  for (let i = 0; i < ticks; i += 1) {
    session.stepOnce();
    motion.sample();
  }
  return { session, motion };
}

describe('runner hero motion (P32A T5)', () => {
  it('leans into a dodge within 150 ms, towards the side it moves, then straightens', () => {
    for (const [button, sign] of [
      [BUTTON.RIGHT, 1],
      [BUTTON.LEFT, -1],
    ] as const) {
      const { session, motion } = running(5);
      expect(motion.sample().roll).toBe(0);
      session.press(button);
      let leaned: number | null = null;
      let most = 0;
      for (let tick = 1; tick <= 40; tick += 1) {
        session.stepOnce();
        const roll = motion.sample().roll * DEG;
        most = Math.max(most, Math.abs(roll));
        if (leaned === null && Math.abs(roll) > 5) {
          leaned = tick;
          // Náklon jde tam, kam hráč uhýbá: „RIGHT“ je na obrazovce vpravo, to je scéna −x a hlava k −x = + roll.
          expect(Math.sign(roll), `strana náklonu pro tlačítko ${button}`).toBe(sign);
        }
      }
      expect(leaned, 'tik, ve kterém náklon přešel 5°').not.toBeNull();
      expect(leaned!).toBeLessThanOrEqual(LEAN_DEADLINE_TICKS);
      expect(most).toBeLessThanOrEqual(HERO_MOTION.leanMax * DEG + 1e-9);
      expect(most, 'plný náklon je znát').toBeGreaterThan(10);
      // Pruh je hotový za 8 tiků; o 32 tiků později tělo stojí rovně.
      expect(Math.abs(motion.sample().roll * DEG)).toBeLessThan(0.5);
    }
  });

  it('still leans when the whole lane change happens between two frames', () => {
    // Zaseknutý snímek (načítání modelu, telefon): relace dotiká 9 tiků najednou a změna pruhu (8 tiků) je hotová.
    const { session, motion } = running(5);
    session.press(BUTTON.RIGHT);
    for (let tick = 0; tick < 9; tick += 1) session.stepOnce();
    expect(motion.sample().roll * DEG).toBeGreaterThan(5);
  });

  it('squashes on take-off, stretches in the jump and squashes again on landing', () => {
    const { session, motion } = running(5);
    const player = session.state()[HEADER.player] as number;
    // Statický model: `World` dá vnitřní skupině pózu `poseOf`, obal hrdiny zmáčknutí odrazu – výšky se násobí.
    let pose: Pose | null = null;
    const heightScale = (): number => {
      const tick = session.state()[HEADER.tick] as number;
      pose = poseOf(viewOf(session.state(), session.prev(), player), pose, tick);
      return (1 - motion.sample().squash) * (1 - pose.squash);
    };
    heightScale();
    expect(heightScale(), 'běh po rovině').toBe(1);
    session.press(BUTTON.TAP);
    const curve: { scale: number; grounded: boolean }[] = [];
    for (let tick = 0; tick < 60; tick += 1) {
      session.stepOnce();
      curve.push({ scale: heightScale(), grounded: motion.sample().grounded });
    }
    const air = curve.findIndex((sample) => !sample.grounded);
    const land = curve.findIndex((sample, index) => index > air && sample.grounded);
    expect(air, 'odraz hned v tiku stisku').toBe(0);
    expect(land, 'dopad').toBeGreaterThan(air);
    // Odraz: tělo nižší než v klidu hned v prvním tiku ve vzduchu a ještě dva tiky potom.
    for (const sample of curve.slice(air, air + 3)) expect(sample.scale).toBeLessThan(0.9);
    // Výskok: do 10 tiků natažené.
    expect(Math.max(...curve.slice(air + 3, air + 10).map((sample) => sample.scale))).toBeGreaterThan(1.1);
    // Dopad: zase zmáčknuté, pak zpět na 1.
    expect(curve[land]!.scale).toBeLessThan(0.9);
    expect(curve.at(-1)!.scale).toBe(1);
    // Na zemi se tělo nikdy nenatáhne: po dopadu jen povoluje zmáčknutí.
    expect(curve.filter((sample) => sample.grounded).every((sample) => sample.scale <= 1)).toBe(true);
  });

  it('picks the ride pose for a bird hero, a riding sentence (theme.motion) or a riding model', () => {
    // Tučňák z věty P32 (`genre/runner.ts` → hrdina `penguin`) a ptáci katalogu jedou na břiše – i když věta klouže.
    for (const hero of ['penguin', 'bird', 'gen3d-bald-eagle', 'cc0-chicken']) expect(rideOf(hero), hero).toBe('lie');
    expect(rideOf('penguin', true)).toBe('lie');
    // Věta, která klouže nebo lyžuje (`genre/runner.ts` → `theme.motion: 'ride'` → `sceneLook`), dá předklon každému hrdinovi.
    for (const hero of ['rigged:girl-a', 'explorer', 'fox']) expect(rideOf(hero, true), hero).toBe('board');
    for (const hero of ['cc0-sled', 'gen3d-skateboard']) expect(rideOf(hero), hero).toBe('board');
    // Běžec, dítě a zvíře bez jízdy ve větě běží.
    for (const hero of ['explorer', 'rigged:boy-a', 'rigged:knight', 'fox', 'robot']) expect(rideOf(hero), hero).toBeNull();

    // Vleže musí být předklon i s během přes 60° – kolem 45° z kamery běžce vypadá jako stání.
    const lie = running(5, 'lie').motion.sample();
    const board = running(5, 'board').motion.sample();
    const run = running(5).motion.sample();
    expect(lie.pitch * DEG).toBeGreaterThan(55);
    expect(board.pitch * DEG).toBeGreaterThan(20);
    expect(board.pitch).toBeLessThan(lie.pitch);
    expect(run.pitch).toBe(0);
  });

  it('blinks on a hit only for a rigged hero whose manifest has no hit clip', () => {
    expect(blinksOnHit('rigged:boy-a')).toBe(true);
    expect(blinksOnHit('rigged:knight')).toBe(false);
    // Statický model bliká přes `poseOf` ve `World`; druhé bliknutí by se s ním pralo.
    expect(blinksOnHit('penguin')).toBe(false);
  });

  it('motion on and off give the same replay hash and never touch the state', () => {
    const watched = createArcadeSession(world);
    const plain = createArcadeSession(world);
    const inputs = watched.botInputs();
    const motion = createHeroMotion(watched, 'lie');
    let leaned = 0;
    let squashed = 0;
    playByHand(watched, inputs, () => {
      const state = Int32Array.from(watched.state());
      const prev = Int32Array.from(watched.prev());
      const sample = motion.sample();
      if (Math.abs(sample.roll) > 0.05) leaned += 1;
      if (sample.squash > 0) squashed += 1;
      expect(watched.state()).toEqual(state);
      expect(watched.prev()).toEqual(prev);
    });
    playByHand(plain, inputs);

    expect(watched.snapshot().runState).toBe('won');
    // Robot uhýbá i skáče – pohyb se opravdu počítal.
    expect(leaned).toBeGreaterThan(0);
    expect(squashed).toBeGreaterThan(0);
    expect(hashArcade(watched.state())).toBe(hashArcade(plain.state()));
    expect(watched.inputs()).toEqual(plain.inputs());
  });
});
