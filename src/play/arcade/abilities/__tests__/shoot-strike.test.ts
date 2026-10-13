/**
 * Střelba a úder jako akce hrdiny (P46A T4) na běžci, skákačce a řízení:
 * stisk tlačítka akce vystřelí nebo udeří, úder odstraní nepřítele jen
 * v dosahu, cooldown drží a bez stisku se nic nestane. Úder trefí
 * i pronásledovatele (liška, býk). Pravidla nesou sloveso pro ověření robotem.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '../../../spec';
import { arcadeWorldOf, preloadPhysics } from '../../compile';
import { type ArcadeInput, type ArcadeWorld, BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { loadRapier } from '../../physics/world';
import { census } from '../../pieces/shots';
import { runBot } from '../../verify';
import { ABILITY_TIMING, abilityActive, abilityCooldown } from '../state';
import { inStrikeReach } from '../strike';
import runner from '../../__fixtures__/runner.json';
import platform from '../../__fixtures__/platform.json';
import steer from '../../__fixtures__/steer.json';

const FIXTURES = { runner, platform, steer } as const;
type Control = keyof typeof FIXTURES;

function specOf(control: Control, extra: Record<string, unknown>): GameSpecV1 {
  const read = readGameSpec({ ...(FIXTURES[control] as object), ...extra });
  if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
  return read.value;
}

function worldOf(spec: GameSpecV1): ArcadeWorld {
  const made = arcadeWorldOf(spec, 11);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const keeperOf = (world: ArcadeWorld): number => (world.control.params as { abilities: { keeper: number } }).abilities.keeper;

/** Vstupy robota světa (vyhýbá se překážkám) a navíc tlačítko `press` v tiku `at`. */
function botWith(world: ArcadeWorld, at = -1, press = 0): (tick: number) => ArcadeInput {
  const byTick = new Map(runBot(world).inputs.map((event) => [event.tick, event]));
  return (tick) => {
    // Robot akcí mačká akce sám (T6); test chce jeho pohyb, ale stisk jen svůj.
    const event = byTick.get(tick) ?? NO_INPUT;
    const base = { buttons: event.buttons & ~(BUTTON.ACTION_A | BUTTON.ACTION_B), axis: event.axis };
    return tick === at ? { buttons: base.buttons | press, axis: base.axis } : base;
  };
}

/** Přehraje svět s vstupem `input(tick, state)` do `until` (vrátí `true` = stop); vrátí stav a tik zastavení. */
function play(world: ArcadeWorld, input: (tick: number) => ArcadeInput, until: (state: Int32Array, tick: number) => boolean, max = 3000): { state: Int32Array; tick: number } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < max && outcomeOf(state) === 'running'; tick += 1) {
    if (until(state, tick)) return { state, tick };
    step(state, input(tick), program);
  }
  return { state, tick: -1 };
}

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** První živý nepřítel nebo pronásledovatel v dosahu úderu. */
function foeInReach(state: Int32Array, role: number): number {
  const player = state[HEADER.player] as number;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (state[bodyBase(i) + BODY.role] === role && alive(state, i) && inStrikeReach(state, player, i)) return i;
  }
  return -1;
}

beforeAll(async () => {
  for (const control of Object.keys(FIXTURES) as Control[]) await preloadPhysics(specOf(control, {}), loadRapier);
});

