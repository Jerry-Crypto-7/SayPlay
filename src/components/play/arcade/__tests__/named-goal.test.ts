import { expect, it } from 'vitest';
import { ROLE } from '@/play/arcade/contract';
import { propModels } from '@/play/arcade/models';
import { draftGameSpecWithMeta } from '@/play/draft';
import { modelIdOf } from '../World';

it('the renderer draws the named voyage goal while delivery remains unmet', () => {
  const draft = draftGameSpecWithMeta('A pizza delivery scooter races through traffic to deliver before the pizza gets cold');
  const props = propModels(draft.spec);
  expect(props.finish).toBe('pizza');
  expect(modelIdOf({ index: 1, kind: 'goal', role: ROLE.goal, w: 10, h: 3, d: 0.4 }, { player: 'car', enemy: 'car', chaser: 'car', props })).toBe('pizza');
  expect(draft.composition?.unmet.some(item => item.verb === 'deliver')).toBe(true);
});
