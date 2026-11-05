/**
 * P71D: věta porotce dostane hru podle svého slovesa a postavy. QA 5. 11. (`evals/play/p71/qa/findings.json`, mimo git):
 * „spaceship shoots asteroids“ hrála kroužky („Drag… to swim“), „toss basketballs“ a „whack the moles“ liška,
 * „find the lost crown“ sběr ve vlnách, chytání, slučování a pizzerie generický „Explorer“. Hra s cizí postavou
 * nebo cizím slovesem pořád vypadá hratelně – oko to nehlídá, proto pin. Každá věta z QA a tři parafráze.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_HZ } from '@/play/arcade/contract';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { heroModel } from '@/play/arcade/models';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { singular } from '@/play/draft/lexicon';

interface Case {
  readonly sentence: string;
  /** Věta z QA (ostatní jsou parafráze). */
  readonly qa?: true;
  readonly genres: readonly string[];
  /** Přípustná hlava popisku hrdiny; `null` = věta hrdinu neříká a žánr ho nevolí podle činnosti. */
  readonly heroes: readonly string[] | null;
  /** Co hra musí obsahovat jako terč nebo předmět (hlava popisku role). */
  readonly thing?: readonly string[];
}

const SHOOT = ['shooter', 'railfps'];
const CRAFT = ['spaceship', 'rocket'];
const ROCKS = ['asteroid', 'meteor'];

const CASES: readonly Case[] = [
  { sentence: 'a spaceship shoots asteroids in outer space', qa: true, genres: SHOOT, heroes: CRAFT, thing: ROCKS },
  { sentence: 'a rocket blasts meteors', genres: SHOOT, heroes: CRAFT, thing: ROCKS },
  { sentence: 'a spaceship fires lasers at asteroids', genres: SHOOT, heroes: CRAFT, thing: ROCKS },
  { sentence: 'my rocket shoots down meteors in space', genres: SHOOT, heroes: CRAFT, thing: ROCKS },

  { sentence: 'toss basketballs into the hoop', qa: true, genres: ['throw'], heroes: ['kid'] },
  { sentence: 'throw a basketball into the hoop', genres: ['throw'], heroes: ['kid'] },
  { sentence: 'score baskets by tossing the ball into the hoop', genres: ['throw'], heroes: ['kid'] },
  { sentence: 'toss a ball into the basket', genres: ['throw'], heroes: ['kid'] },

  { sentence: 'whack the moles in the garden', qa: true, genres: ['whack'], heroes: ['farmer'] },
  { sentence: 'hit moles with a hammer', genres: ['whack'], heroes: ['farmer'] },
  { sentence: 'bonk the moles as they pop out of their holes', genres: ['whack'], heroes: ['farmer'] },
  { sentence: 'smash the moles before they eat the carrots', genres: ['whack'], heroes: ['farmer'] },

  { sentence: 'a wizard explores a dungeon to find the lost crown', qa: true, genres: ['quest'], heroes: ['wizard'], thing: ['crown'] },
  { sentence: "search for the king's crown", genres: ['quest'], heroes: null, thing: ['crown'] },
  { sentence: 'a knight looks for the lost sword in the castle', genres: ['quest'], heroes: ['knight'], thing: ['sword'] },
  { sentence: 'find the hidden treasure in the cave', genres: ['quest'], heroes: null, thing: ['treasure'] },

  { sentence: 'catch falling donuts and dodge the bombs', qa: true, genres: ['catch'], heroes: ['baker'] },
  { sentence: 'catch the falling apples in a basket', genres: ['catch'], heroes: ['farmer'] },
  { sentence: 'a kid catches candy falling from the sky', genres: ['catch'], heroes: ['kid'] },
  { sentence: 'catch the falling cookies but not the rocks', genres: ['catch'], heroes: ['baker'] },

  { sentence: 'merge matching fruits in a jar', qa: true, genres: ['merge'], heroes: ['farmer'] },
  { sentence: 'combine two of the same fruit to make a bigger one', genres: ['merge'], heroes: ['farmer'] },
  { sentence: 'merge two matching fruits into a bigger fruit', genres: ['merge'], heroes: ['farmer'] },
  { sentence: 'merge the cupcakes to make a giant cake', genres: ['merge'], heroes: ['baker'] },

  { sentence: 'run a pizza shop and serve 12 customers', qa: true, genres: ['buildshift'], heroes: ['chef'] },
  { sentence: 'a chef runs a pizza shop', genres: ['buildshift'], heroes: ['chef'] },
  { sentence: 'open a burger restaurant and feed hungry customers', genres: ['buildshift'], heroes: ['chef'] },
  { sentence: 'bake pizzas and serve customers in your pizzeria', genres: ['buildshift'], heroes: ['chef'] },
];

