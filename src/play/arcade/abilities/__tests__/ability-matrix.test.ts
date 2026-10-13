/**
 * Matice akcí (P46A T9): každá dvojice (ovládání, akce) z `CAPABILITIES[*].abilities`
 * postaví hratelný svět, robot intermediate akci zmáčkne a ověření hry dokáže její
 * sloveso na 4 semínkách. Rychlá verze, validace i režisér čtou tutéž matici.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { CAPABILITIES } from '@/play/capabilities';
import { type GenreSpec } from '@/play/genre/contract';
import { compileGenre } from '@/play/genre/index';
import { type ControlId, readGameSpec } from '../../../spec';
import { arcadeWorldOf, preloadPhysics } from '../../compile';
import { BUTTON } from '../../contract';
import { loadRapier } from '../../physics/world';
import { runBot, verifyArcade } from '../../verify';
import flap from '../../__fixtures__/flap.json';
import platform from '../../__fixtures__/platform.json';
import runner from '../../__fixtures__/runner.json';
import steer from '../../__fixtures__/steer.json';

const SEEDS = [1, 2, 3, 4];

/**
 * Hra ovládání, na které matice akce zkouší. Aréna = útěk: dash a štít chrání jen před
 * pronásledovatelem, který chytá (agar je odmítne). Bludiště se sběrem: krádež potřebuje věc.
 */
const FIXTURES: Partial<Record<ControlId, object>> = {
  runner,
  platform,
  steer,
  flap,
  glide: { ...flap, control: 'glide', controlParams: {} },
  walker: { ...flap, control: 'walker', controlParams: { collect: true } },
  move_free: compileGenre({ genre: 'arena', mode: 'escape', hero: 'cat', cast: [{ label: 'polar bear', does: 'chase_me' }, { label: 'glowing fish', does: 'collect' }], setting: 'frozen lake' } as GenreSpec),
};

const CELLS = (Object.keys(CAPABILITIES) as ControlId[]).flatMap((control) => CAPABILITIES[control].abilities.map((ability) => [control, ability] as const));

beforeAll(async () => {
  for (const fixture of Object.values(FIXTURES)) {
    const read = readGameSpec(fixture);
    if (read.ok) await preloadPhysics(read.value, loadRapier);
  }
});

describe('P46A ability matrix', () => {
  it('every control that takes abilities has a fixture to prove them on', () => {
    const missing = (Object.keys(CAPABILITIES) as ControlId[]).filter((control) => CAPABILITIES[control].abilities.length > 0 && FIXTURES[control] === undefined);
    expect(missing).toEqual([]);
  });

  it.each(CELLS)('%s + %s: the bot presses it and the verb is proved', (control, ability) => {
    for (const seed of SEEDS) {
      const read = readGameSpec({ ...(FIXTURES[control] as object), abilities: [ability] });
      if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
      const made = arcadeWorldOf(read.value, seed);
      if (!made.ok) throw new Error(`${control} seed ${seed}: ${made.issues.join('; ')}`);
      const run = runBot(made.world, undefined, { profile: 'intermediate' });
      expect(run.inputs.some((event) => (event.buttons & BUTTON.ACTION_A) !== 0), `seed ${seed}: never pressed`).toBe(true);
      const verdict = verifyArcade(made.world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.verbs.find((proof) => proof.verb === ability)?.changed, `seed ${seed}`).toBe(true);
    }
  });
});
