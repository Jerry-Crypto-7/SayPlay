import { describe, expect, it } from 'vitest';
import { driveSpec } from '../drive';
import { nativeSpec } from '../native';
import type { Recipe } from '../recipe';
import type { GenreSpec } from '../../genre/contract';
import { readGameSpec } from '../../spec';
import { arcadeWorldOf } from '../../arcade/compile';
import { COUNTER, HEADER } from '../../arcade/contract';

const plain: GenreSpec = { genre: 'arena', mode: 'collect', hero: 'fox', setting: 'forest' };
const content: GenreSpec = {
  ...plain, heroAction: 'carry',
  ruleRoles: [{ id: 'player', kind: 'player', label: 'wrong hero' }, { id: 'bell', kind: 'item', label: 'bell' }],
  things: [{ role: 'bell', start: 'present' }],
  rules: [{ id: 'touch_bell', verb: 'touch', when: { contact: ['player', 'bell'] }, do: [{ score: 1 }] }],
};

describe('native assembly keeps authored content for validation', () => {
  it('walker exposes and plays the requested lives instead of its hidden default', () => {
    const recipe: Recipe = { move: 'walk', actions: [], objective: 'escape', threats: ['chaser'] };
    for (const lives of [1, 3, 7]) {
      const spec = nativeSpec(recipe, { ...plain, params: { lives } });
      expect(spec.mechanics).toContainEqual({ id: 'health', params: { max: lives } });
      const made = arcadeWorldOf(spec, 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      expect(made.world.initial[HEADER.counters + COUNTER.health]).toBe(lives);
    }
  });
  it.each(['drive', 'glide', 'walk', 'ball'] as const)('%s retains rules, extra roles, things and hero animation', move => {
    const recipe: Recipe = { move, actions: [], objective: move === 'ball' ? 'score' : 'reach', threats: [] };
    const factory = move === 'drive' ? driveSpec : nativeSpec;
    const spec = factory(recipe, content);
    expect(spec.rules).toEqual(content.rules);
    expect(spec.things).toEqual(content.things);
    expect(spec.heroAction).toBe('carry');
    expect(spec.roles.filter(role => role.id === 'player')).toEqual([{ id: 'player', kind: 'player', label: 'fox', count: 1 }]);
    expect(spec.roles.find(role => role.id === 'bell')).toMatchObject({ kind: 'item', count: 1 });
    const invalid = factory(recipe, { ...content, rules: [{ ...content.rules![0]!, when: { contact: ['player', 'unknown'] } }] });
    expect(readGameSpec(invalid).ok).toBe(false);
    expect(factory(recipe, { ...plain, rules: [], ruleRoles: [], things: [] })).toEqual(factory(recipe, plain));
  });
});
