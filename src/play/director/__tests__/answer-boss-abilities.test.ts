/**
 * Boss, akce a scénář úseků v odpovědi režiséra (P46E T3). Odpověď jde skutečnou
 * čtečkou (`readGenreAnswer`) a skutečným `direct()` nad nahraným tělem; co
 * ovládání nebere, čtečka zahodí, platná pole nesmí udělat MALFORMED.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { direct } from '..';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../answer-schema';
import { readGenreAnswer } from '../read';

const CAR = 'A racing car escapes a police helicopter';

/** Odpověď tvaru kompaktního režiséra pro řízení (`voyage.race`) s novými poli. */
const carAnswer = (extra: Record<string, unknown>) => ({
  plan: 'a car races away from a police helicopter',
  spec: {
    genre: 'voyage', mode: 'race', hero: 'racing car', setting: 'city', palette: 'city', params: null, heroAction: null, counts: null,
    cast: [{ label: 'police helicopter', does: 'chase_me', verb: 'chase', states: null, patrol: false }],
    ruleRoles: null, things: null, rules: null, logic: null,
    ...extra,
  },
});

const BOSS = { role: 'police helicopter', name: 'police helicopter', attack: 'drop' };

describe('the director answer carries a boss, abilities and a segment script', () => {
  it('a steer answer with a police helicopter boss and shoot + dash reads with all three and the game still plays', () => {
    const read = readGenreAnswer(carAnswer({ boss: BOSS, abilities: ['shoot', 'dash'], segments: ['newFoe', 'narrow', 'faster'] }), undefined, CAR);
    if (!read.ok) throw new Error(read.detail);
    expect(read.spec.control).toBe('steer');
    expect(read.genre.boss?.name).toBe('police helicopter');
    expect(read.genre.boss?.attack).toBe('drop');
    expect(read.genre.abilities).toEqual(['shoot', 'dash']);
    expect(read.genre.segments).toEqual(['newFoe', 'narrow', 'faster']);
    const made = arcadeWorldOf(read.spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(verifyArcade(made.world, undefined, made.roleBindings).publishEligible).toBe(true);
  }, 60_000);

  it('three abilities are cut to the two the control takes first', () => {
    const read = readGenreAnswer(carAnswer({ abilities: ['grab', 'strike', 'dash'] }), undefined, CAR);
    if (!read.ok) throw new Error(read.detail);
    expect(read.genre.abilities).toEqual(['grab', 'strike']);
  });

  it('an unknown segment change and one the control cannot play are dropped, the rest stays in order', () => {
    const read = readGenreAnswer(carAnswer({ segments: ['newFoe', 'lava', 'trap'] }), undefined, CAR);
    if (!read.ok) throw new Error(read.detail);
    expect(read.genre.segments).toEqual(['newFoe']);
  });

  it('a boss attack outside the vocabulary is a malformed answer, not a silent default', () => {
    const read = readGenreAnswer(carAnswer({ boss: { ...BOSS, attack: 'laser' } }), undefined, CAR);
    expect(read.ok).toBe(false);
  });

  it('the answer schema offers the model at most 2 abilities and exactly 3 segment changes', () => {
    const voyage = (GENRE_ANSWER_SCHEMA.properties as { spec: { anyOf: { properties?: Record<string, { anyOf: Record<string, unknown>[] }> }[] } }).spec.anyOf.find((variant) => JSON.stringify(variant.properties?.genre ?? '').includes('voyage'));
    const field = (key: string) => voyage!.properties![key]!.anyOf[0]!;
    expect(field('abilities')).toMatchObject({ type: 'array', maxItems: 2 });
    expect(field('segments')).toMatchObject({ type: 'array', minItems: 3, maxItems: 3 });
    expect(JSON.stringify(field('boss'))).toContain('"drop"');
  });

  it('direct() turns the answer with the new fields into an authored game, not MALFORMED', async () => {
    let tick = 0;
    const directed = await direct(CAR, { branch: fakeBranch([answered(carAnswer({ boss: BOSS, abilities: ['shoot', 'dash'], segments: ['newFoe', 'narrow', 'faster'] }))]), now: () => (tick += 1), compact: true, maxRepairRounds: 0 });
    expect(directed.fallbackReason).not.toBe('MALFORMED');
    expect(directed.source).toBe('authored');
  }, 120_000);
});