describe.each(Object.keys(FIXTURES) as Control[])('P46A shoot and strike on %s', (control) => {
  it('puts the verbs on the shot and strike rules', () => {
    const world = worldOf(specOf(control, { abilities: ['shoot', 'strike'] }));
    const verbs = world.rules.map((rule) => (rule.params as { verb?: string }).verb).filter((verb) => verb !== undefined);
    expect(verbs).toEqual(expect.arrayContaining(['shoot', 'strike']));
  });

  it('fires a shot on the shoot button and none without it', () => {
    const world = worldOf(specOf(control, { abilities: ['shoot'] }));
    const pressed = play(world, (tick) => (tick === 1 ? { buttons: BUTTON.ACTION_A, axis: 0 } : NO_INPUT), (_s, tick) => tick === 3);
    expect(census(pressed.state).projectiles).toBeGreaterThan(0);
    const idle = play(world, () => NO_INPUT, (_s, tick) => tick === 3);
    expect(census(idle.state).projectiles).toBe(0);
  });

  it('removes an enemy in reach on the strike button, and only with the press', () => {
    const world = worldOf(specOf(control, { abilities: ['strike'] }));
    const near = play(world, botWith(world), (state) => foeInReach(state, ROLE.enemy) >= 0);
    expect(near.tick).toBeGreaterThan(0);
    const foe = foeInReach(near.state, ROLE.enemy);
    const score = near.state[HEADER.counters + COUNTER.score] as number;
    const struck = play(world, botWith(world, near.tick, BUTTON.ACTION_A), (_s, tick) => tick === near.tick + 1);
    expect(alive(struck.state, foe)).toBe(false);
    expect(struck.state[HEADER.counters + COUNTER.score] as number).toBeGreaterThan(score);
    const idle = play(world, botWith(world), (_s, tick) => tick === near.tick + 1);
    expect(alive(idle.state, foe)).toBe(true);
  });

  it('leaves an enemy out of reach alive when the strike lands', () => {
    const world = worldOf(specOf(control, { abilities: ['strike'] }));
    const near = play(world, botWith(world), (state) => foeInReach(state, ROLE.enemy) >= 0);
    const foe = foeInReach(near.state, ROLE.enemy);
    const player = near.state[HEADER.player] as number;
    const far = Array.from({ length: near.state[HEADER.bodyCount] as number }, (_v, i) => i).filter(
      (i) => i !== foe && near.state[bodyBase(i) + BODY.role] === ROLE.enemy && alive(near.state, i) && !inStrikeReach(near.state, player, i),
    );
    expect(far.length).toBeGreaterThan(0);
    const struck = play(world, botWith(world, near.tick, BUTTON.ACTION_A), (_s, tick) => tick === near.tick + 1);
    for (const i of far) expect(alive(struck.state, i)).toBe(true);
  });

  it('spaces the shots: two presses in a row fire one shot', () => {
    const world = worldOf(specOf(control, { abilities: ['shoot'] }));
    const twice = play(world, (tick) => (tick === 1 || tick === 2 ? { buttons: BUTTON.ACTION_A, axis: 0 } : NO_INPUT), (_s, tick) => tick === 4);
    expect(census(twice.state).projectiles).toBe(1);
  });

  it('fires once per press: holding the shoot button does not autofire', () => {
    const world = worldOf(specOf(control, { abilities: ['shoot'] }));
    const ammo = (state: Int32Array): number => state[HEADER.counters + COUNTER.ammo] as number;
    const start = ammo(instantiate(world));
    const held = (tick: number): boolean => tick >= 1 && tick <= 25;
    const once = play(world, (tick) => (held(tick) ? { buttons: BUTTON.ACTION_A, axis: 0 } : NO_INPUT), (_s, tick) => tick === 32);
    expect(once.tick).toBe(32);
    expect(start - ammo(once.state)).toBe(1);
    // Puštěno a znovu zmáčknuto: druhá rána.
    const again = play(world, (tick) => (held(tick) || tick === 30 ? { buttons: BUTTON.ACTION_A, axis: 0 } : NO_INPUT), (_s, tick) => tick === 32);
    expect(start - ammo(again.state)).toBe(2);
  });

  it('holds the strike cooldown: a second press inside it does not restart the strike', () => {
    const world = worldOf(specOf(control, { abilities: ['shoot', 'strike'] }));
    const keeper = keeperOf(world);
    const twice = play(world, (tick) => (tick === 1 || tick === 2 ? { buttons: BUTTON.ACTION_B, axis: 0 } : NO_INPUT), (_s, tick) => tick === 3);
    // Stisk v tiku 1 nabil okno a cooldown, tik 2 je o jedno snížil a druhý stisk nic nerestartoval.
    expect(abilityCooldown(twice.state, keeper, 1)).toBe(ABILITY_TIMING.strike.cooldown - 1);
    expect(abilityActive(twice.state, keeper, 1)).toBe(ABILITY_TIMING.strike.active - 1);
  });
});

// Liška a býk z vět majitele běží proti běžci. Na skákačce pronásledovatel dohání zezadu a robot mu uteče
// (nejblíž ~12 m), takže tam úder na něj robot ani hráč nepotřebuje.
describe.each(['runner'] as const)('P46A strike on the %s chaser', (control) => {
  it('strikes the chaser away', () => {
    const world = worldOf(specOf(control, { addons: ['chaser'], abilities: ['strike'] }));
    const near = play(world, botWith(world), (state) => foeInReach(state, ROLE.chaser) >= 0);
    expect(near.tick).toBeGreaterThan(0);
    const chaser = foeInReach(near.state, ROLE.chaser);
    const struck = play(world, botWith(world, near.tick, BUTTON.ACTION_A), (_s, tick) => tick === near.tick + 1);
    expect(alive(struck.state, chaser)).toBe(false);
  });
});
