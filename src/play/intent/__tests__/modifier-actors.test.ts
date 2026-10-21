import { it, expect } from 'vitest';
import { extractIntent } from '../extract';

const sentences = [
  'Last 90 seconds on a rooftop while drones sweep the area.',
  'A city with one million simulated citizens and a two-minute chase.',
  'a wizard defends a crystal tower from flying skeletons',
  'a wizard fights flying skeletons',
  'a wizard flies through a forest and fights skeletons',
  'a wizard fights skeletons while flying over lava',
  'a dog chases a cat',
  'Drive a car while drones shoot',
];

it('preserves player subjects and distinguishes moving noun modifiers', () => {
  const rows = sentences.map(sentence => extractIntent(sentence));
  expect(rows[0].hero).toBeNull();
  expect(rows[0].items).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'hero', verb: 'survive' })]));
  expect(rows[0].items.filter(i => i.verb === 'glide')).toEqual([]);
  expect(rows[1].hero).not.toBe('two-minute');
  expect(rows[1].items.some(i => i.actor === 'two-minute')).toBe(false);
  expect(rows[2].hero).toBe('wizard');
  expect(rows[2].items.filter(i => i.verb === 'glide')).toEqual([]);
  expect(rows[2].items).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'wizard', verb: 'defend', object: 'tower', essential: true })]));
  expect(rows[3].items.filter(i => i.verb === 'glide')).toEqual([]);
  expect(rows[3].items).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'wizard', verb: 'fight', object: 'skeleton' })]));
  for (const row of rows.slice(4, 6)) {
    expect(row.items).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'wizard', verb: 'glide', essential: true })]));
  }
  expect(rows[6].hero).toBe('dog');
  expect(rows[7].hero).toBe('car');
});

// P54C: chytání a krájení – co hrdina chytá nebo krájí, je jeho cíl; padá a letí to, ne hrdina, a hrozba to není.
it('reads what the hero catches or slices as its target, not a hazard or the hero flying', () => {
  const triples = (sentence: string) => extractIntent(sentence).items.map(({ actor, verb, object }) => `${actor} ${verb} ${object}`);
  expect(triples('a ninja slices flying fruit')).toEqual(['ninja slice fruit']);
  expect(triples('a monkey catches falling bananas')).toEqual(['monkey catch banana']);
  expect(triples('a knight dodges falling rocks')).toEqual(['rock hazard knight']);
});

it('never takes existential "there" for the actor', () => {
  for (const sentence of ['Game where there is shooting animals in a car while racing', 'there are zombies and you shoot them']) {
    const intent = extractIntent(sentence);
    expect(intent.hero).not.toBe('there');
    expect(intent.items.some(item => item.actor === 'there' || item.object === 'there')).toBe(false);
  }
  expect(extractIntent('Game where there is shooting animals in a car while racing').items).toEqual(expect.arrayContaining([
    expect.objectContaining({ verb: 'shoot', object: 'animal', essential: true }),
    expect.objectContaining({ verb: 'race', essential: true }),
  ]));
});
