import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/ir/worlddoc';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import type { GenreSpec } from '../../genre/contract';
import { driveSpec } from '../drive';
import type { Recipe } from '../recipe';
import { extractIntent } from '@/play/intent/extract';
import { compose } from '../compose';

const content: GenreSpec = {
  genre: 'voyage', mode: 'race', hero: 'car', setting: 'city',
  cast: [{ label: 'zombie', does: 'shoot_at' }, { label: 'police car', does: 'chase_me' }, { label: 'garage', does: 'reach' }],
};
const recipe = (objective: 'race' | 'reach' | 'escape', shoot: boolean): Recipe => ({
  move: 'drive', objective, actions: shoot ? ['shoot'] : [], threats: objective === 'escape' ? ['chaser'] : objective === 'race' ? ['rival'] : [],
});
const cases = (['race', 'reach', 'escape'] as const).flatMap(objective => [false, true].flatMap(shoot =>
  Array.from({ length: objective === 'race' && shoot ? 20 : 5 }, (_, index) => ({ objective, shoot, seed: index + 1 }))));

describe('P41 staged native driving recipes', () => {
  it.each(['car', 'truck', 'boat', 'ferry'])('a named %s hero selects driving', hero => {
    const selected = compose(extractIntent(`a ${hero} reaches the harbor`));
    expect(selected.recipe.move).toBe('drive');
  });
  it.each(cases)('$objective, shoot=$shoot, seed=$seed has real movement and action evidence', ({ objective, shoot, seed }) => {
    const spec = driveSpec(recipe(objective, shoot), content);
    expect(spec.controlParams).not.toHaveProperty('generator');
    expect(spec.genre).toBeUndefined();
    expect(spec.controlParams?.rivals).toBe(objective === 'race');
    const made = arcadeWorldOf(spec, seed);
    const repeated = arcadeWorldOf(driveSpec(recipe(objective, shoot), content), seed);
    if (!made.ok || !repeated.ok) throw new Error('Native driving composition did not compile');
    expect(canonicalHash(made.world)).toBe(canonicalHash(repeated.world));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.failures).toEqual([]);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.publishEligible).toBe(true);
    expect(verdict.replayEqual).toBe(true);
    expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'drive', run: 'winner', actor: expect.objectContaining({ label: 'car' }) }));
    expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: objective, run: 'winner' }));
    if (objective === 'race') expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'race', evidence: 'overtake', object: expect.objectContaining({ roleId: 'rival' }) }));
    if (objective === 'escape') expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'chaser', run: 'probe', actor: expect.objectContaining({ label: 'police car' }) }));
    if (shoot) expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'shoot', evidence: 'projectile-hit', object: expect.objectContaining({ label: 'zombie' }) }));
    else expect(verdict.witnesses.some(witness => witness.verb === 'shoot')).toBe(false);
  });

  it('rejects unsupported requested actions instead of silently removing them', () => {
    expect(() => driveSpec({ ...recipe('race', false), actions: ['deliver'] }, content)).toThrow('Unsupported driving recipe');
    expect(() => driveSpec({ ...recipe('reach', false), threats: ['rival'] }, content)).toThrow('Unsupported driving recipe');
  });
});
