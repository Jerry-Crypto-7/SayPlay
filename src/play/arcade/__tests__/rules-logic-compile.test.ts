/**
 * Snížení logiky ze specu na kusy jádra (P45B T5): 5 spouštěčů, 4 podmínky a 7 efektů bloku
 * `logic` = 16 kostek. Kostka, která vystřelí, ale míří na špatný index, projde testem
 * existence – proto každý test postaví malý svět ze specu, pustí skutečný `step` a jmenuje
 * slot, který se změnil, a na kolik (proměnná `lives` = index 1: 3 → 2, fáze 0 → 2, časovač 1 = 40).
 * Deklarace mají vždy víc jmen, než test čte, aby záměna indexů padla.
 */
import { describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '@/play/spec';

import arenaFixture from '../__fixtures__/arena.json';
import runnerFixture from '../__fixtures__/runner.json';
import { arcadeWorldOf } from '../compile';
import {
  ARCADE_LIMITS,
  ARCADE_RUNTIME_V2,
  ARCADE_RUNTIME_VERSION,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeWorld,
  BODY,
  type BodyInit,
  BUTTON,
  FLAG,
  HEADER,
  LOGIC_BODIES,
  LOGIC_SLOTS,
  NO_INPUT,
  ROLE,
  bodyBase,
  logicBase,
  phaseOf,
  timerLeft,
  varValue,
} from '../contract';
import { hashArcade, instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { RULE_SPAWN_SLOTS, WAVE_GAP, WAVE_RING, YARD, compileRules } from '../rules/compile';

function read(input: unknown): GameSpecV1 {
  const result = readGameSpec(input);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.value;
}

const ROLES = [
  { id: 'player', kind: 'player', label: 'knight' },
  { id: 'exit', kind: 'exit', label: 'tower stairs' },
  { id: 'bat', kind: 'chaser', label: 'bat' },
  { id: 'gem', kind: 'collectible', label: 'gem' },
  { id: 'door', kind: 'door', label: 'castle door' },
];
/** Výhra dvorku (pravidlo 0): schody stojí vzadu, hráč na startu – nečinný běh je nedosáhne. */
const FINISH = { id: 'finish', verb: 'finish', when: { contact: ['player', 'exit'] }, do: [{ win: true }] };

/** Dvorek ze specu: pravidla `rules` jsou ve specu od indexu 1 (bit západky = index pravidla). */
function yard(logic: unknown, rules: readonly unknown[]): GameSpecV1 {
  return read({ ...arenaFixture, controlParams: {}, mechanics: [], roles: ROLES, ...(logic === undefined ? {} : { logic }), rules: [FINISH, ...rules] });
}

function made(spec: GameSpecV1, seed = 1): ArcadeWorld {
  const result = arcadeWorldOf(spec, seed);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.world;
}

const TAP: ArcadeInput = { buttons: BUTTON.TAP, axis: 0 };
const ALT: ArcadeInput = { buttons: BUTTON.FIRE, axis: 0 };

const vars = (state: Int32Array): number[] => Array.from({ length: 8 }, (_, i) => varValue(state, logicBase(state), i));
const timers = (state: Int32Array): number[] => [0, 1, 2, 3].map((t) => timerLeft(state, logicBase(state), t));

/** Pustí `ticks` tiků se stisky `presses[tik]`; po každém tiku zapíše proměnné, fázi a časovače. */
function play(world: ArcadeWorld, ticks: number, presses: Readonly<Record<number, ArcadeInput>> = {}) {
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const history: { vars: number[]; phase: number; timers: number[] }[] = [];
  for (let t = 0; t < ticks; t += 1) {
    step(state, presses[t] ?? NO_INPUT, program);
    history.push({ vars: vars(state), phase: phaseOf(state, logicBase(state)), timers: timers(state) });
  }
  return { state, history };
}

/** Tiky, ve kterých se proměnná `index` změnila, s hodnotou po změně. */
function changes(history: readonly { vars: number[] }[], index: number, start = 0): [tick: number, value: number][] {
  const out: [number, number][] = [];
  let before = start;
  history.forEach(({ vars: now }, t) => {
    if (now[index] !== before) out.push([t, now[index] as number]);
    before = now[index] as number;
  });
  return out;
}

const press = (id: string, button: 'action' | 'alt', effects: readonly unknown[], conditions?: readonly unknown[]) => ({
  id,
  verb: 'press',
  when: { press: button },
  ...(conditions === undefined ? {} : { if: conditions }),
  do: effects,
});

describe('logic triggers', () => {
  it('when.timer: a timer started in tick 5 for 30 ticks fires its rule once, in tick 35 – var rang (index 1) 0 → 1', () => {
    const world = made(
      yard({ vars: [{ id: 'spare' }, { id: 'rang' }], timers: [{ id: 'fuse' }, { id: 'clock' }] }, [
        press('arm', 'action', [{ startTimer: { timer: 'clock', ticks: 30 } }]),
        press('light', 'alt', [{ startTimer: { timer: 'fuse', ticks: 600 } }]),
        { id: 'ring', verb: 'ring', when: { timer: 'clock' }, do: [{ add: { var: 'rang', amount: 1 } }] },
      ]),
    );
    const { history } = play(world, 60, { 5: TAP });
    expect(changes(history, 1)).toEqual([[35, 1]]);
    expect(changes(history, 0)).toEqual([]);
    expect(history[5]!.timers).toEqual([0, 30, 0, 0]);
  });

  it('when.phase: entering rush (index 1) in tick 3 sets var entered (index 0) 0 → 7; the start phase entry in tick 0 does not', () => {
    const world = made(
      yard({ vars: [{ id: 'entered' }, { id: 'left' }], phases: [{ id: 'calm' }, { id: 'rush' }, { id: 'final' }] }, [
        press('go', 'action', [{ goPhase: 'rush' }]),
        press('end', 'alt', [{ goPhase: 'final' }]),
        { id: 'enter', verb: 'enter', when: { phase: 'rush' }, do: [{ set: { var: 'entered', value: 7 } }] },
        { id: 'leave', verb: 'leave', when: { phaseExit: 'calm' }, do: [{ add: { var: 'left', amount: 2 } }] },
      ]),
    );
    const { history } = play(world, 12, { 3: TAP, 6: ALT });
    expect(history.map((h) => h.phase)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(changes(history, 0)).toEqual([[3, 7]]);
  });

  it('when.phaseExit: leaving calm (index 0) in tick 3 adds 2 to var left (index 1) once; leaving rush later does not', () => {
    const world = made(
      yard({ vars: [{ id: 'entered' }, { id: 'left' }], phases: [{ id: 'calm' }, { id: 'rush' }, { id: 'final' }] }, [
        press('go', 'action', [{ goPhase: 'rush' }]),
        press('end', 'alt', [{ goPhase: 'final' }]),
        { id: 'leave', verb: 'leave', when: { phaseExit: 'calm' }, do: [{ add: { var: 'left', amount: 2 } }] },
      ]),
    );
    const { history } = play(world, 12, { 3: TAP, 6: ALT });
    expect(changes(history, 1)).toEqual([[3, 2]]);
    expect(changes(history, 0)).toEqual([]);
  });

  it('when.var: lives (index 1) below 2 fires once per crossing – alarms (index 0) 0 → 1 in tick 4, again 1 → 2 only after lives went back up', () => {
    const world = made(
      yard({ vars: [{ id: 'alarms' }, { id: 'lives', start: 3 }] }, [
        press('hurt', 'action', [{ add: { var: 'lives', amount: -1 } }]),
        press('heal', 'alt', [{ add: { var: 'lives', amount: 3 } }]),
        { id: 'alarm', verb: 'alarm', when: { var: { name: 'lives', below: 2 } }, do: [{ add: { var: 'alarms', amount: 1 } }] },
      ]),
    );
    const { history, state } = play(world, 16, { 2: TAP, 4: TAP, 6: TAP, 8: ALT, 10: TAP, 12: TAP });
    expect(changes(history, 1, 3)).toEqual([
      [2, 2],
      [4, 1],
      [6, 0],
      [8, 3],
      [10, 2],
      [12, 1],
    ]);
    expect(changes(history, 0)).toEqual([
      [4, 1],
      [12, 2],
    ]);
    // Západka je bit pravidla „alarm“ (index 3 ve specu) a po hře je zaklapnutá.
    expect(state[logicBase(state) + LOGIC_SLOTS.varLatch]).toBe(1 << 3);
  });

  it('when.event: emitting alarm (index 1) in tick 4 adds 5 to var alarms (index 1) the same tick; ping (index 0) stays silent until sent', () => {
    const world = made(
      yard({ vars: [{ id: 'pings' }, { id: 'alarms' }], events: ['ping', 'alarm'] }, [
        press('shout', 'action', [{ emit: 'alarm' }]),
        press('knock', 'alt', [{ emit: 'ping' }]),
        { id: 'hear', verb: 'hear', when: { event: 'alarm' }, do: [{ add: { var: 'alarms', amount: 5 } }] },
        { id: 'answer', verb: 'answer', when: { event: 'ping' }, do: [{ add: { var: 'pings', amount: 1 } }] },
      ]),
    );
    const { history } = play(world, 10, { 4: TAP, 7: ALT });
    expect(changes(history, 1)).toEqual([[4, 5]]);
    expect(changes(history, 0)).toEqual([[7, 1]]);
  });
});

describe('logic conditions', () => {
  it('if.var: atLeast 2 and below 1 on var keys (index 1) gate the press – out (index 0) 0 → 4 in tick 5, early (index 2) 0 → 1 in tick 1', () => {
    const world = made(
      yard({ vars: [{ id: 'out' }, { id: 'keys' }, { id: 'early' }] }, [
        press('find', 'alt', [{ add: { var: 'keys', amount: 1 } }]),
        press('open', 'action', [{ set: { var: 'out', value: 4 } }], [{ var: { name: 'keys', atLeast: 2 } }]),
        press('rush', 'action', [{ add: { var: 'early', amount: 1 } }], [{ var: { name: 'keys', below: 1 } }]),
      ]),
    );
    const { history } = play(world, 8, { 1: TAP, 2: ALT, 3: TAP, 4: ALT, 5: TAP });
    expect(changes(history, 1)).toEqual([
      [2, 1],
      [4, 2],
    ]);
    expect(changes(history, 0)).toEqual([[5, 4]]);
    expect(changes(history, 2)).toEqual([[1, 1]]);
  });

  it('if.inPhase: the press counts only in rush (index 1) – n (index 0) 0 → 1 in tick 3, not in calm in tick 1', () => {
    const world = made(
      yard({ vars: [{ id: 'n' }], phases: [{ id: 'calm' }, { id: 'rush' }] }, [
        press('go', 'alt', [{ goPhase: 'rush' }]),
        press('count', 'action', [{ add: { var: 'n', amount: 1 } }], [{ inPhase: 'rush' }]),
      ]),
    );
    const { history } = play(world, 6, { 1: TAP, 2: ALT, 3: TAP });
    expect(changes(history, 0)).toEqual([[3, 1]]);
  });

  it('if.timerRunning: the press counts only while clock (index 1) runs – running (index 0) 0 → 1 in tick 3', () => {
    const world = made(
      yard({ vars: [{ id: 'running' }, { id: 'stopped' }], timers: [{ id: 'fuse' }, { id: 'clock' }] }, [
        press('arm', 'alt', [{ startTimer: { timer: 'clock', ticks: 10 } }]),
        { id: 'light', verb: 'light', when: { every: ARCADE_LIMITS.maxTicks }, do: [{ startTimer: { timer: 'fuse', ticks: 1 } }] },
        press('check', 'action', [{ add: { var: 'running', amount: 1 } }], [{ timerRunning: 'clock' }]),
      ]),
    );
    const { history } = play(world, 25, { 1: TAP, 2: ALT, 3: TAP, 20: TAP });
    expect(changes(history, 0)).toEqual([[3, 1]]);
    expect(history[2]!.timers).toEqual([0, 10, 0, 0]);
  });

  it('if.timerStopped: the press counts only while clock (index 1) stands – stopped (index 1) 0 → 1 in tick 1, 1 → 2 in tick 20 after it ran out', () => {
    const world = made(
      yard({ vars: [{ id: 'running' }, { id: 'stopped' }], timers: [{ id: 'fuse' }, { id: 'clock' }] }, [
        press('arm', 'alt', [{ startTimer: { timer: 'clock', ticks: 10 } }]),
        { id: 'light', verb: 'light', when: { every: ARCADE_LIMITS.maxTicks }, do: [{ startTimer: { timer: 'fuse', ticks: 1 } }] },
        press('check', 'action', [{ add: { var: 'stopped', amount: 1 } }], [{ timerStopped: 'clock' }]),
      ]),
    );
    const { history } = play(world, 25, { 1: TAP, 2: ALT, 3: TAP, 20: TAP });
    expect(changes(history, 1)).toEqual([
      [1, 1],
      [20, 2],
    ]);
    expect(history[12]!.timers[1]).toBe(0);
  });
});

describe('logic effects', () => {
  it('set: var b (index 1) 3 → 8, var a (index 0) stays 1', () => {
    const world = made(yard({ vars: [{ id: 'a', start: 1 }, { id: 'b', start: 3 }] }, [press('fix', 'action', [{ set: { var: 'b', value: 8 } }])]));
    const { history } = play(world, 4, { 2: TAP });
    expect(history[1]!.vars.slice(0, 2)).toEqual([1, 3]);
    expect(changes(history, 1, 3)).toEqual([[2, 8]]);
    expect(changes(history, 0, 1)).toEqual([]);
  });

  it('add: var lives (index 1) 3 → 2 per press, var a (index 0) stays 0', () => {
    const world = made(yard({ vars: [{ id: 'a' }, { id: 'lives', start: 3 }] }, [press('hurt', 'action', [{ add: { var: 'lives', amount: -1 } }])]));
    const { history } = play(world, 6, { 2: TAP, 4: TAP });
    expect(changes(history, 1, 3)).toEqual([
      [2, 2],
      [4, 1],
    ]);
    expect(changes(history, 0)).toEqual([]);
  });

  it('goPhase: phase 0 → 2 (final) in tick 2, entry tick recorded', () => {
    const world = made(
      yard({ phases: [{ id: 'calm' }, { id: 'rush' }, { id: 'final' }] }, [press('end', 'action', [{ goPhase: 'final' }]), press('go', 'alt', [{ goPhase: 'rush' }])]),
    );
    const { history, state } = play(world, 5, { 2: TAP });
    expect(history.map((h) => h.phase)).toEqual([0, 0, 2, 2, 2]);
    expect(state[logicBase(state) + LOGIC_SLOTS.phaseTick]).toBe(2);
  });

  it('startTimer: clock (index 1) holds 40 after tick 5 and 39 after tick 6; fuse (index 0) stays 0', () => {
    const world = made(
      yard({ timers: [{ id: 'fuse' }, { id: 'clock' }] }, [
        press('arm', 'action', [{ startTimer: { timer: 'clock', ticks: 40 } }]),
        press('light', 'alt', [{ startTimer: { timer: 'fuse', ticks: 5 } }]),
      ]),
    );
    const { history } = play(world, 8, { 5: TAP });
    expect(history[4]!.timers).toEqual([0, 0, 0, 0]);
    expect(history[5]!.timers).toEqual([0, 40, 0, 0]);
    expect(history[6]!.timers).toEqual([0, 39, 0, 0]);
  });

  it('stopTimer: clock (index 1) 37 → 0 in tick 5 and its timer rule never fires – rang (index 0) stays 0', () => {
    const world = made(
      yard({ vars: [{ id: 'rang' }], timers: [{ id: 'fuse' }, { id: 'clock' }] }, [
        press('arm', 'alt', [{ startTimer: { timer: 'clock', ticks: 40 } }]),
        press('halt', 'action', [{ stopTimer: 'clock' }]),
        { id: 'light', verb: 'light', when: { every: ARCADE_LIMITS.maxTicks }, do: [{ startTimer: { timer: 'fuse', ticks: 1 } }] },
        { id: 'ring', verb: 'ring', when: { timer: 'clock' }, do: [{ add: { var: 'rang', amount: 1 } }] },
      ]),
    );
    const { history } = play(world, 60, { 1: ALT, 5: TAP });
    expect(history[4]!.timers[1]).toBe(37);
    expect(history[5]!.timers[1]).toBe(0);
    expect(changes(history, 0)).toEqual([]);
  });

  it('emit: alarm (index 1) sent from the event pass fires its listener the next tick – heard (index 1) 0 → 1 in tick 4', () => {
    const world = made(
      yard({ vars: [{ id: 'pinged' }, { id: 'heard' }], events: ['ping', 'alarm'] }, [
        press('knock', 'alt', [{ emit: 'ping' }]),
        { id: 'relay', verb: 'relay', when: { event: 'ping' }, do: [{ add: { var: 'pinged', amount: 1 } }, { emit: 'alarm' }] },
        { id: 'hear', verb: 'hear', when: { event: 'alarm' }, do: [{ add: { var: 'heard', amount: 1 } }] },
      ]),
    );
    const { history } = play(world, 8, { 3: ALT });
    expect(changes(history, 0)).toEqual([[3, 1]]);
    expect(changes(history, 1)).toEqual([[4, 1]]);
  });
});

// ---------------------------------------------------------------------------
// Vlny

const at = (state: Int32Array, body: number): [number, number] => [state[bodyBase(body) + BODY.x] as number, state[bodyBase(body) + BODY.z] as number];

/** Živá těla modelu `kind` od `spawnBase` (těla vln a spawnu). */
function spawnedOf(world: ArcadeWorld, state: Int32Array, kind: string): number[] {
  const code = world.kinds.indexOf(kind);
  const out: number[] = [];
  for (let i = state[HEADER.spawnBase] as number; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.kind] === code && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) out.push(i);
  }
  return out;
}

const wavePress = (count: number, where: 'edge' | 'player', button: 'action' | 'alt' = 'action') => press(`wave_${where}`, button, [{ wave: { role: 'bat', count, at: where } }]);
const spawnsOf = (effects: readonly ArcadeEffect[]) => effects.filter((effect): effect is Extract<ArcadeEffect, { kind: 'spawn' }> => effect.kind === 'spawn');

/** Obrys `w × d` na `x, z` se překrývá s tělem `body` (rozšířeným o `gap` na každou stranu)? */
function overlaps(state: Int32Array, body: number, x: number, z: number, w: number, d: number, gap = 0): boolean {
  const base = bodyBase(body);
  return (
    Math.abs(x - (state[base + BODY.x] as number)) * 2 < w + (state[base + BODY.w] as number) + 2 * gap &&
    Math.abs(z - (state[base + BODY.z] as number)) * 2 < d + (state[base + BODY.d] as number) + 2 * gap
  );
}

/** Živá pevná tělesa kromě hráče – zeď dvorku a dveře v ní. */
function solids(state: Int32Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (((state[bodyBase(i) + BODY.flags] as number) & (FLAG.alive | FLAG.solid)) === (FLAG.alive | FLAG.solid)) out.push(i);
  }
  return out;
}

