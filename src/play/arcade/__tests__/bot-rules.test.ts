/**
 * Robot hraje pravidla (P29A T5): šest ručních her, kde se vyhrává slovesy –
 * nést, hodit, strčit, dát, zatáhnout, posbírat. Robot musí vyhrát a každé
 * sloveso během běhu vystřelit. Kontrola nakonec: dnešní robot arény by
 * většinu z nich nedohrál, jinak by fixtures nic neměřily.
 */

import { describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import carryKey from '../__fixtures__/rules/carry-key.json';
import collectGate from '../__fixtures__/rules/collect-gate.json';
import giveFlower from '../__fixtures__/rules/give-flower.json';
import leverBridge from '../__fixtures__/rules/lever-bridge.json';
import pushCrate from '../__fixtures__/rules/push-crate.json';
import setLantern from '../__fixtures__/rules/set-lantern.json';
import throwRock from '../__fixtures__/rules/throw-rock.json';
import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, NO_INPUT, type ArcadeWorld } from '../contract';
import { instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { runBot, verifyArcade } from '../verify';

const FIXTURES = {
  'carry key to door': carryKey,
  'throw rock at target': throwRock,
  'push crate onto switch': pushCrate,
  'pick flower then give to npc': giveFlower,
  'pull lever opens bridge': leverBridge,
  'collect 3 then gate opens': collectGate,
} as const;

/** Tři rozmístění dvorku na hru: robot nesmí umět jen jedno. */
const SEEDS = [1, 2, 3];

function world(input: unknown, seed: number): ArcadeWorld {
  const spec = readGameSpec(input);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const made = arcadeWorldOf(spec.value as GameSpecV1, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('the robot plays rule games', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}: wins on every seed and fires every verb`, () => {
      for (const seed of SEEDS) {
        const verdict = verifyArcade(world(fixture, seed));
        expect({ seed, outcome: verdict.bot.outcome, failures: verdict.failures }).toEqual({ seed, outcome: 'won', failures: [] });
        expect(verdict.verbs.length).toBe(fixture.rules.length);
        expect(verdict.verbs.every((proof) => proof.fired)).toBe(true);
        // Věrohodný hráč malý dvorek projde do 8 s; bloudění podél zdi by trvalo déle.
        expect(verdict.bot.tick).toBeLessThan(8 * ARCADE_HZ);
      }
    });
  }

  it('throw rock: the robot aims, so the first throw hits and it picks the rock up only once', () => {
    for (const seed of SEEDS) {
      const w = world(throwRock, seed);
      const run = runBot(w);
      const pick = w.rules.findIndex((ref) => ref.params.id === 'pick_rock');
      const program = loadProgram(w, ARCADE_LIBRARY);
      const state = instantiate(w);
      let picks = 0;
      let next = 0;
      for (let tick = 0; tick < run.tick; tick += 1) {
        const event = run.inputs[next];
        const now = event !== undefined && event.tick === tick;
        if (now) next += 1;
        step(state, now ? event : NO_INPUT, program, (rule) => {
          if (rule === pick) picks += 1;
        });
      }
      expect({ seed, picks }).toEqual({ seed, picks: 1 });
    }
  });

  it('set lantern: the robot carries it to a low target and sets it down with the release rule', () => {
    for (const seed of SEEDS) {
      const verdict = verifyArcade(world(setLantern, seed));
      expect({ seed, outcome: verdict.bot.outcome, failures: verdict.failures }).toEqual({ seed, outcome: 'won', failures: [] });
      expect(verdict.verbs.map((proof) => [proof.verb, proof.fired])).toEqual([
        ['take', true],
        ['set', true],
        ['light', true],
      ]);
    }
  });

  it('the arena robot alone fails at least 4 of the 6 games (the fixtures measure the planner)', () => {
    const failed = Object.values(FIXTURES).filter((fixture) => {
      const w = world(fixture, 1);
      return runBot(w, ARCADE_LIBRARY, { planner: false }).outcome !== 'won';
    });
    expect(failed.length).toBeGreaterThanOrEqual(4);
  });
});
