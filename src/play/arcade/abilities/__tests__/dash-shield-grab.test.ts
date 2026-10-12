/**
 * Dash, štít a krádež (P46A T5) na běžci, skákačce a řízení: dash proleví
 * náraz, který by hrdinu jinak zranil, štít pohltí přesně jeden náraz
 * a krádež zvedne `items` jen o věci v dosahu. Pravidla nesou sloveso.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '../../../spec';
import { arcadeWorldOf, preloadPhysics } from '../../compile';
import { type ArcadeInput, type ArcadeWorld, ABILITY_SLOTS, BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { loadRapier } from '../../physics/world';
import { runBot } from '../../verify';
import { inStrikeReach } from '../strike';
import runner from '../../__fixtures__/runner.json';
import platform from '../../__fixtures__/platform.json';
import steer from '../../__fixtures__/steer.json';

const FIXTURES = { runner, platform, steer } as const;
type Control = keyof typeof FIXTURES;
const CONTROLS = Object.keys(FIXTURES) as Control[];

function worldOf(control: Control, extra: Record<string, unknown>): ArcadeWorld {
  const read = readGameSpec({ ...(FIXTURES[control] as object), ...extra });
  if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
  const made = arcadeWorldOf(read.value, 11);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const specOf = (control: Control): GameSpecV1 => {
  const read = readGameSpec(FIXTURES[control]);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
};

type Hook = (state: Int32Array, tick: number) => void;

/** Přehraje svět se vstupem `input` do tiku `until` nebo do konce; `before` smí stav před tikem upravit, `seen` ho vidí po tiku. */
function play(world: ArcadeWorld, input: (tick: number) => ArcadeInput, until: number, seen?: Hook, before?: Hook): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < until && outcomeOf(state) === 'running'; tick += 1) {
    before?.(state, tick);
    step(state, input(tick), program);
    seen?.(state, tick);
  }
  return state;
}

const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const hurt = (state: Int32Array, before: number): boolean => outcomeOf(state) === 'lost' || health(state) < before;

/** Tiky, ve kterých hrdinu v běhu se vstupem `input` něco zranilo (nebo prohrál). */
function harms(world: ArcadeWorld, input: (tick: number) => ArcadeInput, until: number, before?: Hook): number[] {
  const out: number[] = [];
  let last = health(instantiate(world));
  play(
    world,
    input,
    until,
    (state, tick) => {
      if (hurt(state, last)) out.push(tick);
      last = health(state);
    },
    before,
  );
  return out;
}

/** Tik, kdy test vrazí nebezpečné tělo do hrdiny – hrdina na vlastní pěst narazí jen na běžci. */
const RAM_AT = 40;

/** V ticích `at` přesune další živé nebezpečné tělo (role z pravidla dashe či štítu) přesně na hrdinu. */
function rams(world: ArcadeWorld, at: readonly number[]): Hook {
  const roles: number[] = world.rules.flatMap((rule) => ((rule.params as { roles?: string[] }).roles ?? []).map((role) => ROLE[role as keyof typeof ROLE]));
  return (state, tick) => {
    const nth = at.indexOf(tick);
    if (nth < 0) return;
    const player = bodyBase(state[HEADER.player] as number);
    const foes = Array.from({ length: state[HEADER.bodyCount] as number }, (_v, i) => i).filter(
      (i) => i !== (state[HEADER.player] as number) && roles.includes(state[bodyBase(i) + BODY.role] as number) && alive(state, i),
    );
    const foe = bodyBase(foes[nth] as number);
    for (const slot of [BODY.x, BODY.y, BODY.z]) state[foe + slot] = state[player + slot] as number;
    for (const slot of [BODY.vx, BODY.vy, BODY.vz]) state[foe + slot] = 0;
  };
}

const press = (at: readonly number[], button: number) => (tick: number): ArcadeInput => (at.includes(tick) ? { buttons: button, axis: 0 } : NO_INPUT);

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

