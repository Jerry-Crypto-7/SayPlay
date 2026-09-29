/**
 * Pravidlo `interact` (P32G T1): hráč v dosahu cíle drží „Use“ a stav cíle se
 * posune o 1. Rozhoduje výhru úkolu bez dozoru a je v hashi, proto test hlídá
 * dosah, délku držení, krok právě o 1, konečný stav, pořadí a přehrání.
 */

import { describe, expect, it } from 'vitest';

import { type ArcadeEffect, type ArcadeLevel, type BodyInit, BUTTON, type InputEvent, NO_INPUT, ROLE, RUN_STATE, HEADER, UNIT, targetStateOf } from '../contract';
import { buildWorld, hashArcade, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import type { CompiledRule } from '../rules/compile';
import type { CompiledInteract } from '../rules/interact';

const PLAYER: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 1000, h: 600, d: 1000, solid: false };
const target = (x: number, z = 0): BodyInit => ({ role: 'target', kind: 'candle', x, y: 0, z, w: 600, h: 1000, d: 600, solid: false });

/** Hráč v počátku; cíle na ose x (metry = vzdálenost středů). */
function world(targets: readonly BodyInit[], when: Partial<CompiledInteract> = {}, rule: Partial<CompiledRule> = {}) {
  const params: CompiledRule = {
    id: 'light',
    verb: 'light',
    when: { interact: { role: ROLE.target, radius: 1000, hold: 30, states: 3, ...when } },
    if: [],
    do: [],
    ...rule,
  };
  const level: ArcadeLevel = { bodies: [PLAYER, ...targets], length: 0 };
  const built = buildWorld({ seed: 1, control: { id: 'move_free', params: {} }, rules: [{ id: 'interact', params }], bot: { id: 'quest_bot', params: {} }, level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

type Plan = readonly (readonly [ticks: number, buttons: number])[];

/** Odehraje plán (úseky tiků s tlačítky); vrátí stav a všechny efekty. */
function play(w: ReturnType<typeof world>, plan: Plan) {
  const state = instantiate(w);
  const program = loadProgram(w, ARCADE_LIBRARY);
  const effects: ArcadeEffect[] = [];
  for (const [ticks, buttons] of plan) {
    for (let k = 0; k < ticks; k += 1) effects.push(...step(state, buttons === 0 ? NO_INPUT : { buttons, axis: 0 }, program));
  }
  return { state, effects };
}

const USE = BUTTON.INTERACT;
const changes = (effects: readonly ArcadeEffect[]) => effects.filter((effect) => effect.kind === 'stateChange');

describe('interact rule', () => {
  it('does nothing out of range, however long the player holds Use', () => {
    // Obrysy 1,2 m od sebe, dosah 1 m.
    const { state, effects } = play(world([target(2000)]), [[120, USE]]);
    expect(targetStateOf(state, 1)).toBe(0);
    expect(changes(effects)).toEqual([]);
  });

  it('does nothing for a press shorter than hold, and releasing throws the work away', () => {
    const { state } = play(world([target(1500)]), [
      [29, USE],
      [1, 0],
      [29, USE],
      [5, 0],
    ]);
    expect(targetStateOf(state, 1)).toBe(0);
  });

  it('holding for hold ticks moves the target exactly one state, and holding on does not move it again', () => {
    const short = play(world([target(1500)]), [[29, USE]]);
    expect(targetStateOf(short.state, 1)).toBe(0);
    const { state, effects } = play(world([target(1500)]), [[90, USE]]);
    expect(targetStateOf(state, 1)).toBe(1);
    expect(changes(effects)).toEqual([{ kind: 'stateChange', body: 1, state: 1 }]);
  });

  it('a second hold after a release moves it once more, and the final state holds', () => {
    const { state, effects } = play(world([target(1500)]), [
      [30, USE],
      [1, 0],
      [30, USE],
      [1, 0],
      [60, USE],
    ]);
    expect(changes(effects).map((effect) => (effect.kind === 'stateChange' ? effect.state : -1))).toEqual([1, 2]);
    expect(targetStateOf(state, 1)).toBe(2);
    expect(state[HEADER.runState]).toBe(RUN_STATE.won);
  });

  it('with two states the first step is final: do effects fire and the last target wins', () => {
    const w = world([target(1500), target(-1500)], { states: 2 }, { do: [{ score: 5 }] });
    const first = play(w, [[30, USE]]);
    expect(changes(first.effects)).toEqual([{ kind: 'stateChange', body: 1, state: 1 }]);
    expect(first.state[HEADER.counters]).toBe(5);
    expect(first.state[HEADER.runState]).toBe(RUN_STATE.running);
    // Dál držet: první cíl je hotový, druhý (stejně daleko, vyšší index) se rozdělá bez puštění.
    const both = play(w, [[60, USE]]);
    expect(changes(both.effects).map((effect) => (effect.kind === 'stateChange' ? effect.body : -1))).toEqual([1, 2]);
    expect(both.state[HEADER.runState]).toBe(RUN_STATE.won);
  });

  it('hold 0 moves the state on the first tick of a press and waits for the release', () => {
    const { effects } = play(world([target(1500)], { hold: 0 }), [
      [10, USE],
      [1, 0],
      [1, USE],
    ]);
    expect(changes(effects).map((effect) => (effect.kind === 'stateChange' ? effect.state : -1))).toEqual([1, 2]);
  });

  it('order refuses a target out of turn and takes the next one in turn', () => {
    // Cíl 1 je daleko, hráč stojí u cíle 2: s pořadím nic, bez pořadí se posune.
    const plan: Plan = [[40, USE]];
    const ordered = play(world([target(8000), target(1500)], { order: true }), plan);
    expect(changes(ordered.effects)).toEqual([]);
    const loose = play(world([target(8000), target(1500)]), plan);
    expect(changes(loose.effects)).toEqual([{ kind: 'stateChange', body: 2, state: 1 }]);
    // Když je první v pořadí hotový, na řadě je druhý.
    const next = play(world([target(-1500), target(1500)], { order: true, states: 2 }), [[70, USE]]);
    expect(changes(next.effects).map((effect) => (effect.kind === 'stateChange' ? effect.body : -1))).toEqual([1, 2]);
  });

  it('the replay hash is stable and the state change is in it', () => {
    const w = world([target(1500), target(0, 3 * UNIT)]);
    const inputs: InputEvent[] = Array.from({ length: 30 }, (_, tick) => ({ tick, buttons: USE, axis: 0 }));
    const a = replay(w, inputs, ARCADE_LIBRARY, 120);
    const b = replay(w, inputs, ARCADE_LIBRARY, 120);
    expect(a.hash).toBe(b.hash);
    const idle = replay(w, [], ARCADE_LIBRARY, 120);
    expect(a.hash).not.toBe(idle.hash);
    const { state } = play(w, [
      [30, USE],
      [90, 0],
    ]);
    expect(hashArcade(state)).toBe(a.hash);
  });
});
