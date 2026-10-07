import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '../../arcade/physics/world';
import { draftGameSpecWithMeta } from '../../draft';

beforeAll(loadRapier);

it.each([
  ['mini golf with windmills and loops', 'hole', 'golf ball'],
  ['basketball free throws', 'hoop', 'basketball'],
] as const)('%s uses the actual sports equipment', (sentence, goal, ball) => {
  const game = draftGameSpecWithMeta(sentence);
  expect(game.spec.controlParams).toMatchObject({ goal });
  expect(game.spec.roles.find(role => role.id === 'physics_ball')?.label).toBe(ball);
  expect(game.spec.roles.find(role => role.id === goal)?.label).toBe(goal);
});

it('admits the missing rally instead of certifying table tennis with a goal shot', () => {
  const game = draftGameSpecWithMeta('table tennis vs a robot');
  expect(game.composition?.unmet).toContainEqual(expect.objectContaining({ verb: 'rally' }));
  expect(game.spec.roles.map(role => role.label)).not.toContain('football');
  expect(game.spec.roles.map(role => role.label)).not.toContain('goal');
});