beforeAll(async () => {
  for (const control of CONTROLS) await preloadPhysics(specOf(control), loadRapier);
});

describe.each(CONTROLS)('P46A dash, shield and grab on %s', (control) => {
  it('puts the verbs on the dash, shield and grab rules', () => {
    for (const pair of [['dash', 'shield'], ['grab']]) {
      const world = worldOf(control, { abilities: pair });
      const verbs = world.rules.map((rule) => (rule.params as { verb?: string }).verb).filter((verb) => verb !== undefined);
      expect(verbs).toEqual(expect.arrayContaining(pair));
    }
  });

  it('dashes through a hit the hero takes without it', () => {
    const world = worldOf(control, { abilities: ['dash'] });
    const plain = harms(world, () => NO_INPUT, RAM_AT + 3, rams(world, [RAM_AT]));
    expect(plain.filter((tick) => tick >= RAM_AT)).not.toEqual([]);
    const dashed = harms(world, press([RAM_AT - 2], BUTTON.ACTION_A), RAM_AT + 3, rams(world, [RAM_AT]));
    expect(dashed.filter((tick) => tick >= RAM_AT)).toEqual([]);
  });

  it('shields exactly one hit', () => {
    const world = worldOf(control, { abilities: ['shield'] });
    const keeper = (world.control.params as { abilities: { keeper: number } }).abilities.keeper;
    const second = RAM_AT + 30;
    let charge = -1;
    const shielded = harms(world, press([1], BUTTON.ACTION_A), second + 3, (state, tick) => {
      rams(world, [RAM_AT, second])(state, tick);
      if (tick === RAM_AT + 2) charge = state[bodyBase(keeper) + ABILITY_SLOTS.shield] as number;
    });
    // První náraz pohlcený (náboj spadl na 0), druhý hrdinu zraní.
    expect(shielded.filter((tick) => tick >= RAM_AT && tick < second)).toEqual([]);
    expect(charge).toBe(0);
    expect(shielded.filter((tick) => tick >= second)).not.toEqual([]);
  });

  it('grabs only what is in reach and counts it in items', () => {
    const world = worldOf(control, { abilities: ['grab'] });
    const bot = new Map(runBot(world).inputs.map((event) => [event.tick, event]));
    const botInput = (tick: number): ArcadeInput => bot.get(tick) ?? NO_INPUT;
    // Tik, kdy je věc v dosahu krádeže, ale hrdina se jí ještě nedotkl.
    let at = -1;
    let loot = -1;
    play(world, botInput, 3000, (state, tick) => {
      if (at >= 0) return;
      const player = state[HEADER.player] as number;
      for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
        const role = state[bodyBase(i) + BODY.role];
        if ((role === ROLE.collectible || role === ROLE.enemy) && alive(state, i) && inStrikeReach(state, player, i)) {
          at = tick + 1;
          loot = i;
          return;
        }
      }
    });
    expect(at).toBeGreaterThan(0);
    const items = (state: Int32Array): number => state[HEADER.counters + COUNTER.items] as number;
    const idle = play(world, botInput, at);
    const grabbed = play(world, (tick) => (tick === at ? { buttons: botInput(tick).buttons | BUTTON.ACTION_A, axis: botInput(tick).axis } : botInput(tick)), at + 1);
    expect(alive(grabbed, loot)).toBe(false);
    expect(items(grabbed)).toBeGreaterThan(items(idle));
    // Věc mimo dosah krádež nechá být.
    const player = grabbed[HEADER.player] as number;
    const far = Array.from({ length: grabbed[HEADER.bodyCount] as number }, (_v, i) => i).filter(
      (i) => grabbed[bodyBase(i) + BODY.role] === ROLE.collectible && alive(idle, i) && !inStrikeReach(idle, player, i),
    );
    expect(far.length).toBeGreaterThan(0);
    for (const i of far) expect(alive(grabbed, i)).toBe(true);
  });
});
