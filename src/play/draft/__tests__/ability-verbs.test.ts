/**
 * Slovník akcí hrdiny (P47B T3) nad ručně oštítkovaným dev panelem: parser,
 * kde „wooden blocks“ dá štít nebo „ghosts shoot back“ střelbu, čte větu
 * dobře a hru pokazí – proto pasti musí sedět všechny.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { saidAbilities } from '@/play/draft/controls';

interface Labelled {
  readonly id: string;
  readonly text: string;
  readonly wants: readonly string[];
}

const dev = (JSON.parse(readFileSync('evals/play/p47b/verb-dev.json', 'utf8')) as { sentences: Labelled[] }).sentences;
const said = (text: string): string[] => saidAbilities(text.toLowerCase()).slice(0, 2);

describe('sentence verbs as hero actions', () => {
  it('matches the hand label on at least 90 % of the dev panel', () => {
    const misses = dev.filter((s) => JSON.stringify(said(s.text)) !== JSON.stringify(s.wants)).map((s) => `${s.id} ${JSON.stringify(s.wants)} → ${JSON.stringify(said(s.text))}`);
    expect(misses.length / dev.length, misses.join('\n')).toBeLessThanOrEqual(0.1);
  });

  it('gives no action to any trap of the dev panel', () => {
    expect(dev.filter((s) => s.wants.length === 0 && said(s.text).length > 0).map((s) => s.id)).toEqual([]);
  });

  it('reads strike and shoot from the sentence intent, open-vocabulary verbs included', () => {
    expect(said('a goat shoves the wolves off the bridge')).toEqual(['strike']);
    expect(said('a ram headbutts the knights at the gate')).toEqual(['strike']);
    expect(said('a wizard zaps the bats in the cave')).toEqual(['shoot']);
    expect(said('a cat lasers the mice on the table')).toEqual(['shoot']);
  });

  it('reads the closed lists for dash, shield and grab', () => {
    expect(said('a fox swerves around the traps and swipes the eggs')).toEqual(['dash', 'grab']);
    expect(said('a knight parries the arrows in the courtyard')).toEqual(['shield']);
    expect(said('a crow nabs the rings from the windows')).toEqual(['grab']);
  });

  it('gives the hero nothing when an enemy does the verb', () => {
    expect(said('a kid explores the haunted house and the ghosts shoot back')).toEqual([]);
    expect(said('a sailor steers home while sharks bite the boat')).toEqual([]);
    expect(said('a girl climbs the tower while the guards block the stairs')).toEqual([]);
  });

  it('keeps an -ing verb after a place phrase with the hero, not after a plural subject', () => {
    expect(said('A fox runs through the city dodging taxis and collecting coins.')).toEqual(['dash']);
    expect(said('a knight rides across the bridge blocking arrows')).toEqual(['shield']);
    expect(said('a fox runs past the cars blocking the road')).toEqual([]);
  });

  it('reads block and shield as nouns after an article, a number, an adjective or of', () => {
    expect(said('a toddler stacks wooden blocks into a tower')).toEqual([]);
    expect(said('a knight carries a shield over the bridge')).toEqual([]);
    expect(said('a robot builds a wall of blocks')).toEqual([]);
    expect(said('a kid jumps over three blocks')).toEqual([]);
  });

  it('keeps the genre verbs out of the actions', () => {
    expect(said('a girl kicks a football into the goal')).toEqual([]);
    expect(said('a monkey throws coconuts at the tourists')).toEqual([]);
    expect(said('a robot pushes crates onto the switches')).toEqual([]);
    expect(said('a pacifist robot refuses to shoot and races home')).toEqual([]);
  });
});
