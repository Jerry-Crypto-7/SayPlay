/**
 * Roboti používají akce (P46A T6): na každém ze 3 ovládání × 5 akcí × 4
 * semínka robot intermediate akci zmáčkne a ověření hry ji dokáže – žádné
 * `VERB_UNPROVED` ani `VERB_NO_EFFECT` za sloveso akce.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readGameSpec } from '../../../spec';
import { arcadeWorldOf, preloadPhysics } from '../../compile';
import { ABILITIES, type AbilityId, type ArcadeWorld, BUTTON } from '../../contract';
import { loadRapier } from '../../physics/world';
import { runBot, verifyArcade } from '../../verify';
import runner from '../../__fixtures__/runner.json';
import platform from '../../__fixtures__/platform.json';
import steer from '../../__fixtures__/steer.json';

const FIXTURES = { runner, platform, steer } as const;
type Control = keyof typeof FIXTURES;
const CONTROLS = Object.keys(FIXTURES) as Control[];
const SEEDS = [1, 2, 3, 4];

function worldOf(control: Control, ability: AbilityId, seed: number): ArcadeWorld {
  const read = readGameSpec({ ...(FIXTURES[control] as object), abilities: [ability] });
  if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
  const made = arcadeWorldOf(read.value, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

beforeAll(async () => {
  for (const control of CONTROLS) {
    const read = readGameSpec(FIXTURES[control]);
    if (read.ok) await preloadPhysics(read.value, loadRapier);
  }
});

describe.each(CONTROLS)('P46A bots use abilities on %s', (control) => {
  it.each([...ABILITIES])('%s: the intermediate bot presses it and the verb is proved', (ability) => {
    for (const seed of SEEDS) {
      const world = worldOf(control, ability, seed);
      const run = runBot(world, undefined, { profile: 'intermediate' });
      expect(run.inputs.some((event) => (event.buttons & BUTTON.ACTION_A) !== 0), `seed ${seed}: never pressed`).toBe(true);
      // Výhry robota intermediate (chybuje schválně) hlídá `abilities-difficulty.test.ts`; tady robot světa vyhrát musí.
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.verbs.find((proof) => proof.verb === ability)?.changed, `seed ${seed}: ${verdict.failures.join(' | ')}`).toBe(true);
    }
  });
});

const PAIRS = ABILITIES.flatMap((first, i) => ABILITIES.slice(i + 1).map((second) => [first, second] as const));

// R4: s dvojicí akcí jedna nesmí druhé vzít všechny příležitosti (střela zabije nepřítele dřív
// než úder, štít pohltí náraz dřív než dash) – robot světa vyhraje a dokáže obě slovesa.
describe.each(CONTROLS.flatMap((control) => [[control, []], [control, ['shoot']]] as const))('P46A two abilities on %s with addons %j', (control, addons) => {
  it.each(PAIRS)('%s + %s: the bot wins and proves both verbs', (first, second) => {
    for (const seed of SEEDS) {
      const read = readGameSpec({ ...(FIXTURES[control] as object), addons, abilities: [first, second] });
      if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
      const made = arcadeWorldOf(read.value, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      expect(verifyArcade(made.world).failures, `seed ${seed}`).toEqual([]);
    }
  });
});
