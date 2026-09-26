/**
 * Překlad pravidel ze specu na kusy jádra (P29A T2).
 *
 * Nejsilnější důkaz překladu je rovnost s ručním kusem: pravidlo „dotyk mince →
 * skóre, mince zmizí“ musí dát tik po tiku tentýž stav jako `pickup`. Chyba
 * pořadí fází by tu vypadala jako hratelná hra, jen s jiným hashem.
 */

import { describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import runnerFixture from '../__fixtures__/runner.json';
import arenaFixture from '../__fixtures__/arena.json';
import { arcadeWorldOf } from '../compile';
import { ARCADE_LIMITS, BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, stateSize, type ArcadeWorld, type InputEvent } from '../contract';
import { hashArcade, instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { PAIR_CHECKS_MAX, PAIR_RULES_MAX, SPEC_RULES, THING_ROLE_BASE, YARD, compileRules } from '../rules/compile';
import { runBot } from '../verify';

function read(input: unknown): GameSpecV1 {
  const result = readGameSpec(input);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.value;
}

function world(spec: GameSpecV1, seed = 1): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Hashe po každém tiku přehrání záznamu. */
function hashes(w: ArcadeWorld, inputs: readonly InputEvent[], ticks: number): string[] {
  const program = loadProgram(w, ARCADE_LIBRARY);
  const state = instantiate(w);
  const out: string[] = [];
  let next = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    out.push(hashArcade(state));
  }
  return out;
}

const bodiesOf = (w: ArcadeWorld, code: number): number[] => {
  const state = instantiate(w);
  const found: number[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) if (state[bodyBase(i) + BODY.role] === code) found.push(i);
  return found;
};

const yardSpec = {
  ...arenaFixture,
  controlParams: {},
  mechanics: [],
  roles: [
    { id: 'player', kind: 'player', label: 'knight' },
    { id: 'key', kind: 'key', label: 'golden key' },
    { id: 'door', kind: 'door', label: 'castle door' },
    { id: 'exit', kind: 'exit', label: 'tower stairs' },
  ],
  rules: [
    { id: 'carry', verb: 'carry', when: { contact: ['player', 'key'] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
    { id: 'use', verb: 'use', when: { press: 'action' }, if: [{ holding: 'key' }], do: [{ score: 5 }] },
    { id: 'open', verb: 'open', when: { contact: ['player', 'door'] }, if: [{ holding: 'key' }], do: [{ toggle: 'door' }] },
    { id: 'deliver', verb: 'deliver', when: { contact: ['key', 'exit'] }, do: [{ win: true }] },
  ],
};

describe('compileRules', () => {
  it('a contact rule plays tick for tick like the hand-written pickup (600 ticks)', () => {
    const spec = read(runnerFixture);
    const hand = world(spec);
    const rule = { id: 'coins', verb: 'collect', when: { contact: ['player', 'coin'] }, do: [{ score: 1 }, { despawn: 'other' }] };
    const ruled = read({ ...runnerFixture, rules: [rule] });
    const coin = { role: 'collectible' as const, kind: 'coin', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false };
    const player = { role: 'player' as const, kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false };
    const compiled = compileRules(ruled, { bodies: [player, coin], length: 0 }, 1);
    expect(compiled.level.bodies).toHaveLength(2);
    expect(compiled.rules).toEqual([{ id: 'rule_contact', params: expect.objectContaining({ when: { contact: [ROLE.player, ROLE.collectible] } }) }]);
    const swapped: ArcadeWorld = { ...hand, rules: [...hand.rules.filter((ref) => ref.id !== 'pickup'), ...compiled.rules] };
    expect(swapped.rules.length).toBe(hand.rules.length);

    const inputs = runBot(hand).inputs;
    const a = hashes(hand, inputs, 600);
    const b = hashes(swapped, inputs, 600);
    expect(b).toEqual(a);
    // Rovnost něco měří jen tehdy, když robot za 600 tiků nějakou minci sebral.
    const program = loadProgram(swapped, ARCADE_LIBRARY);
    const state = instantiate(swapped);
    let next = 0;
    for (let tick = 0; tick < 600; tick += 1) {
      const event = inputs[next];
      if (event !== undefined && event.tick === tick) next += 1;
      step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    }
    expect(state[HEADER.counters + COUNTER.score]).toBeGreaterThan(0);
  });

  it('keeps a spec without rules on the same world (hash of every fixture unchanged)', () => {
    const spec = read(runnerFixture);
    expect(compileRules(spec, { bodies: [], length: 0 }, 1)).toEqual({ rules: [], level: { bodies: [], length: 0 }, issues: [] });
  });

  it('a press rule with a holding condition fires only on the press, and only while holding', () => {
    const w = world(read(yardSpec));
    const program = loadProgram(w, ARCADE_LIBRARY);
    const [key] = bodiesOf(w, THING_ROLE_BASE);
    expect(key).toBeDefined();
    const score = (s: Int32Array): number => s[HEADER.counters + COUNTER.score] as number;

    const empty = instantiate(w);
    step(empty, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(score(empty)).toBe(0);

    const holding = instantiate(w);
    holding[HEADER.held] = key! + 1;
    step(holding, NO_INPUT, program);
    step(holding, { buttons: BUTTON.HOLD, axis: 0 }, program);
    expect(score(holding)).toBe(0);
    step(holding, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(score(holding)).toBe(5);
  });

  it('a contact between two things fires without the player', () => {
    const w = world(read(yardSpec));
    const program = loadProgram(w, ARCADE_LIBRARY);
    const [key] = bodiesOf(w, THING_ROLE_BASE);
    const [exit] = bodiesOf(w, THING_ROLE_BASE + 2);
    const state = instantiate(w);
    step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('running');
    state[bodyBase(key!) + BODY.x] = state[bodyBase(exit!) + BODY.x] as number;
    state[bodyBase(key!) + BODY.z] = state[bodyBase(exit!) + BODY.z] as number;
    step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('won');
  });

  it('builds the yard: a wall with the door in its gap, the goal behind it, the key in front', () => {
    const w = world(read(yardSpec));
    expect(w.control).toEqual({ id: 'move_free', params: { half: YARD.half } });
    const state = instantiate(w);
    const z = (i: number): number => state[bodyBase(i) + BODY.z] as number;
    const x = (i: number): number => state[bodyBase(i) + BODY.x] as number;
    const [key] = bodiesOf(w, THING_ROLE_BASE);
    const [door] = bodiesOf(w, THING_ROLE_BASE + 1);
    const [exit] = bodiesOf(w, THING_ROLE_BASE + 2);
    const fences = bodiesOf(w, ROLE.obstacle);
    expect(fences).toHaveLength(2);
    expect(z(door!)).toBe(YARD.wallZ);
    expect(z(exit!)).toBeGreaterThan(YARD.wallZ);
    expect(z(key!)).toBeLessThan(YARD.wallZ);
    // Zeď s dveřmi přehradí dvorek celý: mezera je přesně pod dveřmi.
    const covered = fences.reduce((sum, f) => sum + (state[bodyBase(f) + BODY.w] as number), 0) + (state[bodyBase(door!) + BODY.w] as number);
    expect(covered).toBe(2 * YARD.half);
    expect(fences.every((f) => Math.abs(x(f) - x(door!)) * 2 >= (state[bodyBase(f) + BODY.w] as number) + (state[bodyBase(door!) + BODY.w] as number))).toBe(true);
    expect(((state[bodyBase(door!) + BODY.flags] as number) & FLAG.solid) !== 0).toBe(true);
    // Na dvorku nejsou buňky ani potrava arény.
    expect(bodiesOf(w, ROLE.enemy)).toHaveLength(0);
    expect(bodiesOf(w, ROLE.collectible)).toHaveLength(0);
  });

  it('spawning a role the game already builds (coin → collectible) makes a template of that kernel role', () => {
    const spec = read({ ...arenaFixture, rules: [{ id: 'sow', verb: 'sow', when: { every: 120 }, do: [{ spawn: { role: 'coin', at: 'player' } }] }] });
    const w = world(spec);
    const state = instantiate(w);
    // Předloha je jediná mrtvá mince na startu.
    const templates = bodiesOf(w, ROLE.collectible).filter((i) => ((state[bodyBase(i) + BODY.flags] as number) & FLAG.alive) === 0);
    expect(templates).toHaveLength(1);
  });

  it('refuses start:"hidden" on a role the game builds, with a reason the director can act on', () => {
    const made = arcadeWorldOf(read({ ...arenaFixture, things: [{ role: 'coin', start: 'hidden' }] }), 1);
    expect(made.ok).toBe(false);
    expect(made.ok ? [] : made.issues).toEqual([expect.stringContaining('role "coin" is built by the move_free game itself')]);
  });

  it('counts the built-in rules against the kernel limit and says how many the spec may add', () => {
    const rules = Array.from({ length: ARCADE_LIMITS.maxRules }, (_, i) => ({ id: `r${i}`, verb: 'tick', when: { every: 60 + i }, do: [{ score: 1 }] }));
    const made = arcadeWorldOf(read({ ...arenaFixture, rules }), 1);
    expect(made.ok).toBe(false);
    expect(made.ok ? '' : made.issues.join(' ')).toMatch(/already uses \d+ built-in rules, so the spec may add at most \d+ \(it has 16\)/);
  });

  it('refuses more than PAIR_RULES_MAX rules that scan contacts between two things', () => {
    const pair = (i: number) => ({ id: `p${i}`, verb: 'bump', when: { contact: ['coin', 'hunter'] }, do: [{ score: 1 }] });
    const ok = arcadeWorldOf(read({ ...arenaFixture, rules: Array.from({ length: PAIR_RULES_MAX }, (_, i) => pair(i)) }), 1);
    expect(ok.ok).toBe(true);
    const made = arcadeWorldOf(read({ ...arenaFixture, rules: Array.from({ length: PAIR_RULES_MAX + 1 }, (_, i) => pair(i)) }), 1);
    expect(made.ok ? [] : made.issues).toEqual([expect.stringContaining(`at most ${PAIR_RULES_MAX} may`)]);
  });

  it('a pair-contact rule checks at most PAIR_CHECKS_MAX pairs a tick, however many bodies overlap', () => {
    const made = world(read({ ...arenaFixture, rules: [{ id: 'bump', verb: 'bump', when: { contact: ['coin', 'hunter'] }, do: [{ score: 1 }] }] }));
    const ref = made.rules.find((r) => r.id === 'rule_tick')!;
    const [a, b] = (ref.params as { when: { contact: [number, number] } }).when.contact;
    // 40 × 40 = 1600 překrývajících se dvojic, všechny na jednom místě.
    const count = 80;
    const state = new Int32Array(stateSize(count));
    state[HEADER.bodyCount] = count;
    for (let i = 0; i < count; i += 1) {
      const base = bodyBase(i);
      state[base + BODY.role] = i < 40 ? a : b;
      state[base + BODY.flags] = FLAG.alive;
      state[base + BODY.w] = state[base + BODY.h] = state[base + BODY.d] = 100;
    }
    const effects = SPEC_RULES.rule_tick.fire({ state, player: -1, other: -1, source: -1, input: NO_INPUT }, ref.params as never);
    expect(effects.length).toBe(PAIR_CHECKS_MAX);
  });

  it('a press win and a loss later in the same tick end lost, as inside one apply; the press win alone stands', () => {
    const pressWin = { id: 'ring', verb: 'ring', when: { press: 'action' }, do: [{ win: true }] };
    const doom = { id: 'doom', verb: 'doom', when: { every: 1 }, do: [{ lose: true }] };
    const outcomeAfterPress = (rules: unknown[]): string => {
      const w = world(read({ ...runnerFixture, rules }));
      const state = instantiate(w);
      step(state, { buttons: BUTTON.TAP, axis: 0 }, loadProgram(w, ARCADE_LIBRARY));
      return outcomeOf(state);
    };
    expect(outcomeAfterPress([pressWin, doom])).toBe('lost');
    expect(outcomeAfterPress([pressWin])).toBe('won');
    // Jako před P29A: výhra z průchodu čítačů přepíše prohru dřívějšího průchodu téhož tiku.
    const scored = { id: 'scored', verb: 'score', when: { counter: { name: 'score', atLeast: 0 } }, do: [{ win: true }] };
    expect(outcomeAfterPress([doom, scored])).toBe('won');
  });

  it('the same spec and seed give the same world; the rule count stays inside the kernel limit', () => {
    const spec = read(yardSpec);
    expect(world(spec, 7)).toEqual(world(spec, 7));
    expect(world(spec, 7).rules.length).toBeLessThanOrEqual(ARCADE_LIMITS.maxRules);
  });
});