describe('wave', () => {
  it('at player: 4 bats on the 3 m ring, one per quarter – the role (template) gains exactly 4 live bodies', () => {
    const world = made(yard(undefined, [wavePress(4, 'player')]));
    const { state } = play(world, 3, { 2: TAP });
    const [px, pz] = at(state, 0);
    const bats = spawnedOf(world, state, 'thing:bat');
    expect(bats.map((b) => at(state, b))).toEqual([
      [px + WAVE_RING, pz],
      [px, pz + WAVE_RING],
      [px - WAVE_RING, pz],
      [px, pz - WAVE_RING],
    ]);
    // Kopie předlohy role „bat“: tvar honiče (0,8 × 1,6 × 0,8 m), role věci pravidel.
    for (const b of bats) expect([state[bodyBase(b) + BODY.w], state[bodyBase(b) + BODY.h], state[bodyBase(b) + BODY.role]]).toEqual([800, 1600, state[bodyBase(bats[0]!) + BODY.role]]);
    expect(state[bodyBase(bats[0]!) + BODY.role]).toBeGreaterThanOrEqual(32);
  });

  it('at edge: 4 bats at the four corners of the yard, inset by half a bat and the gap', () => {
    const world = made(yard(undefined, [wavePress(4, 'edge')]));
    const { state } = play(world, 3, { 2: TAP });
    const e = YARD.half - 400 - WAVE_GAP;
    expect(spawnedOf(world, state, 'thing:bat').map((b) => at(state, b))).toEqual([
      [-e, -e],
      [e, -e],
      [e, e],
      [-e, e],
    ]);
  });

  it('at other: touching the gem raises 2 bats 3 m left and right of the gem', () => {
    const world = made(
      yard(undefined, [{ id: 'trap', verb: 'trap', when: { contact: ['player', 'gem'] }, do: [{ wave: { role: 'bat', count: 2, at: 'other' } }, { despawn: 'other' }] }]),
    );
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const gem = world.kinds.indexOf('thing:gem');
    let body = -1;
    for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) if (state[bodyBase(i) + BODY.kind] === gem) body = i;
    const [gx, gz] = at(state, body);
    state[bodyBase(0) + BODY.x] = gx;
    state[bodyBase(0) + BODY.z] = gz;
    step(state, NO_INPUT, program);
    expect(spawnedOf(world, state, 'thing:bat').map((b) => at(state, b))).toEqual([
      [gx + WAVE_RING, gz],
      [gx - WAVE_RING, gz],
    ]);
    expect(((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) === 0).toBe(true);
  });

  it('two compilations with the same seed put the wave on the same spots, tick for tick', () => {
    const spec = yard(undefined, [
      { id: 'trap', verb: 'trap', when: { contact: ['player', 'gem'] }, do: [{ wave: { role: 'bat', count: 8, at: 'other' } }, { despawn: 'other' }] },
      wavePress(8, 'edge', 'alt'),
    ]);
    const runOnce = () => {
      const world = made(spec, 7);
      const state = instantiate(world);
      const program = loadProgram(world, ARCADE_LIBRARY);
      const gem = world.kinds.indexOf('thing:gem');
      for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
        if (state[bodyBase(i) + BODY.kind] === gem) [state[bodyBase(0) + BODY.x], state[bodyBase(0) + BODY.z]] = at(state, i);
      }
      const hashes: string[] = [];
      for (let t = 0; t < 6; t += 1) {
        step(state, t === 3 ? ALT : NO_INPUT, program);
        hashes.push(hashArcade(state));
      }
      return { hashes, spots: spawnedOf(world, state, 'thing:bat').map((b) => at(state, b)) };
    };
    const first = runOnce();
    expect(first.spots.length).toBeGreaterThanOrEqual(8);
    expect(runOnce()).toEqual(first);
  });

  describe('never into the yard wall, never on the player', () => {
    // Zeď s dveřmi: role, kterou pravidlo přepíná, stojí v mezeře zdi napříč dvorkem.
    const spec = yard(undefined, [{ id: 'open', verb: 'open', when: { contact: ['player', 'door'] }, do: [{ toggle: 'door' }] }, wavePress(8, 'player'), wavePress(8, 'edge', 'alt')]);
    const world = made(spec);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const bat = { w: 800, d: 800 };

    /** Postaví hráče na `x, z`, odpálí vlnu a vrátí stav a místa, která vlna vydala. */
    function fire(x: number, z: number, input: ArcadeInput) {
      const state = instantiate(world);
      state[bodyBase(0) + BODY.x] = x;
      state[bodyBase(0) + BODY.z] = z;
      return { state, spots: spawnsOf(step(state, input, program)) };
    }

    it('the yard has its wall: two fences and the door across it', () => {
      const state = instantiate(world);
      expect(solids(state).filter((i) => state[bodyBase(i) + BODY.role] === ROLE.obstacle)).toHaveLength(2);
      expect(solids(state).every((i) => state[bodyBase(i) + BODY.z] === YARD.wallZ)).toBe(true);
    });

    it('a ring next to the wall skips the spots inside it and keeps clear of the player', () => {
      let skipped = 0;
      for (let x = -11_000; x <= 11_000; x += 1000) {
        for (const dz of [-3000, -2000, -1500, 1500, 2000, 3000]) {
          const z = YARD.wallZ + dz;
          const { state, spots } = fire(x, z, TAP);
          const walls = solids(state);
          expect(spots.length).toBeGreaterThan(0);
          expect(spots.length).toBeLessThanOrEqual(8);
          for (const spot of spots) {
            expect(walls.filter((wall) => overlaps(state, wall, spot.x, spot.z, bat.w, bat.d)), `${x},${z} → ${spot.x},${spot.z}`).toEqual([]);
            expect(overlaps(state, 0, spot.x, spot.z, bat.w, bat.d, WAVE_GAP)).toBe(false);
          }
          // Místo rovně proti zdi by v ní stálo: vlna ho vynechá.
          const ahead = { x, z: z - Math.sign(dz) * WAVE_RING };
          if (walls.some((wall) => overlaps(state, wall, ahead.x, ahead.z, bat.w, bat.d))) {
            skipped += 1;
            expect(spots.some((spot) => spot.x === ahead.x && spot.z === ahead.z)).toBe(false);
          }
        }
      }
      expect(skipped).toBeGreaterThan(10);
    });

    it('an edge wave with the player standing on its spots skips those spots and still raises 8 bats', () => {
      const e = YARD.half - 400 - WAVE_GAP;
      for (const [x, z] of [
        [-e, -e],
        [0, -e],
        [e, -e],
        [e, 0],
        [e, e],
        [-e, e],
        [-e, 0],
      ] as const) {
        const { state, spots } = fire(x, z, ALT);
        expect(spots).toHaveLength(8);
        for (const spot of spots) {
          expect(overlaps(state, 0, spot.x, spot.z, bat.w, bat.d, WAVE_GAP), `${x},${z} → ${spot.x},${spot.z}`).toBe(false);
          expect(solids(state).filter((wall) => overlaps(state, wall, spot.x, spot.z, bat.w, bat.d))).toEqual([]);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Svět

describe('compileRules lays out logic, templates and spawn slots', () => {
  const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 1000, h: 1000, d: 1000, solid: false };

  it('a spec with logic builds an arcade-v3 world with two logic bodies holding the start values, phase 0', () => {
    const world = made(
      yard({ vars: [{ id: 'a', start: -4 }, { id: 'lives', start: 3 }], phases: [{ id: 'calm' }, { id: 'rush' }] }, [press('go', 'action', [{ goPhase: 'rush' }])]),
    );
    expect(world.runtimeVersion).toBe(ARCADE_RUNTIME_VERSION);
    const state = instantiate(world);
    const levelBodies = (state[HEADER.spawnBase] as number) - LOGIC_BODIES;
    // Jména deklarace jdou se světem pro ověření (T7).
    expect(world.logic).toEqual({ bodies: [levelBodies, levelBodies + 1], names: { var: ['a', 'lives'], timer: [], phase: ['calm', 'rush'], event: [] } });
    expect(vars(state)).toEqual([-4, 3, 0, 0, 0, 0, 0, 0]);
    expect(phaseOf(state, logicBase(state))).toBe(0);
    // Počáteční fáze čeká na vstup v tiku 0.
    expect(state[logicBase(state) + LOGIC_SLOTS.phasePending]).toBe(1);
  });

  it('a spec without logic stays arcade-v2 without logic bodies, even with a wave', () => {
    const world = made(yard(undefined, [wavePress(3, 'player')]));
    expect(world.runtimeVersion).toBe(ARCADE_RUNTIME_V2);
    expect(world.logic).toBeUndefined();
    expect(world.initial[HEADER.spawnBase]).toBe(world.initial[HEADER.bodyCount]);
  });

  it('spawn slots = RULE_SPAWN_SLOTS + the bodies of every wave, one template per role', () => {
    const spec = yard({ vars: [{ id: 'n' }] }, [
      press('swarm', 'action', [{ wave: { role: 'bat', count: 3, at: 'player' } }, { add: { var: 'n', amount: 1 } }]),
      press('flood', 'alt', [{ wave: { role: 'bat', count: 5, at: 'edge' } }, { spawn: { role: 'gem', at: 'player' } }]),
    ]);
    const compiled = compileRules(spec, { bodies: [player], length: 0 }, 1, YARD.half);
    expect(compiled.issues).toEqual([]);
    expect(compiled.level.spawnSlots).toBe(RULE_SPAWN_SLOTS + 3 + 5);
    expect(compiled.logic).toEqual({ vars: [0], phases: 0 });
    const templates = compiled.level.bodies.filter((body) => body.template === true).map((body) => body.kind);
    expect(templates).toEqual(['thing:bat', 'thing:gem']);
  });

  it('spawn slots stop at the body limit, leaving room for the logic bodies', () => {
    const filler = Array.from({ length: 240 }, (_, i): BodyInit => ({ role: 'obstacle', kind: 'rock', x: i * 2000, y: 0, z: 50_000, w: 100, h: 100, d: 100, solid: false }));
    const spec = yard({ vars: [{ id: 'n' }] }, [press('swarm', 'action', [{ wave: { role: 'bat', count: 8, at: 'player' } }, { add: { var: 'n', amount: 1 } }])]);
    const compiled = compileRules(spec, { bodies: [player, ...filler], length: 0 }, 1, YARD.half);
    expect(compiled.level.bodies.length + LOGIC_BODIES + (compiled.level.spawnSlots ?? 0)).toBe(ARCADE_LIMITS.maxBodies);
  });

  it('an edge wave in a game without a floor (runner) is refused with a reason the director can act on', () => {
    const spec = read({ ...runnerFixture, rules: [{ id: 'flood', verb: 'flood', when: { press: 'action' }, do: [{ wave: { role: 'coin', count: 3, at: 'edge' } }] }] });
    const result = arcadeWorldOf(spec, 1);
    expect(result.ok ? [] : result.issues).toEqual(['/rules/0/do/0/wave/at: "edge" needs a floor with edges (free movement in a yard or an arena) – use "player" or "other"']);
  });

  it('every new construct lowers to names-as-indices in the compiled rule params', () => {
    const world = made(
      yard({ vars: [{ id: 'a' }, { id: 'b' }], timers: [{ id: 'f' }, { id: 'c' }], phases: [{ id: 'p0' }, { id: 'p1' }], events: ['e0', 'e1'] }, [
        {
          id: 'all',
          verb: 'all',
          when: { var: { name: 'b', atLeast: 2 } },
          if: [{ var: { name: 'b', below: 9 } }, { inPhase: 'p1' }, { timerRunning: 'c' }, { timerStopped: 'f' }],
          do: [{ set: { var: 'b', value: 1 } }, { add: { var: 'b', amount: 2 } }, { goPhase: 'p1' }, { startTimer: { timer: 'c', ticks: 9 } }, { stopTimer: 'c' }, { emit: 'e1' }],
        },
        { id: 'ft', verb: 'ft', when: { timer: 'c' }, do: [{ startTimer: { timer: 'f', ticks: 3 } }, { emit: 'e0' }] },
        { id: 'pe', verb: 'pe', when: { phase: 'p1' }, do: [{ wave: { role: 'bat', count: 2, at: 'edge' } }] },
        { id: 'px', verb: 'px', when: { phaseExit: 'p1' }, do: [{ score: 1 }] },
        { id: 'ev', verb: 'ev', when: { event: 'e1' }, do: [{ score: 1 }] },
        { id: 'ev0', verb: 'ev', when: { event: 'e0' }, do: [{ score: 1 }] },
      ]),
    );
    const params = (rule: string) => world.rules.find((ref) => (ref.params as { id?: string }).id === rule)!;
    expect(params('all')).toMatchObject({
      id: 'rule_counter',
      params: {
        when: { var: { index: 1, atLeast: 2, latch: 1 } },
        if: [{ var: { index: 1, below: 9 } }, { inPhase: 1 }, { timerRunning: 1 }, { timerStopped: 0 }],
        do: [{ set: { var: 1, value: 1 } }, { add: { var: 1, amount: 2 } }, { goPhase: 1 }, { startTimer: { timer: 1, ticks: 9 } }, { stopTimer: 1 }, { emit: 1 }],
      },
    });
    expect(params('ft')).toMatchObject({ id: 'rule_timer', params: { when: { timer: 1 } } });
    expect(params('pe')).toMatchObject({ id: 'rule_phase', params: { when: { phase: 1 }, do: [{ wave: { count: 2, at: 'edge', floor: YARD.half } }] } });
    expect(params('px')).toMatchObject({ id: 'rule_phase', params: { when: { phaseExit: 1 } } });
    expect(params('ev')).toMatchObject({ id: 'rule_event', params: { when: { event: 1 } } });
    expect(params('ev0')).toMatchObject({ id: 'rule_event', params: { when: { event: 0 } } });
  });
});
