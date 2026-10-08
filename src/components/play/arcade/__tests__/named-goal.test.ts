import { expect, it } from 'vitest';
import { propModels, sceneModelOf } from '@/play/arcade/models';
import { draftGameSpecWithMeta } from '@/play/draft';
import { drawsNothing } from '../bodies';
import { modelIdOf } from '../World';

// P42 plays the delivery as a part instead of admitting it unmet: the named
// pizza is the delivered thing, drawn from its label like `cast.things` in ArcadePlay.
it('the renderer draws the named pizza as the delivered part', () => {
  const draft = draftGameSpecWithMeta('A pizza delivery scooter races through traffic to deliver before the pizza gets cold');
  const part = draft.spec.assemblyParts?.find(item => item.kind === 'deliver');
  const role = draft.spec.roles.find(item => item.id === part?.role);
  expect(role?.label).toBe('pizza');
  const things = { [role!.id]: sceneModelOf(role!.label, false)! };
  const cast = { player: 'car', enemy: 'car', chaser: 'car', props: propModels(draft.spec), things };
  // A part body carries role code 128 + i (`assembly-parts.ts`), never the bare `thing` the scene skips.
  const view = { index: 6, kind: `thing:${role!.id}`, role: 128, w: 1, h: 1.3, d: 1 };
  expect(drawsNothing(view)).toBe(false);
  expect(modelIdOf(view, cast)).toBe('pizza');
  expect(draft.composition?.unmet.some(item => item.verb === 'deliver')).toBe(false);
});
