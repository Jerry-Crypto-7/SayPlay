/**
 * Matice akcí (P46A T9): každá dvojice (ovládání, akce) z `CAPABILITIES[*].abilities`
 * postaví hratelný svět, robot intermediate akci zmáčkne a ověření hry dokáže její
 * sloveso na 4 semínkách. Rychlá verze, validace i režisér čtou tutéž matici.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { CAPABILITIES } from '@/play/capabilities';
import { type GenreSpec } from '@/play/genre/contract';
import { compileGenre } from '@/play/genre/index';
import { type AbilityId, type ControlId, readGameSpec } from '../../../spec';
import { arcadeWorldOf, preloadPhysics } from '../../compile';
import { BODY, BUTTON, HEADER, ROLE, UNIT, bodyBase } from '../../contract';
import { STRIKE, inStrikeReach } from '../strike';
import { loadRapier } from '../../physics/world';
import { runBot, verifyArcade } from '../../verify';
import duel from '../../__fixtures__/duel.json';
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
  duel,
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

  // Robot arény jde k pronásledovateli čelem, takže matice dosah za zády nevidí; hráč ho potřebuje.
  it('top-down strike reaches a pursuer behind the hero', () => {
    const read = readGameSpec({ ...(FIXTURES.move_free as object), abilities: ['strike'] });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const made = arcadeWorldOf(read.value, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(JSON.stringify(made.world.rules)).toContain('"verb":"strike","around":true');
    const state = Int32Array.from(made.world.initial);
    const chaser = Array.from({ length: state[HEADER.bodyCount] as number }, (_v, i) => i).find((i) => state[bodyBase(i) + BODY.role] === ROLE.chaser) as number;
    state[bodyBase(chaser) + BODY.x] = state[bodyBase(0) + BODY.x] as number;
    state[bodyBase(chaser) + BODY.z] = (state[bodyBase(0) + BODY.z] as number) - 2 * UNIT - STRIKE.back;
    expect(inStrikeReach(state, 0, chaser, 0, true)).toBe(true);
    expect(inStrikeReach(state, 0, chaser, 0, false)).toBe(false);
  });

  it.each(CELLS)('%s + %s: the bot presses it and the verb is proved', (control, ability) => expectProved(control, ability));

  // Let (P47B T9): soupeř a pronásledovatel klouzání jedou vedle a za hrdinou, nikdy proti – nepřítel v obruči přibude i k nim.
  it.each([
    ['race', 'dash'],
    ['race', 'shield'],
    ['escape', 'dash'],
    ['escape', 'shield'],
  ] as const)('glide %s + %s: the moving rival does not stand in for a foe', (mode, ability) => expectProved('glide', ability, { controlParams: { mode } }));

  // P47B T11: let rychlé verze (úzké útesy) – robot obletí útes sám, štít nechá na nepřítele v další obruči.
  it('glide reach + shield: the bot does not spend it on a reef it flies around', () =>
    expectProved('glide', 'shield', { controlParams: { mode: 'reach', clearancePermille: 275, clearanceRisePermille: 10, lengthM: 160, topSpeed: 180 } }));
});

/** Robot intermediate akci zmáčkne a ověření dokáže sloveso na 4 semínkách; `extra` přepíše položky hry ovládání. */
function expectProved(control: ControlId, ability: AbilityId, extra: object = {}): void {
  for (const seed of SEEDS) {
    const read = readGameSpec({ ...(FIXTURES[control] as object), ...extra, abilities: [ability] });
    if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
    const made = arcadeWorldOf(read.value, seed);
    if (!made.ok) throw new Error(`${control} seed ${seed}: ${made.issues.join('; ')}`);
    // Verdikt první (P47B T9): hra bez těla, které by akce zastavila, padne na VERB_UNPROVED, ne až na stisku.
    const verdict = verifyArcade(made.world);
    expect(verdict.failures, `seed ${seed}`).toEqual([]);
    expect(verdict.verbs.find((proof) => proof.verb === ability)?.changed, `seed ${seed}`).toBe(true);
    const run = runBot(made.world, undefined, { profile: 'intermediate' });
    // Duel (P47B T8) hraje akce vlastním úderem (Tap) a úhybem (Down), ne tlačítkem A.
    const button = control !== 'duel' ? BUTTON.ACTION_A : ability === 'strike' ? BUTTON.TAP : BUTTON.DOWN;
    expect(run.inputs.some((event) => (event.buttons & button) !== 0), `seed ${seed}: never pressed`).toBe(true);
  }
}
