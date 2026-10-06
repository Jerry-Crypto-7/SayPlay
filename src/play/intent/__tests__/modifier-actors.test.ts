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
