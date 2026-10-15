/**
 * Juice zásahů, akcí, power-upů a finále (P46C T4). Co by vypadalo dobře a bylo
 * špatně: „méně pohybu“, které vypne otřes, ale kresba se po zásahu dál
 * zaškubne (hit-stop) a pád bosse dál zpomalí – bez nastavení to nikdo neuvidí.
 * Proto pin: s `reduced` je otřes 0, hit-stop 0 a zpomalení 1×, bez něj ne.
 * A sběrnice: sebraný power-up, zásah akcí, padlý boss a růst komba jsou
 * vlastní události s vlastním zvukem z presetů.
 */

import { describe, expect, it } from 'vitest';

import { ABILITY_SLOTS, type ArcadeEffect, BODY, BODY_STRIDE, FLAG, HEADER, HEADER_SIZE, type PieceRef, ROLE, RUN_STATE, bodyBase } from '@/play/arcade/contract';
import { SFX_PRESETS } from '@/play/audio';

import { type EffectsSource, type VisualEvent, createEffectsBus } from '../effects/bus';
import { HIT_STOP_MS, SLOW_MO_MS, SLOW_MO_SCALE, hitStopHeld, hitStopMs, shakeAmount, slowMoScale } from '../effects/feel';
import { createRenderFeel } from '../effects/render-feel';
import { busPresets } from '../effects/sound';

const PLAYER = 0;
const ENEMY = 1;
const POWERUP = 2;
const KEEPER = 3;
const BOSS_TEMPLATE = 4;
const BOSS = 5;

function makeState(): Int32Array {
  const s = new Int32Array(HEADER_SIZE + 6 * BODY_STRIDE);
  s[HEADER.bodyCount] = 6;
  s[HEADER.player] = PLAYER;
  const roles = [ROLE.player, ROLE.enemy, ROLE.powerup, ROLE.obstacle, ROLE.enemy, ROLE.enemy];
  roles.forEach((role, i) => {
    const b = bodyBase(i);
    s[b + BODY.role] = role;
    s[b + BODY.flags] = i === KEEPER || i === BOSS_TEMPLATE ? 0 : FLAG.alive | FLAG.grounded;
    s[b + BODY.w] = s[b + BODY.h] = s[b + BODY.d] = i >= BOSS_TEMPLATE ? 900 : 200;
    s[b + BODY.kind] = i >= BOSS_TEMPLATE ? 7 : 1;
  });
  return s;
}

/** Relace na hraní: `fire` provede tik s efekty a úpravou stavu po něm. */
function fakeSession(rules: readonly PieceRef[]) {
  let before = makeState();
  let after = before.slice();
  const listeners = new Set<(effects: readonly ArcadeEffect[], tick: number) => void>();
  const subscribers = new Set<() => void>();
  const source: EffectsSource = {
    state: () => after,
    prev: () => before,
    humanRun: () => true,
    world: { rules },
    onEvents: (f) => (listeners.add(f), () => listeners.delete(f)),
    subscribe: (f) => (subscribers.add(f), () => subscribers.delete(f)),
  };
  const fire = (effects: readonly ArcadeEffect[], change: (state: Int32Array) => void = () => {}): void => {
    before = after.slice();
    after = before.slice();
    const tick = before[HEADER.tick] as number;
    after[HEADER.tick] = tick + 1;
    change(after);
    listeners.forEach((f) => f(effects, tick));
    subscribers.forEach((f) => f());
  };
  return { source, fire, state: () => after };
}

const kill = (body: number) => (state: Int32Array) => {
  state[bodyBase(body) + BODY.flags] = 0;
};

function heard(rules: readonly PieceRef[], setup: (state: Int32Array) => void, effects: readonly ArcadeEffect[], change: (state: Int32Array) => void) {
  const session = fakeSession(rules);
  setup(session.state());
  const bus = createEffectsBus(session.source);
  const events: VisualEvent[] = [];
  bus.subscribe((tick) => events.push(...tick));
  session.fire(effects, change);
  return { events, bus };
}

const STRIKE_RULE: PieceRef = { id: 'ability_strike', params: { keeper: KEEPER, slot: 0, verb: 'strike' } };
const BOSS_RULE: PieceRef = { id: 'boss_beat', params: { boss: BOSS_TEMPLATE } };

