/**
 * Napětí pro hudbu (P37B T5). Že hudba přitvrdí ve špatnou chvíli (nebo
 * nikdy), z jednoho poslechu nepoznáš – pin drží tři důvody napětí, doznění
 * a že stav jen čte.
 */

import { describe, expect, it } from 'vitest';

import { ARCADE_HZ, BODY, COUNTER, FLAG, HEADER, ROLE, RUN_STATE, UNIT, bodyBase } from '@/play/arcade/contract';

import { HOLD_TICKS, LAST_SECONDS, NEAR_M, createTension, tenseNow } from '../tension';

/** Hráč v počátku a jeden soupeř `away` metrů po x; 3 životy, tik 60. */
function stateWith({ lives = 3, tick = ARCADE_HZ, away = 10, role = ROLE.chaser as number, alive = true } = {}): Int32Array {
  const state = new Int32Array(bodyBase(2));
  state[HEADER.tick] = tick;
  state[HEADER.runState] = RUN_STATE.running;
  state[HEADER.bodyCount] = 2;
  state[HEADER.player] = 0;
  state[HEADER.counters + COUNTER.health] = lives;
  state[bodyBase(0) + BODY.role] = ROLE.player;
  state[bodyBase(0) + BODY.flags] = FLAG.alive;
  state[bodyBase(1) + BODY.role] = role;
  state[bodyBase(1) + BODY.flags] = alive ? FLAG.alive : 0;
  state[bodyBase(1) + BODY.x] = Math.round(away * UNIT);
  return state;
}

describe('music tension', () => {
  it('is calm with lives to spare, time left and the rival far away', () => {
    expect(tenseNow(stateWith(), 3, 60)).toBe(false);
  });

  it('tenses on the last life, but not in a one-life game', () => {
    expect(tenseNow(stateWith({ lives: 1 }), 3, null)).toBe(true);
    expect(tenseNow(stateWith({ lives: 1 }), 1, null)).toBe(false);
  });

  it('tenses in the last seconds of the limit', () => {
    expect(tenseNow(stateWith({ tick: (60 - LAST_SECONDS) * ARCADE_HZ }), 3, 60)).toBe(true);
    expect(tenseNow(stateWith({ tick: (60 - LAST_SECONDS - 1) * ARCADE_HZ }), 3, 60)).toBe(false);
  });

  it('tenses when a living chaser or enemy is close, not a dead one or a coin', () => {
    expect(tenseNow(stateWith({ away: NEAR_M - 0.5 }), 3, null)).toBe(true);
    expect(tenseNow(stateWith({ away: NEAR_M - 0.5, role: ROLE.enemy }), 3, null)).toBe(true);
    expect(tenseNow(stateWith({ away: NEAR_M - 0.5, alive: false }), 3, null)).toBe(false);
    expect(tenseNow(stateWith({ away: NEAR_M - 0.5, role: ROLE.collectible }), 3, null)).toBe(false);
  });

  it('is never tense once the run is over', () => {
    const won = stateWith({ lives: 1 });
    won[HEADER.runState] = RUN_STATE.won;
    expect(tenseNow(won, 3, null)).toBe(false);
  });

  it('holds the tension for a while after the reason is gone, and a restart starts calm', () => {
    const tension = createTension(3, null);
    expect(tension(stateWith({ tick: 100, away: 1 }))).toBe(true);
    expect(tension(stateWith({ tick: 100 + HOLD_TICKS - 1 }))).toBe(true);
    expect(tension(stateWith({ tick: 100 + HOLD_TICKS }))).toBe(false);
    expect(tension(stateWith({ tick: 200, away: 1 }))).toBe(true);
    expect(tension(stateWith({ tick: 5 }))).toBe(false);
  });

  it('drops the held tension the moment the run ends', () => {
    const tension = createTension(3, null);
    expect(tension(stateWith({ tick: 100, away: 1 }))).toBe(true);
    for (const end of [RUN_STATE.won, RUN_STATE.lost]) {
      const over = stateWith({ tick: 101 });
      over[HEADER.runState] = end;
      expect(tension(over), `run state ${end}`).toBe(false);
    }
  });

  it('only reads the state', () => {
    const state = stateWith({ lives: 1, away: 1 });
    const copy = state.slice();
    createTension(3, 30)(state);
    expect(state).toEqual(copy);
  });
});
