/**
 * Návrh ze slov (P23-B T2). Návrh, který u každé věty tiše spadne na tutéž
 * fixturu, by vypadal zeleně – proto se drží trefa archetypu, čísla z věty
 * a **nulový** počet pádů na fixturu, všechno jako pin skutečného čísla
 * naměřeného 20. 9. 2026 (32/32 s archetypem, 8/8 bucketových vět CSV).
 */

import { describe, expect, it } from 'vitest';

import { goldenPrompts, packBucketPrompts } from '../../../evals/play/golden';
import { draftGameSpec, draftGameSpecWithMeta, readNumbers, readRoles } from '../draft';
import { readGameSpec } from '../spec';

const corpus = goldenPrompts();

describe('draftGameSpec', () => {
  it('yields a valid GameSpec for all forty sentences without ever falling back to the fixture', () => {
    for (const entry of corpus) {
      const meta = draftGameSpecWithMeta(entry.prompt, 1);
      expect(readGameSpec(meta.spec).ok, entry.id).toBe(true);
      expect(meta.fellBack, entry.id).toBe(false);
    }
  });

  it('hits the expected archetype on 32 of 32 corpus sentences and 8 of 8 pack bucket sentences (pin)', () => {
    const expected = corpus.filter((entry) => entry.expectArchetype !== null);
    const hits = expected.filter((entry) => draftGameSpecWithMeta(entry.prompt).archetype === entry.expectArchetype);
    expect(hits.length).toBe(32);
    const bucketHits = packBucketPrompts().filter((entry) => draftGameSpecWithMeta(entry.prompt).archetype === entry.expectArchetype);
    expect(bucketHits.length).toBe(8);
  });

  it('is byte-for-byte deterministic for the same seed and never throws on empty input', () => {
    for (const entry of corpus.slice(0, 5)) {
      expect(JSON.stringify(draftGameSpec(entry.prompt, 1))).toBe(JSON.stringify(draftGameSpec(entry.prompt, 1)));
    }
    expect(readGameSpec(draftGameSpec('')).ok).toBe(true);
    expect(readGameSpec(draftGameSpec('   ')).ok).toBe(true);
  });

  it('reads counts and seconds out of the sentence into the mechanics', () => {
    const mushrooms = draftGameSpec('Collect five glowing mushrooms then open a portal');
    expect(mushrooms.mechanics.find((m) => m.id === 'collectible')?.params.count).toBe(5);
    expect(mushrooms.objective.count).toBe(5);
    expect(mushrooms.roles.find((r) => r.kind === 'collectible')?.label).toBe('glowing mushroom');

    const survive = draftGameSpec('Survive 60 seconds while red floor tiles pulse dangerously.');
    expect(survive.mechanics.find((m) => m.id === 'timer')?.params.seconds).toBe(60);
    expect(survive.objective.seconds).toBe(60);

    const minutes = draftGameSpec('Stay alive for two minutes in a haunted kitchen where the stove flares up.');
    expect(minutes.objective.seconds).toBe(120);

    // Milion občanů se ořízne do mezí schématu, ne odmítne.
    const city = draftGameSpec('Collect one million coins in the city.');
    expect(city.mechanics.find((m) => m.id === 'collectible')?.params.count).toBe(20);
  });

  it('keeps the tutorial goal line under 80 characters and the labels under 60 for every sentence', () => {
    for (const entry of corpus) {
      const spec = draftGameSpec(entry.prompt);
      expect(spec.tutorial.goalLine.length).toBeLessThanOrEqual(80);
      for (const role of spec.roles) expect(role.label.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('lexicon', () => {
  it('names the pursuer, the carried item and its destination, and the switch colours', () => {
    expect(readRoles('A hamster escapes a supermarket while a giant Roomba hunts it.').chaser).toBe('giant roomba');
    const cake = readRoles('Carry a fragile cake across a kitchen to a party table.');
    expect(cake.item).toBe('fragile cake');
    expect(cake.destination).toBe('party table');
    expect(readRoles('Press red and blue but not green to open the door.').switches).toEqual({ all: ['red', 'blue', 'green'], required: ['red', 'blue'] });
    expect(readNumbers('Outlast a 45 second sandstorm with 3 lives')).toEqual({ seconds: 45, counts: [3] });
  });
});
