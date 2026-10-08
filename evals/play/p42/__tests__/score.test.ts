import { describe, expect, it } from 'vitest';
import { scoreTriples, sameEnvironment } from '../../p41/score';

const knit = { actor: 'hero', verb: 'knit', object: 'scarf' };
const race = { actor: 'hero', verb: 'race', object: null };
describe('P42 authorized scoring corrections', () => {
  it('requires an explicit visible admission of the exact unsupported action', () => {
    expect(scoreTriples([knit], [], [knit], { unsupported: true, visibleAdmission: true }).preserved).toBe(true);
    expect(scoreTriples([knit], [], [knit], { unsupported: true }).preserved).toBe(false);
    expect(scoreTriples([knit], [], [], { unsupported: true, visibleAdmission: true }).preserved).toBe(false);
    expect(scoreTriples([knit], [], [{ ...knit, object: 'hat' }], { unsupported: true, visibleAdmission: true }).preserved).toBe(false);
  });
  it('does not excuse supported actions in mixed unsupported sentences', () => {
    expect(scoreTriples([race, knit], [], [race, knit], { unsupported: true, visibleAdmission: true }).preserved).toBe(false);
    expect(scoreTriples([race], [], [race]).preserved).toBe(false);
    expect(scoreTriples([race], [], [race]).silent).toEqual([]);
  });
  it('compares environment head nouns and number without broadening synonyms', () => {
    expect(sameEnvironment('forest at night', 'forest')).toBe(true);
    expect(sameEnvironment('snowy mountains', 'mountain')).toBe(true);
    expect(sameEnvironment('a frozen lake', 'lake')).toBe(true);
    expect(sameEnvironment('night at night', 'night')).toBe(true);
    expect(sameEnvironment('jungle', 'forest')).toBe(false);
    expect(sameEnvironment('lake', 'snow')).toBe(false);
    expect(sameEnvironment('open country', 'forest')).toBe(false);
  });
});
