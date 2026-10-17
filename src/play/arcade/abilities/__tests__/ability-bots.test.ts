/**
 * Roboti používají akce (P46A T6): na každém ze 3 ovládání × 5 akcí × 4
 * semínka robot intermediate akci zmáčkne a ověření hry ji dokáže – žádné
 * `VERB_UNPROVED` ani `VERB_NO_EFFECT` za sloveso akce.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readGameSpec } from '../../../spec';
import { arcadeWorldOf, preloadPhysics } from '../../compile';
import { ABILITIES, type AbilityId, type ArcadeWorld, BODY, BUTTON, bodyBase } from '../../contract';
import { loadRapier } from '../../physics/world';
import { runBot, verifyArcade } from '../../verify';
import { contactAt } from '../bot';
import { inStrikeReach, inStrikeReachWithin } from '../strike';
import runner from '../../__fixtures__/runner.json';
import platform from '../../__fixtures__/platform.json';
import steer from '../../__fixtures__/steer.json';

const FIXTURES = { runner, platform, steer } as const;
type Control = keyof typeof FIXTURES;
const CONTROLS = Object.keys(FIXTURES) as Control[];
const SEEDS = [1, 2, 3, 4];

function worldOf(control: Control, ability: AbilityId, seed: number): ArcadeWorld {
  const read = readGameSpec({ ...(FIXTURES[control] as object), abilities: [ability] });
  if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
  const made = arcadeWorldOf(read.value, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

beforeAll(async () => {
  for (const control of CONTROLS) {
    const read = readGameSpec(FIXTURES[control]);
    if (read.ok) await preloadPhysics(read.value, loadRapier);
  }
});

describe.each(CONTROLS)('P46A bots use abilities on %s', (control) => {
  it.each([...ABILITIES])('%s: the intermediate bot presses it and the verb is proved', (ability) => {
    for (const seed of SEEDS) {
      const world = worldOf(control, ability, seed);
      const run = runBot(world, undefined, { profile: 'intermediate' });
      expect(run.inputs.some((event) => (event.buttons & BUTTON.ACTION_A) !== 0), `seed ${seed}: never pressed`).toBe(true);
      // Výhry robota intermediate (chybuje schválně) hlídá `abilities-difficulty.test.ts`; tady robot světa vyhrát musí.
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.verbs.find((proof) => proof.verb === ability)?.changed, `seed ${seed}: ${verdict.failures.join(' | ')}`).toBe(true);
    }
  });
});

const PAIRS = ABILITIES.flatMap((first, i) => ABILITIES.slice(i + 1).map((second) => [first, second] as const));

// R4: s dvojicí akcí jedna nesmí druhé vzít všechny příležitosti (střela zabije nepřítele dřív
// než úder, štít pohltí náraz dřív než dash) – robot světa vyhraje a dokáže obě slovesa.
describe.each(CONTROLS.flatMap((control) => [[control, []], [control, ['shoot']]] as const))('P46A two abilities on %s with addons %j', (control, addons) => {
  it.each(PAIRS)('%s + %s: the bot wins and proves both verbs', (first, second) => {
    for (const seed of SEEDS) {
      const read = readGameSpec({ ...(FIXTURES[control] as object), addons, abilities: [first, second] });
      if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
      const made = arcadeWorldOf(read.value, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      expect(verifyArcade(made.world).failures, `seed ${seed}`).toEqual([]);
    }
  });
});

// R5: robot se ptá na dotyk u každého těla trati v každém tiku, tak vzdálená těla vyřadí bez
// smyčky přes okno. Zkratka nesmí změnit odpověď – tělo, které by vyřadila omylem, by robot nechal narazit.
describe('P46A contact prediction', () => {
  it('rules a body out early only when no tick of the window touches', () => {
    const state = new Int32Array(bodyBase(2));
    const put = (body: number, values: Partial<Record<keyof typeof BODY, number>>): void => {
      for (const [key, value] of Object.entries(values)) state[bodyBase(body) + BODY[key as keyof typeof BODY]] = value;
    };
    const at = (body: number, axis: number, speed: number, t: number): number => (state[bodyBase(body) + axis] as number) + (state[bodyBase(body) + speed] as number) * t;
    // Původní odpověď: projít každý tik okna.
    const slow = (from: number, to: number): number => {
      for (let t = from; t <= to; t += 1) {
        const dx = Math.abs(at(1, BODY.x, BODY.vx, t) - at(0, BODY.x, BODY.vx, t));
        const dz = Math.abs(at(1, BODY.z, BODY.vz, t) - at(0, BODY.z, BODY.vz, t));
        if (dx * 2 < 800 + 1000 && dz * 2 < 600 + 900) return t;
      }
      return -1;
    };
    put(0, { x: 300, z: 0, y: 0, vx: 0, vz: 180, w: 800, d: 600, h: 1000 });
    const misses: string[] = [];
    let touches = 0;
    for (let x = -4000; x <= 4000; x += 250) {
      for (let vx = -240; vx <= 240; vx += 80) {
        for (let z = -3000; z <= 9000; z += 300) {
          for (const vz of [-200, -60, 0, 90, 180, 260]) {
            put(1, { x, z, y: 0, vx, vz, w: 1000, d: 900, h: 1000 });
            const want = slow(3, 27);
            if (want >= 0) touches += 1;
            const got = contactAt(state, 0, 1, 3, 27);
            if (got !== want && misses.length < 5) misses.push(`x ${x} vx ${vx} z ${z} vz ${vz}: ${got} instead of ${want}`);
          }
        }
      }
    }
    expect(misses).toEqual([]);
    expect(touches).toBeGreaterThan(100);
  });

  it('rules a body out of strike reach early only when no tick of the window reaches it', () => {
    const state = new Int32Array(bodyBase(2));
    const put = (body: number, values: Partial<Record<keyof typeof BODY, number>>): void => {
      for (const [key, value] of Object.entries(values)) state[bodyBase(body) + BODY[key as keyof typeof BODY]] = value;
    };
    put(0, { x: 300, z: 0, y: 0, vx: 0, vz: 180, w: 800, d: 600, h: 1000 });
    const misses: string[] = [];
    const reached = { true: 0, false: 0 };
    for (const around of [false, true]) {
      for (let x = -5000; x <= 5000; x += 250) {
        for (let vx = -240; vx <= 240; vx += 80) {
          for (let z = -5000; z <= 9000; z += 300) {
            for (const vz of [-200, -60, 0, 90, 180, 260]) {
              put(1, { x, z, y: 0, vx, vz, w: 1000, d: 900, h: 1000 });
              // Původní odpověď: každý tik okna zvlášť.
              let want = false;
              for (let t = 4; t <= 15 && !want; t += 1) want = inStrikeReach(state, 0, 1, t, around);
              if (want) reached[`${around}`] += 1;
              const got = inStrikeReachWithin(state, 0, 1, 4, 15, around);
              if (got !== want && misses.length < 5) misses.push(`around ${around} x ${x} vx ${vx} z ${z} vz ${vz}: ${got}`);
            }
          }
        }
      }
    }
    expect(misses).toEqual([]);
    expect(reached.false).toBeGreaterThan(100);
    expect(reached.true).toBeGreaterThan(100);
  });
});
