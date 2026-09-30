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
import { ARCADE_HZ, HEADER, NO_INPUT, RUN_STATE, targetStateOf, type ArcadeWorld } from '../contract';
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

  // Revize fáze 3 P32B, nález 1: model smí `interact` (B-R8), robot pravidel ale Use nedržel,
  // takže žádná taková hra neprošla ověřením.
  it('interact: the robot walks to the bell, holds Use and lets go between its two steps', () => {
    const { things: _things, ...plain } = leverBridge;
    const ringBell = (order: boolean) => ({
      ...plain,
      roles: [leverBridge.roles[0], { id: 'bell', kind: 'switch', label: 'bronze bell', count: 2 }],
      rules: [{ id: 'ring', verb: 'ring', when: { interact: { role: 'bell', radius: 2, hold: 20, states: 3, order } }, do: [{ win: true }] }],
    });
    for (const order of [false, true]) {
      for (const seed of SEEDS) {
        const verdict = verifyArcade(world(ringBell(order), seed));
        expect({ order, seed, outcome: verdict.bot.outcome, failures: verdict.failures }).toEqual({ order, seed, outcome: 'won', failures: [] });
        expect(verdict.verbs).toEqual([expect.objectContaining({ verb: 'ring', fired: true })]);
        // Obě zvonky dozvoněné: výhra s jediným by tenhle test dřív taky prošla.
        const w = world(ringBell(order), seed);
        const run = runBot(w);
        const state = instantiate(w);
        const program = loadProgram(w, ARCADE_LIBRARY);
        let next = 0;
        for (let tick = 0; tick < run.tick; tick += 1) {
          const event = run.inputs[next];
          const now = event !== undefined && event.tick === tick;
          if (now) next += 1;
          step(state, now ? event : NO_INPUT, program);
        }
        let rung = 0;
        for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (targetStateOf(state, body) === 2) rung += 1;
        expect({ order, seed, rung }).toEqual({ order, seed, rung: 2 });
      }
    }
  });

  // Revize fáze 3 P32B, kolo 2, nález 1: `do {win:true}` vyhrálo hned s první hotovou svíčkou.
  it('interact: a four-candle game is not won after one candle, only after all four', () => {
    const { things: _things, ...plain } = leverBridge;
    const spec = {
      ...plain,
      roles: [leverBridge.roles[0], { id: 'candle', kind: 'switch', label: 'wax candle', count: 4 }],
      rules: [{ id: 'light', verb: 'light', when: { interact: { role: 'candle', radius: 2, hold: 20, states: 2 } }, do: [{ win: true }] }],
    };
    for (const seed of SEEDS) {
      const w = world(spec, seed);
      const run = runBot(w);
      expect({ seed, outcome: run.outcome }).toEqual({ seed, outcome: 'won' });
      const program = loadProgram(w, ARCADE_LIBRARY);
      const state = instantiate(w);
      const lit = (): number => {
        let n = 0;
        for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (targetStateOf(state, body) > 0) n += 1;
        return n;
      };
      let next = 0;
      const seen: [number, number][] = [];
      for (let tick = 0; tick < run.tick && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
        const event = run.inputs[next];
        const now = event !== undefined && event.tick === tick;
        if (now) next += 1;
        step(state, now ? event : NO_INPUT, program);
        const pair: [number, number] = [lit(), state[HEADER.runState] as number];
        if (seen.at(-1)?.[0] !== pair[0] || seen.at(-1)?.[1] !== pair[1]) seen.push(pair);
      }
      expect({ seed, seen }).toEqual({
        seed,
        seen: [
          [0, RUN_STATE.running],
          [1, RUN_STATE.running],
          [2, RUN_STATE.running],
          [3, RUN_STATE.running],
          [4, RUN_STATE.won],
        ],
      });
    }
  });

  // Revize fáze 3 P32B, kolo 2, nález 2: skrytý cíl `interact` robot nenašel a hru prohrál.
  it('interact: the robot pulls the lever to reveal a hidden candle, then lights it', () => {
    const spec = {
      ...leverBridge,
      roles: [leverBridge.roles[0], leverBridge.roles[1], { id: 'candle', kind: 'switch', label: 'wax candle' }],
      things: [{ role: 'candle', start: 'hidden' }],
      rules: [
        { id: 'pull', verb: 'pull', when: { contact: ['player', 'lever'] }, do: [{ toggle: 'candle' }] },
        { id: 'light', verb: 'light', when: { interact: { role: 'candle', radius: 2, hold: 20, states: 2 } }, do: [{ win: true }] },
      ],
    };
    for (const seed of [1, 2]) {
      const verdict = verifyArcade(world(spec, seed));
      expect({ seed, outcome: verdict.bot.outcome, failures: verdict.failures }).toEqual({ seed, outcome: 'won', failures: [] });
      expect(verdict.verbs.map((proof) => [proof.verb, proof.fired])).toEqual([
        ['pull', true],
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