describe('reduced motion turns every jolt off', () => {
  it('shake 0, hit-stop 0 and slow-mo 1x with reduced motion; real values without it', () => {
    expect(shakeAmount(1, true)).toBe(0);
    expect(hitStopMs(true)).toBe(0);
    expect(hitStopHeld(10, true)).toBe(false);
    expect(slowMoScale(100, true)).toBe(1);

    expect(shakeAmount(1, false)).toBeGreaterThan(0);
    expect(hitStopMs(false)).toBe(HIT_STOP_MS);
    expect(HIT_STOP_MS).toBe(60);
    expect(hitStopHeld(10, false)).toBe(true);
    expect(slowMoScale(100, false)).toBe(SLOW_MO_SCALE);
    expect(SLOW_MO_SCALE).toBe(0.4);
    expect(SLOW_MO_MS).toBe(400);
    expect(slowMoScale(SLOW_MO_MS, false)).toBe(1);
  });

  it.each([false, true])('render feel (reduced %s): an action hit holds, a boss defeat slows', (reduced) => {
    let now = 0;
    const session = fakeSession([STRIKE_RULE, BOSS_RULE]);
    const feel = createRenderFeel(session.source, () => now, () => reduced);
    session.fire([{ kind: 'hit', body: ENEMY, by: PLAYER, amount: 1 }, { kind: 'despawn', body: ENEMY }], kill(ENEMY));
    now = 30;
    expect(feel.held()).toBe(!reduced);
    now = 1000;
    session.fire([{ kind: 'hit', body: BOSS, by: PLAYER, amount: 1 }, { kind: 'despawn', body: BOSS }], kill(BOSS));
    now = 1200;
    expect(feel.timeScale()).toBe(reduced ? 1 : 0.4);
    now = 1400;
    expect(feel.timeScale()).toBe(1);
    feel.dispose();
  });

  it('the last second of a finale (a win in a game with a pacing finale) slows too', () => {
    let now = 0;
    const session = fakeSession([{ id: 'pacing', params: { finale: 'sprint', behaviours: [] } }]);
    const feel = createRenderFeel(session.source, () => now, () => false);
    session.fire([{ kind: 'win' }], (state) => {
      state[HEADER.runState] = RUN_STATE.won;
    });
    now = 100;
    expect(feel.timeScale()).toBe(0.4);
    feel.dispose();
  });
});

describe('juice events on the effects bus', () => {
  it('an enemy struck down inside the strike window is an ability hit that shakes', () => {
    const { events, bus } = heard([STRIKE_RULE], (s) => (s[bodyBase(KEEPER) + ABILITY_SLOTS.activeA] = 5), [{ kind: 'score', amount: 1 }, { kind: 'despawn', body: ENEMY }], kill(ENEMY));
    expect(events.map((e) => e.kind)).toEqual(['death', 'ability']);
    expect(bus.shake()).toBe(1);
    expect(busPresets(events)).toEqual(['pop', 'strike']);
  });

  it('the same despawn without an open window is only a death, no shake', () => {
    const { events, bus } = heard([STRIKE_RULE], () => {}, [{ kind: 'score', amount: 1 }, { kind: 'despawn', body: ENEMY }], kill(ENEMY));
    expect(events.map((e) => e.kind)).toEqual(['death']);
    expect(bus.shake()).toBe(0);
  });

  it('a collected power-up is a powerup event with its own sound', () => {
    const { events } = heard([], () => {}, [{ kind: 'powerup', keeper: KEEPER, power: 1, ticks: 300 }, { kind: 'despawn', body: POWERUP }], kill(POWERUP));
    expect(events.map((e) => e.kind)).toEqual(['powerup']);
    expect(busPresets(events)).toEqual(['powerup']);
  });

  it('a fallen boss is a bossDefeat beside its death; a plain enemy is not', () => {
    const boss = heard([BOSS_RULE], () => {}, [{ kind: 'hit', body: BOSS, by: PLAYER, amount: 1 }, { kind: 'despawn', body: BOSS }], kill(BOSS));
    expect(boss.events.map((e) => e.kind)).toEqual(['hit', 'ability', 'death', 'bossDefeat']);
    expect(busPresets(boss.events)).toContain('bossDown');
    const plain = heard([BOSS_RULE], () => {}, [{ kind: 'despawn', body: ENEMY }], kill(ENEMY));
    expect(plain.events.map((e) => e.kind)).toEqual(['death']);
  });

  it('comboUp fires only when the combo effect raises the multiplier', () => {
    const up = heard([], (s) => (s[bodyBase(KEEPER) + BODY.aux0] = 2), [{ kind: 'combo', body: KEEPER, multiplier: 3 }], () => {});
    expect(up.events).toMatchObject([{ kind: 'comboUp', body: PLAYER, multiplier: 3 }]);
    expect(busPresets(up.events)).toEqual(['comboUp']);
    const capped = heard([], (s) => (s[bodyBase(KEEPER) + BODY.aux0] = 5), [{ kind: 'combo', body: KEEPER, multiplier: 5 }], () => {});
    expect(capped.events).toEqual([]);
    const reset = heard([], (s) => (s[bodyBase(KEEPER) + BODY.aux0] = 4), [{ kind: 'combo', body: KEEPER, multiplier: 1 }], () => {});
    expect(reset.events).toEqual([]);
  });

  it('every new sound is a synth preset (mute silences presets in playSfx)', () => {
    for (const preset of ['powerup', 'bossDown', 'comboUp', 'strike'] as const) expect(SFX_PRESETS[preset]).toBeDefined();
  });
});