/** Výchozí postavy, které věta neřekla: liška, průzkumník a „player“ (kreslí se jako rytíř). */
const FILLERS = ['rigged:q-fox', 'rigged:q-cowboy-hair', 'knight'];

const head = (label: string): string => singular(label.toLowerCase()).split(' ').at(-1) ?? label;

function miss(test: Case): string | null {
  const meta = draftGameSpecWithMeta(test.sentence, 1);
  const { spec } = meta;
  const genre = meta.genre?.genre ?? spec.genre?.id ?? null;
  const hero = spec.roles.find((role) => role.kind === 'player')?.label ?? '';
  const model = heroModel(spec);
  const said = (word: string): boolean => test.sentence.toLowerCase().includes(word);
  const text = [spec.tutorial.goalLine, spec.tutorial.controlsHint, spec.objective.description].join(' ');
  const wrong: string[] = [];
  if (genre === null || !test.genres.includes(genre)) wrong.push(`genre ${String(genre)}`);
  if (test.heroes !== null && !test.heroes.includes(head(hero))) wrong.push(`hero ${hero}`);
  if (FILLERS.includes(model) && !said('fox') && !said('cowboy') && !said('knight')) wrong.push(`model ${model}`);
  if (test.thing !== undefined && !spec.roles.some((role) => role.kind !== 'player' && test.thing!.includes(head(role.label)))) wrong.push(`no ${test.thing.join('/')}`);
  if (/\bswim/i.test(text) && !said('swim') && !said('fish')) wrong.push('swim hint');
  if (test.genres.includes('quest') && /\bwaves?\b/i.test(text)) wrong.push('waves');
  return wrong.length === 0 ? null : `${test.sentence}: ${wrong.join(', ')}`;
}

beforeAll(() => loadRapier());

describe('a sentence plays the game its verb and hero name (P71D)', () => {
  it('has every wrong-genre and wrong-hero sentence of the QA, each with three paraphrases', () => {
    expect(CASES.filter((test) => test.qa === true)).toHaveLength(7);
    expect(CASES).toHaveLength(28);
  });

  it.each(CASES)('$sentence gets the expected genre, hero and thing', (test) => {
    expect(miss(test)).toBeNull();
  }, 120_000);
});

describe('a craft that shoots at a thing plays the shooter (P71D T2)', () => {
  it('an idle player of a shoot sentence loses no sooner than 5 s in', () => {
    const early = CASES.filter((test) => test.genres === SHOOT).flatMap((test) => {
      const made = arcadeWorldOf(draftGameSpecWithMeta(test.sentence, 1).spec, 1);
      if (!made.ok) return [`${test.sentence}: ${made.issues.join('; ')}`];
      const idle = replay(made.world, [], ARCADE_LIBRARY);
      return idle.outcome === 'lost' && idle.tick >= 5 * ARCADE_HZ ? [] : [`${test.sentence}: ${idle.outcome} at ${String(idle.tick)}`];
    });
    expect(early).toEqual([]);
  }, 120_000);

  it('a flying craft or bird in a glide course flies; a fish, a penguin and a submarine swim', () => {
    const hint = (sentence: string): string => draftGameSpecWithMeta(sentence, 1).spec.tutorial.controlsHint;
    for (const sentence of ['a plane flies through the clouds', 'an eagle glides over the mountains']) expect(hint(sentence)).toMatch(/\bto fly\b/);
    for (const sentence of ['a fish swims through the reef', 'a submarine shoots torpedoes at sharks']) expect(hint(sentence)).toMatch(/\bto swim\b/);
  }, 120_000);
});

describe('finding one thing is a quest, collecting many stays the arena (P71D T4)', () => {
  it('a found thing is one quest target in one round', () => {
    const { spec } = draftGameSpecWithMeta('find the lost crown', 1);
    expect(spec.genre?.id).toBe('quest');
    expect(spec.roles.find((role) => role.kind === 'target')?.count).toBe(1);
    expect(spec.tutorial.goalLine).not.toMatch(/\brounds?\b/);
  }, 120_000);

  it.each(['collect 10 crowns', 'find 5 keys', 'find all the coins in the forest'])('%s stays the arena collect', (sentence) => {
    const meta = draftGameSpecWithMeta(sentence, 1);
    expect(`${String(meta.genre?.genre)}.${String(meta.genre?.mode)}`).toBe('arena.collect');
  }, 120_000);
});
