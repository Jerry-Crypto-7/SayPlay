import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '../../arcade/physics/world';
import { draftGameSpecWithMeta } from '../../draft';

beforeAll(loadRapier);

// P68 T9: „mini golf …“ hraje minigolf (`vozidla-sport/integration.md`); hraje se golfovým míčkem do jamky.
it('mini golf with windmills and loops putts the golf ball into the hole', () => {
  const game = draftGameSpecWithMeta('mini golf with windmills and loops');
  expect(game.genre?.genre).toBe('minigolf');
  expect(game.spec.roles.find(role => role.kind === 'player')?.label).toBe('golf ball');
  expect(game.spec.roles.find(role => role.id === 'hole')?.label).toBe('hole');
});

it.each([
  ['golf on a pirate ship', 'hole', 'golf ball'],
  ['basketball free throws', 'hoop', 'basketball'],
] as const)('%s uses the actual sports equipment', (sentence, goal, ball) => {
  const game = draftGameSpecWithMeta(sentence);
  expect(game.spec.controlParams).toMatchObject({ goal });
  expect(game.spec.roles.find(role => role.id === 'physics_ball')?.label).toBe(ball);
  expect(game.spec.roles.find(role => role.id === goal)?.label).toBe(goal);
});

it.each([
  ['a panda rolling across a field', 'panda', 'target'],
  ['a boulder rolls down a mountain crushing houses', 'boulder', 'house'],
] as const)('%s rolls the hero itself, with no invented football or goal', (sentence, ball, target) => {
  const roles = draftGameSpecWithMeta(sentence).spec.roles;
  expect(roles.find(role => role.id === 'physics_ball')?.label).toBe(ball);
  expect(roles.find(role => role.kind === 'target')?.label).toBe(target);
  expect(roles.map(role => role.label)).not.toContain('football');
});

it('admits the missing rally instead of certifying table tennis with a goal shot', () => {
  const game = draftGameSpecWithMeta('table tennis vs a robot');
  expect(game.composition?.unmet).toContainEqual(expect.objectContaining({ verb: 'rally' }));
  expect(game.spec.roles.map(role => role.label)).not.toContain('football');
  expect(game.spec.roles.map(role => role.label)).not.toContain('goal');
});
