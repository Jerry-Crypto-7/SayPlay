/**
 * Čtení věty pro řetěz (P56C T3, T17): se čtením modelem to, co dá P56A, bez něj slovník. Pin hlídá, co typy
 * nepoznají – hrdinu prohozeného s protivníkem nebo s místem: řetěz s nimi projde stavbou a hraje se špatnou postavou.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readForChain as readSentence } from '@/play/read/for-chain';
import type { Reading } from '@/play/read/schema';

import { readForChain, type SentenceRead } from '../read';

/** Věty z `evals/play/p56c/dev.json`, opsané jako fixtury – sada se smí měnit, test ne. */
const FIXTURES: readonly (readonly [id: string, text: string, expected: Partial<SentenceRead>])[] = [
  ['d01', 'a penguin mail carrier slides down icy hills dodging snowballs, then tosses letters into chimneys', {
    hero: 'mail carrier', foe: 'snowball', look: 'snow', verbs: [{ word: 'slides', class: 'runner' }, { word: 'dodging', class: 'steer' }],
  }],
  ['d02', 'ok so ur a raccoon, sneak past the guard dog, grab the pizza and climb the fence before the lights come on', {
    hero: 'raccoon', foe: 'guard dog', item: 'pizza', verbs: [{ word: 'sneak', class: 'move_free' }, { word: 'grab', class: 'move_free' }, { word: 'climb', class: 'platform' }],
  }],
  ['d04', 'can u make one where a robot hops over lava cracks and shoots bubbles at grumpy clouds', {
    hero: 'robot', foe: 'lava', item: 'grumpy cloud', look: 'volcano', verbs: [{ word: 'hops', class: 'platform' }, { word: 'shoots', class: 'aim_shoot' }],
  }],
  ['d10', 'steer a paper boat down the gutter, hop it over drains and blow the leaves out of the way', {
    hero: 'paper boat', foe: null, look: 'ocean', verbs: [{ word: 'steer', class: 'steer' }, { word: 'hop', class: 'platform' }],
  }],
  ['d12', 'dodge pies then throw pies', {
    hero: null, foe: 'pie', item: null, verbs: [{ word: 'dodge', class: 'steer' }, { word: 'throw', class: 'throw' }],
  }],
  ['d17', 'fling a grumpy hedgehog from a slingshot to knock down towers of teacups', {
    hero: null, item: 'tower', verbs: [{ word: 'fling', class: 'throw' }],
  }],
  ['d23', 'a sleepy dragon in fuzy pink slippers', { hero: 'sleepy dragon', foe: null, item: null, verbs: [] }],
  // Místo není hrdina: slovník tu podmětem vyčte „city built“.
  ['d33', 'an underwater city built from old bathtubs and coral', { hero: null, foe: null, look: 'underwater', verbs: [] }],
];

describe('readForChain from the lexicon', () => {
  it.each(FIXTURES)('%s reads hero, foe, item, world and verbs in sentence order', (_id, text, expected) => {
    const read = readForChain(text, null);
    expect(read).toMatchObject({ ...expected, source: 'lexicon' });
    expect(read.verbs.length).toBeLessThanOrEqual(4);
  });

  it('fixtures are still the dev sentences they were copied from', () => {
    const dev = (JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p56c', 'dev.json'), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
    for (const [id, text] of FIXTURES) expect(dev.find((s) => s.id === id)?.text).toBe(text);
  });

  it('gives the same read for the same sentence', () => {
    for (const [, text] of FIXTURES) expect(readForChain(text, null)).toEqual(readForChain(text, null));
  });

  it('never makes the foe the hero', () => {
    for (const [, text] of FIXTURES) {
      const read = readForChain(text, null);
      if (read.hero !== null) expect([read.foe, read.item]).not.toContain(read.hero);
    }
  });
});

/** Čtení dvanácti vět auditu P56A skutečným modelem (gpt-oss-20b, P56A T4) – test čtečku nevolá. */
const AUDIT = (JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p56a', 'audit-12.json'), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
const READS = new Map(
  (JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p56a', 'readings', 'audit-12.gpt-oss-20b.json'), 'utf8')) as { readings: { id: string; reading: Reading | null }[] }).readings.map((row) => [row.id, row.reading]),
);
const READ_AUDIT = AUDIT.flatMap(({ id, text }) => {
  const reading = READS.get(id) ?? null;
  return reading === null ? [] : [[id, text, reading] as const];
});

describe('readForChain with a model reading (P56A, T17)', () => {
  it('has a model reading for every audit sentence', () => {
    expect(READ_AUDIT).toHaveLength(AUDIT.length);
  });

  // Jeden zdroj pravdy: řetěz ukáže hrdinu, protivníka, věc, svět a název hry téže věty (`read/for-chain.ts`).
  it.each(READ_AUDIT)('%s takes every field from the P56A reading', (_id, text, reading) => {
    expect(readForChain(text, reading)).toEqual({ ...readSentence(text, reading), source: 'llm' });
  });

  it.each(READ_AUDIT)('%s never makes the foe or the item the hero', (_id, text, reading) => {
    const read = readForChain(text, reading);
    expect(read.hero).not.toBeNull();
    expect([read.foe, read.item]).not.toContain(read.hero);
  });

  it('keeps the foe, the world and the title the model named', () => {
    const reading: Reading = {
      control: 'move_free',
      verbs: [{ word: 'zap', class: 'aim_shoot' }, { word: 'dodge', class: 'steer' }],
      hero: 'cat',
      roles: [{ noun: 'fish', kind: 'collectible', count: 3 }],
      setting: null,
      mood: null,
      numbers: { seconds: null, counts: [] },
      genre: null,
      foe: 'comet',
      item: 'fish',
      world: 'space',
      title: 'Comet Cat',
    };
    expect(readForChain('a cat zaps comets and dodges them for fish', reading)).toMatchObject({
      hero: 'cat', foe: 'comet', look: 'space', title: 'Comet Cat', verbs: reading.verbs, source: 'llm',
    });
  });
});
