/**
 * Brány obtížnosti na hrách s akcemi (P46A T6). Pásmo novice 0,3–0,7 dnes
 * nedrží ani hra bez akce (běžec 0/10, řízení 10/10), proto se každá buňka
 * soudí proti srovnatelné hře: stejné ovládání bez akce, střelba proti
 * doplňku `+shoot`. Robot intermediate vyhraje aspoň 0,8 (běžec se střelbou
 * do R1 jen 0,3, i bez akcí), novice nesmí vyhrávat víc než nad 0,7 a nad
 * srovnávací hru, a hráč, který nic nedělá, nevyhraje.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readGameSpec } from '../../spec';
import { arcadeWorldOf, preloadPhysics } from '../compile';
import { ABILITIES, type AbilityId } from '../contract';
import { replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { runBot } from '../verify';
import runner from '../__fixtures__/runner.json';
import platform from '../__fixtures__/platform.json';
import steer from '../__fixtures__/steer.json';

const FIXTURES = { runner, platform, steer } as const;
type Control = keyof typeof FIXTURES;
const CONTROLS = Object.keys(FIXTURES) as Control[];
const SEEDS = Array.from({ length: 10 }, (_v, i) => i + 1);

interface Rates {
  readonly novice: number;
  readonly intermediate: number;
  readonly idleWins: number;
}

function ratesOf(control: Control, extra: Record<string, unknown>): Rates {
  let novice = 0;
  let intermediate = 0;
  let idleWins = 0;
  for (const seed of SEEDS) {
    const read = readGameSpec({ ...(FIXTURES[control] as object), ...extra });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const made = arcadeWorldOf(read.value, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    if (runBot(made.world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
    if (runBot(made.world, undefined, { profile: 'intermediate' }).outcome === 'won') intermediate += 1;
    if (replay(made.world, [], ARCADE_LIBRARY).outcome === 'won') idleWins += 1;
  }
  return { novice: novice / SEEDS.length, intermediate: intermediate / SEEDS.length, idleWins };
}

const comparable = (ability: AbilityId): Record<string, unknown> => (ability === 'shoot' ? { addons: ['shoot'] } : {});

beforeAll(async () => {
  for (const control of CONTROLS) {
    const read = readGameSpec(FIXTURES[control]);
    if (read.ok) await preloadPhysics(read.value, loadRapier);
  }
});

describe.each(CONTROLS)('P46A difficulty gates with abilities on %s', (control) => {
  it.each([...ABILITIES])('%s keeps the gates of the comparable game', (ability) => {
    const base = ratesOf(control, comparable(ability));
    const rates = ratesOf(control, { abilities: [ability] });
    expect(rates.idleWins, 'a player who does nothing wins').toBe(0);
    expect(rates.intermediate, `intermediate, comparable game ${base.intermediate}`).toBeGreaterThanOrEqual(0.8);
    expect(rates.novice, `novice, comparable game ${base.novice}`).toBeLessThanOrEqual(Math.max(0.7, base.novice));
  }, 300_000);
});
