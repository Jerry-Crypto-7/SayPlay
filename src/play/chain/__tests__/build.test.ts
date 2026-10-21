/**
 * Stavba řetězu z věty `buildChain` (P56C T7). Řetěz, kde všechna kola hrají totéž ovládání v jiné kůži,
 * projde každou kontrolou kromě té, která ovládání počítá – proto se tu počítají ovládání, hrdina a svět
 * napříč koly a pořadí kol podle sloves věty, ne jen to, že řetěz vznikl.
 */

import { describe, expect, it } from 'vitest';

import { VERB_CLASSES } from '@/play/read/schema';

import { buildChain, VERB_MICROS, WORLD_MICROS } from '../build';
import type { ChainWorld } from '../contract';
import { MICRO } from '../micro';
import { readForChain } from '../read';
import { verifyChain } from '../verify';

const heroOf = (round: ChainWorld['rounds'][number]): string | undefined => round.spec.roles.find((role) => role.kind === 'player')?.label;

function built(sentence: string, seed = 11): ChainWorld {
  const made = buildChain(sentence, readForChain(sentence, null), seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.chain;
}

describe('buildChain', () => {
  const ROBOT = 'can u make one where a robot hops over lava cracks and shoots bubbles at grumpy clouds';
  const chain = built(ROBOT);

  it('plays the main verb of the sentence in round 1', () => {
    for (const sentence of [ROBOT, 'dodge pies then throw pies', 'bonk the gophers popping out of the lawn']) {
      const main = readForChain(sentence, null).verbs[0]!.class;
      expect(VERB_MICROS[main].length).toBeGreaterThan(0);
      expect(VERB_MICROS[main]).toContain(built(sentence).rounds[0]!.key);
    }
  });

  it('ends on a boss and never repeats a control', () => {
    expect(chain.rounds.length).toBeGreaterThanOrEqual(3);
    expect(chain.rounds.length).toBeLessThanOrEqual(5);
    expect(chain.rounds.at(-1)!.boss).toBe(true);
    expect(chain.rounds.slice(0, -1).every((round) => !round.boss)).toBe(true);
    const controls = chain.rounds.map((round) => round.spec.control);
    expect(new Set(controls).size).toBe(controls.length);
  });

  it('keeps one hero and one world across the rounds', () => {
    const read = readForChain(ROBOT, null);
    expect(new Set(chain.rounds.map(heroOf))).toEqual(new Set([read.hero]));
    expect(new Set(chain.rounds.map((round) => round.spec.theme.look)).size).toBe(1);
    expect(chain.rounds[0]!.spec.theme.look).toBeDefined();
  });

  it('puts the foe of the sentence into the boss round', () => {
    const sentence = 'ok so ur a raccoon, sneak past the guard dog, grab the pizza and climb the fence';
    const read = readForChain(sentence, null);
    expect(read.foe).not.toBeNull();
    expect(built(sentence).rounds.at(-1)!.spec.roles.map((role) => role.label)).toContain(read.foe);
  });

  it('builds the same chain from the same seed and a different one from another', () => {
    const keys = (world: ChainWorld): string => world.rounds.map((round) => round.key).join(' ');
    const idle = 'a quiet afternoon';
    expect(keys(built(idle, 3))).toBe(keys(built(idle, 3)));
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => keys(built(idle, seed))));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('passes verifyChain', () => {
    expect(verifyChain(chain).failures).toEqual([]);
  });

  it('maps every verb class and every world only to MICRO rounds, never to a boss', () => {
    const plain = new Set(MICRO.filter((entry) => entry.boss !== true).map((entry) => entry.key));
    for (const verbClass of VERB_CLASSES) for (const key of VERB_MICROS[verbClass]) expect(plain).toContain(key);
    for (const keys of Object.values(WORLD_MICROS)) for (const key of keys) expect(plain).toContain(key);
  });
});
