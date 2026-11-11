/**
 * P84 T3: „zabal / dej N věcí do …“ – věc z věty je předmět hry a počítá se do N z věty (slovem i číslicí); žádný
 * soupeř, kterého věta nemá, a cíl není přežít. Před opravou: „A bakery where I pack twelve cupcakes into boxes of four
 * …“ hrálo útěk před kočkou („Survive 40 seconds“) a cupcake ve hře nebyl.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readFacts } from '@/components/play/lab';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';

beforeAll(async () => {
  await loadRapier();
});

const PACKED = [
  ['A bakery where I pack twelve cupcakes into boxes of four and it shows how many boxes are full', 'cupcake', 12],
  ['Pack nine apples into crates of three', 'apple', 9],
  ['A toy shop where I put six teddy bears into two boxes', 'teddy bear', 6],
  ['Sort ten letters into mailboxes', 'letter', 10],
  ['Pack 7 cupcakes into boxes', 'cupcake', 7],
] as const;

describe('P84 T3: the counted thing is the thing of the game', () => {
  it.each(PACKED)('%s', (sentence, thing, count) => {
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    const facts = readFacts(spec, 'draft', sentence);
    const counted = spec.roles.find((role) => role.id === spec.objective.role);
    expect(['shop', 'arena']).toContain(spec.genre?.id);
    expect(counted?.label).toBe(thing);
    expect(spec.objective.count).toBe(count);
    expect(facts.against).toEqual([]);
    expect(spec.tutorial.goalLine).not.toMatch(/^Survive/);
    expect(facts.place).not.toMatch(/\b(?:box|boxes|crates?|mailboxes)$/);
  });

  it('packing into boxes, which the game does not do, is admitted on the strip', async () => {
    const [sentence] = PACKED[0];
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    expect((await honestyForSpec(sentence, spec, 1))?.reason).toMatch(/^Packing isn't here yet/);
  });

  it('sorting into the right bins stays a sorting game', () => {
    expect(draftGameSpecWithMeta('Sort ten letters into the right mailboxes', 1).spec.genre?.id).toBe('sort');
  });
});
