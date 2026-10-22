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
import { MUTATOR_COMPAT, MUTATORS, type MutatorId } from '../mutators';
import { readForChain } from '../read';
import { verifyChain } from '../verify';

const heroOf = (round: ChainWorld['rounds'][number]): string | undefined => round.spec.roles.find((role) => role.kind === 'player')?.label;

function built(sentence: string, seed = 11, mutators = false): ChainWorld {
  const made = buildChain(sentence, readForChain(sentence, null), seed, mutators);
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

  // T17a: čtení modelem jmenuje věc a název; kolo, které sbírá, sbírá věc čtení, a každé kolo nese název čtení.
  it('puts the item and the title of a model reading into the rounds', () => {
    const sentence = 'a fox catches falling apples in the orchard';
    const read = { ...readForChain(sentence, null), verbs: [{ word: 'catches', class: 'move_free' as const }], item: 'golden star', title: 'Star Fox', source: 'llm' as const };
    const made = buildChain(sentence, read, 11, false);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const caught = made.chain.rounds.find((round) => round.key === 'catch.default');
    expect(caught?.spec.roles.find((role) => role.kind === 'collectible')?.label).toBe('golden star');
    expect(made.chain.rounds.map((round) => round.spec.title)).toEqual(made.chain.rounds.map(() => 'Star Fox'));
    expect(verifyChain(made.chain).failures).toEqual([]);
  });

  // T17c: čtení „a cat catches mice“ má myš za protivníka i za věc; boss s ní musí bojovat, ne ji mít jen jako sbíranou věc.
  it('makes the boss fight the foe even when its name is also the item', () => {
    const sentence = 'a cat catches mice running around the barn';
    const read = { ...readForChain(sentence, null), verbs: [{ word: 'catches', class: 'move_free' as const }], foe: 'mouse', item: 'mouse', source: 'llm' as const };
    for (const seed of [1, 2, 3, 11]) {
      const made = buildChain(sentence, read, seed, false);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const boss = made.chain.rounds.at(-1)!;
      expect(boss.spec.roles.filter((role) => role.label === 'mouse' && role.kind !== 'collectible'), `${seed} ${boss.key}`).not.toEqual([]);
    }
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

  describe('one mutator per middle round (T16, switched on)', () => {
    // Kolo s mutátorem, který tabulka pro jeho mikrohru nepovoluje, by stavbou prošlo a robot by ho našel až v publikaci.
    const chains = [ROBOT, 'a quiet afternoon', 'dodge pies then throw pies'].flatMap((sentence) => [1, 2, 3, 4, 5, 6].map((seed) => built(sentence, seed, true)));
    const twisted = chains.flatMap((world) => world.rounds.map((round, index) => ({ round, index, last: world.rounds.length - 1 })).filter(({ round }) => round.mutator !== undefined));

    it('draws only from mutator-compat.json, never in round 1 or the boss, with its card', () => {
      expect(twisted.length).toBeGreaterThan(chains.length);
      for (const { round, index, last } of twisted) {
        const id = round.mutator as MutatorId;
        expect(index).toBeGreaterThan(0);
        expect(index).toBeLessThan(last);
        expect(MUTATOR_COMPAT[id]).toContain(round.key);
        expect(MUTATORS[id].visual).toBeUndefined();
        expect(round.twist).toBe(MUTATORS[id].card);
      }
      for (const world of chains) {
        expect(world.rounds[0]!.mutator).toBeUndefined();
        expect(world.rounds.at(-1)!.mutator).toBeUndefined();
      }
    });

    it('stores the mutated world, so the server replays the round with its mutator', () => {
      const mirror = twisted.find(({ round }) => round.mutator === 'mirror');
      expect(mirror).toBeDefined();
      expect(mirror!.round.world.control.id).toBe('mirror_control');
      for (const world of chains) expect(verifyChain(world).failures).toEqual([]);
    });

    it('draws the same mutators from the same seed, and more kinds of chain than the rounds alone', () => {
      const keys = (world: ChainWorld): string => world.rounds.map((round) => `${round.key}${round.mutator === undefined ? '' : `+${round.mutator}`}`).join(' ');
      expect(keys(built(ROBOT, 4, true))).toBe(keys(chains[3]!));
      expect(new Set(chains.map(keys)).size).toBeGreaterThan(new Set(chains.map((world) => world.rounds.map((round) => round.key).join(' '))).size);
    });

    it('leaves the rounds and their layouts as the chain without mutators builds them', () => {
      const plain = built(ROBOT, 4);
      expect(plain.rounds.every((round) => round.mutator === undefined)).toBe(true);
      expect(chains[3]!.rounds.map((round) => round.key)).toEqual(plain.rounds.map((round) => round.key));
      expect(chains[3]!.rounds[0]!.world).toEqual(plain.rounds[0]!.world);
    });
  });

  it('maps every verb class and every world only to MICRO rounds, never to a boss', () => {
    const plain = new Set(MICRO.filter((entry) => entry.boss !== true).map((entry) => entry.key));
    for (const verbClass of VERB_CLASSES) for (const key of VERB_MICROS[verbClass]) expect(plain).toContain(key);
    for (const keys of Object.values(WORLD_MICROS)) for (const key of keys) expect(plain).toContain(key);
  });
});
