import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';

beforeAll(async () => { await loadRapier(); });
it.each([
  ['a fish swims through a coral reef', 'glide'],
  ['a cat sneaks past guards to steal a fish', 'walker'],
  ['a penguin plays football against a walrus', 'ball'],
])('%s selects the native movement and proves its full intent', (sentence, control) => {
  const draft = draftGameSpecWithMeta(sentence, 1);
  expect(draft.spec.control).toBe(control);
  expect(draft.composition).toBeDefined();
  expect(draft.composition!.unmet).toEqual([]);
});
