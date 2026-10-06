import { describe, expect, it } from 'vitest';
import type { GenreSpec } from '../../genre/contract';
import { gameSpecSchema, readGameSpec } from '../../spec';
import { nativeSpec } from '../native';
import type { Recipe } from '../recipe';

const content: GenreSpec = { genre: 'voyage', mode: 'race', hero: 'fish', setting: 'coral reef', cast: [
  { label: 'pearl', does: 'collect' }, { label: 'cave', does: 'reach' }, { label: 'shark', does: 'chase_me' },
  { label: 'eel', does: 'shoot_at' }, { label: 'dolphin', does: 'fight' },
] };
const recipe = (move: Recipe['move'], objective: Recipe['objective'], actions: Recipe['actions'] = [], threats: Recipe['threats'] = []): Recipe => ({ move, objective, actions, threats });

describe('native assembly factories', () => {
  it.each((['reach', 'collect', 'race', 'escape'] as const).flatMap(objective => [false, true].map(shoot => ({ objective, shoot }))))('glide $objective, shoot=$shoot has native parameters and identities', ({ objective, shoot }) => {
    const spec = nativeSpec(recipe('glide', objective, shoot ? ['shoot'] : []), content);
    expect(gameSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.control).toBe('glide');
    expect(spec.controlParams).toMatchObject({ generator: 'glide_course', mode: objective });
    expect(spec.genre).toBeUndefined();
    expect(spec.theme.setting).toBe('coral reef');
    expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'player', label: 'fish' }));
    expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'glide_ring', label: 'pearl', kind: 'collectible' }));
    expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'finish', label: 'cave' }));
    if (shoot) expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'enemy', label: 'eel' }));
    else expect(readGameSpec(spec).ok).toBe(true);
    if (objective === 'race') expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'glide_rival', label: 'dolphin' }));
    if (objective === 'escape') expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'glide_pursuer', label: 'shark' }));
  });

  it.each([
    { objective: 'reach' as const, threats: [], generator: 'walker_labyrinth' },
    { objective: 'collect' as const, threats: ['guard' as const], generator: 'walker_stealth' },
    { objective: 'collect' as const, threats: ['chaser' as const], generator: 'walker_escape' },
    { objective: 'escape' as const, threats: [], generator: 'walker_escape' },
  ])('walker $objective uses $generator and explicit collect state', ({ objective, threats, generator }) => {
    const spec = nativeSpec(recipe('walk', objective, [], threats), { ...content, hero: 'cat', setting: 'castle' });
    expect(gameSpecSchema.safeParse(spec).success).toBe(true);
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec.controlParams).toMatchObject({ generator });
    expect(spec.theme.setting).toBe('castle');
    if (objective === 'collect') {
      expect(spec.controlParams).toHaveProperty('collect', true);
      expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'coin', kind: 'collectible', label: 'pearl' }));
    }
    if (generator === 'walker_stealth') expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'guard', kind: 'patrol', label: 'shark' }));
  });

  it.each([
    { target: 'football goal', goal: 'goal', action: 'kick' as const },
    { target: 'basketball hoop', goal: 'hoop', action: 'throw' as const },
    { target: 'golf hole', goal: 'hole', action: 'kick' as const },
  ])('ball scores in the $goal with a real named keeper', ({ target, goal, action }) => {
    const spec = nativeSpec(recipe('ball', 'score', [action], ['rival']), { ...content, hero: 'robot', setting: 'sports field', cast: [
      { label: target, does: 'throw_at' }, { label: 'goalkeeper robot', does: 'fight' }, { label: 'orange ball', does: 'scenery' },
    ] });
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec.controlParams).toMatchObject({ generator: 'ball_pitch', goal, keeper: true });
    expect(spec.roles).toContainEqual(expect.objectContaining({ id: goal, kind: 'target', label: target }));
    expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'physics_ball', kind: 'item', label: 'orange ball' }));
    expect(spec.roles).toContainEqual(expect.objectContaining({ id: 'goalkeeper', kind: 'patrol', label: 'goalkeeper robot' }));
  });

  it.each([
    recipe('glide', 'reach', ['deliver']), recipe('glide', 'reach', [], ['chaser']),
    recipe('walk', 'reach', ['shoot']), recipe('walk', 'escape', [], ['guard']),
    recipe('ball', 'score', ['kick', 'throw']), recipe('ball', 'reach'), recipe('run', 'reach'),
  ])('rejects a combination without a matching runtime: %j', requested => {
    expect(() => nativeSpec(requested, content)).toThrow('Unsupported native recipe');
  });
});
