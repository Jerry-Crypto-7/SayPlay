/**
 * Chycení, sebrání a doručení vidět (P43 T6): sebraná věc se přitáhne k
 * hrdinovi, doručená věc letí nad hlavou hrdiny do cíle. Pozice musí vycházet
 * z hrdiny a z místa věci – efekt jinde by test existence prošel a nic neukázal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, setTargetState } from '@/play/arcade/contract';

import { cuesOf } from '../cues';
import { CUE_TICKS, heroCueFrame, stateCues } from '../HeroCueFx';

const PLAYER = 0;
const COIN = 1;
const GOAL = 2;

function stateAt(tick: number, { coin = true, goalState = 0 } = {}): Int32Array {
  const state = new Int32Array(bodyBase(3));
  state[HEADER.bodyCount] = 3;
  state[HEADER.player] = PLAYER;
  state[HEADER.tick] = tick;
  const put = (body: number, role: number, alive: boolean, x: number, z: number) => {
    const base = bodyBase(body);
    state[base + BODY.role] = role;
    state[base + BODY.flags] = alive ? FLAG.alive : 0;
    state[base + BODY.x] = x * UNIT;
    state[base + BODY.z] = z * UNIT;
    state[base + BODY.h] = 2 * UNIT;
  };
  put(PLAYER, ROLE.player, true, 0, 0);
  put(COIN, ROLE.collectible, coin, 4, 0);
  put(GOAL, ROLE.target, true, 0, 10);
  setTargetState(state, GOAL, goalState);
  return state;
}

describe('state cues', () => {
  it('a collectible that vanished is a collect cue at its last spot; a target that changed state is a deliver cue', () => {
    const memory = { alive: new Map(), states: new Map() };
    expect(stateCues(stateAt(1), memory)).toEqual([]);
    const picked = stateCues(stateAt(2, { coin: false }), memory);
    expect(cuesOf(['collect'], picked, PLAYER)).toEqual([{ verb: 'collect', at: 2, target: COIN, x: 4, y: 0, z: 0 }]);
    const delivered = stateCues(stateAt(3, { coin: false, goalState: 1 }), memory);
    expect(cuesOf(['deliver'], delivered, PLAYER).map((cue) => [cue.verb, cue.target])).toEqual([['deliver', GOAL]]);
    expect(stateCues(stateAt(4, { coin: false, goalState: 1 }), memory)).toEqual([]);
  });
});

describe('heroCueFrame', () => {
  const [collect] = cuesOf(['collect'], [{ kind: 'pickup', body: COIN, role: ROLE.collectible, x: 4, y: 0, z: 0, tick: 10 }], PLAYER);
  const [deliver] = cuesOf(['deliver'], [{ kind: 'stateChange', body: GOAL, role: ROLE.target, x: 0, y: 0, z: 10, tick: 10 }], PLAYER);

  it('pulls a collected item from its spot into the hero (scene x mirrored)', () => {
    const start = heroCueFrame([collect!], stateAt(10)).pulls[0]!;
    const late = heroCueFrame([collect!], stateAt(10 + CUE_TICKS - 1)).pulls[0]!;
    expect(start.at[0]).toBeCloseTo(-4);
    expect(Math.abs(late.at[0])).toBeLessThan(Math.abs(start.at[0]));
    expect(heroCueFrame([collect!], stateAt(10 + CUE_TICKS)).pulls).toEqual([]);
  });

  it('carries a delivered item above the hero head into the target', () => {
    const start = heroCueFrame([deliver!], stateAt(10)).carries[0]!;
    // Over the head: hero is 2 m tall.
    expect(start.at[1]).toBeGreaterThan(2);
    expect(start.at[2]).toBeCloseTo(0);
    const late = heroCueFrame([deliver!], stateAt(10 + CUE_TICKS - 1)).carries[0]!;
    expect(late.at[2]).toBeGreaterThan(8);
  });

  it('draws nothing without a cue', () => {
    expect(heroCueFrame([], stateAt(10))).toEqual({ pulls: [], carries: [] });
  });
});

describe('mounting', () => {
  it('the shared effects layer mounts HeroCueFx for every scene', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'effects', 'Effects.tsx'), 'utf8');
    expect(source).toMatch(/<HeroCueFx session=\{session\} \/>/);
  });
});
