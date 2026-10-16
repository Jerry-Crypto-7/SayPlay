/**
 * Brány obtížnosti na hrách s akcemi (P46A T6). Pásmo novice 0,3–0,7 dnes
 * nedrží ani hra bez akce (běžec 0/10, řízení 10/10), proto se každá buňka
 * soudí proti srovnatelné hře: stejné ovládání bez akce, střelba proti
 * doplňku `+shoot`. Robot intermediate vyhraje aspoň 0,8 (běžec se střelbou
 * do R1 jen 0,3, i bez akcí), novice nesmí vyhrávat víc než nad 0,7 a nad
 * srovnávací hru, a hráč, který nic nedělá, nevyhraje.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../draft';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { arcadeWorldOf, preloadPhysics } from '../compile';
import { ABILITIES, type AbilityId } from '../contract';
import { replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { runBot } from '../verify';
import flap from '../__fixtures__/flap.json';
import runner from '../__fixtures__/runner.json';
import platform from '../__fixtures__/platform.json';
import steer from '../__fixtures__/steer.json';

const FIXTURES = { runner, platform, steer } as const;
type Control = keyof typeof FIXTURES;
const CONTROLS = Object.keys(FIXTURES) as Control[];
/** Let (P47B T9): dash a štít, stejná hra klouzání jako v `ability-matrix.test.ts`. */
const FLYING = { flap, glide: { ...flap, control: 'glide', controlParams: {} } } as const;
const SEEDS = Array.from({ length: 10 }, (_v, i) => i + 1);

interface Rates {
  readonly novice: number;
  readonly intermediate: number;
  readonly idleWins: number;
}

function ratesOf(fixture: object, extra: Record<string, unknown>): Rates {
  const read = readGameSpec({ ...fixture, ...extra });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return ratesOfSpec(read.value);
}

function ratesOfSpec(spec: GameSpecV1): Rates {
  let novice = 0;
  let intermediate = 0;
  let idleWins = 0;
  for (const seed of SEEDS) {
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    if (runBot(made.world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
    if (runBot(made.world, undefined, { profile: 'intermediate' }).outcome === 'won') intermediate += 1;
    if (replay(made.world, [], ARCADE_LIBRARY).outcome === 'won') idleWins += 1;
  }
  return { novice: novice / SEEDS.length, intermediate: intermediate / SEEDS.length, idleWins };
}

const comparable = (ability: AbilityId): Record<string, unknown> => (ability === 'shoot' ? { addons: ['shoot'] } : {});

beforeAll(async () => {
  // Návrh věty ověřuje svět robotem: fyzika načtená dřív, jako na živé cestě.
  await loadRapier();
  for (const fixture of [...Object.values(FIXTURES), ...Object.values(FLYING)]) {
    const read = readGameSpec(fixture);
    if (read.ok) await preloadPhysics(read.value, loadRapier);
  }
});

function expectGates(rates: Rates, base: Rates): void {
  expect(rates.idleWins, 'a player who does nothing wins').toBe(0);
  expect(rates.intermediate, `intermediate, comparable game ${base.intermediate}`).toBeGreaterThanOrEqual(0.8);
  expect(rates.novice, `novice, comparable game ${base.novice}`).toBeLessThanOrEqual(Math.max(0.7, base.novice));
}

describe.each(CONTROLS)('P46A difficulty gates with abilities on %s', (control) => {
  it.each([...ABILITIES])('%s keeps the gates of the comparable game', (ability) => {
    expectGates(ratesOf(FIXTURES[control], { abilities: [ability] }), ratesOf(FIXTURES[control], comparable(ability)));
  }, 300_000);
});

/**
 * Let (P47B T9): nepřítel v mezeře křižuje dráhu, srovnávací hra = týž let bez akce. Poletování novice 3/10
 * s dashem i štítem proti 2/10 bez akce; klouzání novice vyhraje 10/10 už bez akce (s dashem 9/10).
 */
describe.each(Object.keys(FLYING) as (keyof typeof FLYING)[])('P47B T9 difficulty gates with dash and shield on %s', (control) => {
  it.each(['dash', 'shield'] as const)('%s keeps the gates of the same flight without it', (ability) => {
    expectGates(ratesOf(FLYING[control], { abilities: [ability] }), ratesOf(FLYING[control], {}));
  }, 300_000);
});

/**
 * Složená hra s padajícími díly (P47B T4): věta si dash či štít nechá a ochrana bere i díly.
 * Srovnávací hra = táž věta bez akce. Běžec s dashem („a squirrel runs and dodges falling
 * acorns“, T4-R1): s cooldownem 1 s prorazil každou řadu husté pasáže a novice vyhrál 8/10
 * proti 5/10 bez akce; s 1,5 s běžce s díly (`guardParts`) 6/10. Závod a sběr mušlí (T5): štít proti
 * nepřátelům na trati, které závod dostal, a proti pronásledovatelům vln arény. Souboj v aréně
 * (T6): štít proti úderům soupeře.
 */
const ASSEMBLED = [
  ['runner', 'dash', 'a squirrel runs and dodges falling acorns'],
  ['runner', 'shield', 'a squirrel runs and blocks falling acorns'],
  ['platform', 'dash', 'a frog jumps and dashes through falling coconuts'],
  ['platform', 'shield', 'a frog jumps and blocks falling coconuts'],
  ['steer', 'shield', 'a car races and blocks rivals'],
  ['move_free', 'shield', 'a kid shields herself while collecting shells'],
  ['move_free', 'shield', 'a mouse defends its cheese from a hungry cat'],
] as const;

describe('P47B T4–T6 difficulty gates on assembled games with dash or shield', () => {
  it.each(ASSEMBLED)('%s %s ("%s") keeps the gates of the same sentence without the action', (_control, ability, text) => {
    const { spec } = draftGameSpecWithMeta(text, 1);
    expect(spec.abilities).toEqual([ability]);
    const { abilities: _abilities, ...plain } = spec;
    expectGates(ratesOfSpec(spec), ratesOfSpec(plain as GameSpecV1));
  }, 300_000);
});
