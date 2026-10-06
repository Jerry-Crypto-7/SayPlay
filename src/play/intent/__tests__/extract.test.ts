/**
 * Záměr věty bez modelu (P41 T1). Extraktor, který zahodí druhou akci nebo prohodí
 * aktéra s předmětem, vypadá v ukázce správně – proto pin celých trojic aktér–sloveso–předmět,
 * ne jen přítomnosti slovesa.
 */

import { describe, expect, it } from 'vitest';

import { HERO, type Intent, type IntentAxis } from '../contract';
import { extractIntent } from '../extract';

/** Položky jako „osa:sloveso aktér→předmět“, ať je selhání čitelné. */
const triples = (intent: Intent): string[] => intent.items.map((item) => `${item.axis}:${item.verb} ${item.actor}→${item.object ?? '-'}`);
const verbsOn = (sentence: string, axis: IntentAxis): string[] =>
  extractIntent(sentence)
    .items.filter((item) => item.axis === axis)
    .map((item) => item.verb);

describe('extractIntent – acceptance (P41 T1)', () => {
  it('reads every action of the owner sentence, each played by the car', () => {
    const intent = extractIntent('game in a car with shooting and racing');
    expect(intent.hero).toBe('car');
    expect(triples(intent)).toEqual(['move:drive car→-', 'action:shoot car→-', 'objective:race car→-']);
    expect(intent.items.every((item) => item.essential)).toBe(true);
    expect(intent.negated).toEqual([]);
  });

  it.each([
    ['a car race without guns', 'shoot', 'race'],
    ['a shooting game with no shooting', 'shoot', null],
    ["a racing game where you don't shoot", 'shoot', 'race'],
    ["a knight who doesn't jump but collects gems", 'jump', 'collect'],
    ['a frog collects coins but never jumps', 'jump', 'collect'],
  ])('negation: "%s" drops %s and keeps the rest', (sentence, dropped, kept) => {
    const intent = extractIntent(sentence);
    expect(intent.items.map((item) => item.verb)).not.toContain(dropped);
    expect(intent.negated).toEqual([dropped]);
    if (kept !== null) expect(intent.items.map((item) => item.verb)).toContain(kept);
  });

  it('negation keeps the car of a race without guns driving and racing', () => {
    const intent = extractIntent('a car race without guns');
    expect(intent.hero).toBe('car');
    expect(triples(intent)).toEqual(['move:drive car→-', 'objective:race car→-']);
  });

  it('negation of one target keeps the mechanic, a negated danger stays a danger', () => {
    expect(extractIntent("shoot zombies but don't shoot the hostages").items.map((item) => `${item.verb}→${item.object}`)).toEqual(['shoot→zombie']);
    expect(extractIntent("shoot zombies but don't shoot the hostages").negated).toEqual([]);
    expect(triples(extractIntent("a cat runs across the floor but don't touch the lava"))).toContain(`threat:hazard lava→cat`);
    const noGuards = extractIntent('a cat steals fish with no guards');
    expect(noGuards.negated).toEqual(['guard']);
    expect(verbsOn('a cat steals fish with no guards', 'threat')).toEqual([]);
  });

  it('an unknown verb is an item, never silence', () => {
    expect(extractIntent('a grandma knits a scarf').items).toEqual([{ actor: 'grandma', verb: 'knit', object: 'scarf', axis: 'unknown', essential: true, said: 'knits' }]);
    expect(extractIntent('a grandma knits a scarf').hero).toBe('grandma');
    expect(triples(extractIntent('a game where you bake cookies'))).toEqual([`unknown:bake ${HERO}→cookie`]);
    expect(triples(extractIntent('a knitting game'))).toEqual([`unknown:knit ${HERO}→-`]);
    expect(triples(extractIntent('a knight jumps over puddles and bakes a cake'))).toEqual(['move:jump knight→-', 'threat:obstacle puddle→knight', 'unknown:bake knight→cake']);
  });

  it('who chases whom: actor and object swap with the sentence', () => {
    const dog = extractIntent('a dog chases a cat');
    const cat = extractIntent('a cat chases a dog');
    expect([dog.hero, cat.hero]).toEqual(['dog', 'cat']);
    expect(triples(dog)).toEqual(['objective:catch dog→cat']);
    expect(triples(cat)).toEqual(['objective:catch cat→dog']);
  });

  it.each([
    ['a cat runs from a dog', 'cat', ['objective:escape cat→dog', 'threat:chaser dog→cat']],
    ['escape the zombies', null, [`objective:escape ${HERO}→zombie`, `threat:chaser zombie→${HERO}`]],
    ['a dog chases you', null, [`threat:chaser dog→${HERO}`, `objective:escape ${HERO}→dog`]],
    ['a mouse is chased by a cat', 'mouse', ['objective:escape mouse→cat', 'threat:chaser cat→mouse']],
    ['a fox steals eggs while a farmer chases it', 'fox', ['action:collect fox→egg', 'threat:chaser farmer→fox', 'objective:escape fox→farmer']],
  ])('the chased hero: "%s" is a chaser threat plus escape', (sentence, hero, expected) => {
    const intent = extractIntent(sentence);
    expect(intent.hero).toBe(hero);
    expect(triples(intent)).toEqual(expected);
  });

  it('reads several actions at once', () => {
    const intent = extractIntent('a knight jumps over lava and shoots dragons and collects coins');
    expect(intent.hero).toBe('knight');
    expect(triples(intent)).toEqual(['move:jump knight→-', 'threat:hazard lava→knight', 'action:shoot knight→dragon', 'action:collect knight→coin']);
  });
});

describe('extractIntent – vocabulary', () => {
  it.each(['a truck delivers boxes to a farm', 'a bike race', 'a motorcycle jumps over cars', 'a boat collects treasure', 'a kart race against rivals', 'drive a car through the city'])(
    'a vehicle hero drives: "%s"',
    (sentence) => {
      const intent = extractIntent(sentence);
      expect(intent.items).toContainEqual(expect.objectContaining({ axis: 'move', verb: 'drive', actor: intent.hero }));
    },
  );

  it.each([
    ['a fish swims through a coral reef', 'glide'],
    ['a bird flies over the mountains', 'glide'],
    ['a paper plane glides through a house', 'glide'],
    ['a duck dives into a pond', 'glide'],
    ['a helicopter rescues people', 'glide'],
    ['a cat sneaks past guards', 'walk'],
    ['tiptoe through a dark house', 'walk'],
    ['a mouse in a maze', 'walk'],
    ['explore a labyrinth', 'walk'],
    ['a robot walks through the city', 'walk'],
    ['a corgi runs through a park', 'run'],
    ['a ninja dashes across rooftops', 'run'],
    ['a penguin skis down a mountain', 'run'],
    ['a girl surfs giant waves', 'run'],
    ['a girl skates through a city', 'run'],
    ['a frog hops across lily pads', 'jump'],
    ['a monkey climbs a tree', 'jump'],
    ['a platformer with a robot', 'jump'],
    ['a flappy bird game', 'flap'],
    ['a bat flaps through a cave', 'flap'],
    ['a fish eats smaller fish and grows', 'roam'],
    ['a soccer game', 'ball'],
    ['basketball with a giraffe', 'ball'],
    ['golf on the moon', 'ball'],
    ['a kid kicks a ball', 'ball'],
  ])('"%s" moves by %s', (sentence, move) => {
    expect(verbsOn(sentence, 'move')).toContain(move);
  });

  it('a stealth sentence carries the guards as a threat aimed at the hero', () => {
    expect(triples(extractIntent('a cat sneaks past guards to steal a fish'))).toEqual(['move:walk cat→-', 'threat:guard guard→cat', 'action:collect cat→fish']);
    expect(verbsOn('steal a diamond without being seen', 'threat')).toEqual(['guard']);
  });

  it('a ball game is played to score, and who plays against the hero is a rival', () => {
    expect(triples(extractIntent('a penguin plays football against a walrus'))).toEqual(['move:ball penguin→-', 'objective:score penguin→-', 'threat:rival walrus→penguin']);
    expect(verbsOn('a kid kicks a ball', 'objective')).toEqual(['score']);
  });

  it('racing with rivals is a race objective plus a rival threat', () => {
    expect(triples(extractIntent('a horse races against rivals'))).toEqual(['objective:race horse→rival', 'threat:rival rival→horse']);
    expect(verbsOn('a car race in a city with traffic', 'threat')).toEqual(['obstacle']);
  });

  it.each([
    ['stack blocks to build the tallest tower', 'action', 'stack'],
    ['stack blocks to build the tallest tower', 'objective', 'build'],
    ['a cat dances to the music', 'action', 'beat'],
    ['press the button at the right moment', 'action', 'time'],
    ['argue with my boss', 'action', 'duel'],
    ['negotiate a raise with a dragon', 'action', 'duel'],
    ['a ninja fights robots', 'action', 'fight'],
    ['a knight defeats a dragon', 'objective', 'defeat'],
    ['light all the lanterns', 'action', 'interact'],
    ['light all the lanterns', 'objective', 'collect'],
    ['a knight rescues the princess', 'objective', 'reach'],
    ['deliver pizza to customers', 'action', 'deliver'],
    ['survive 60 seconds', 'objective', 'survive'],
    ['a frog throws rocks at birds', 'action', 'throw'],
  ])('"%s" has %s %s', (sentence, axis, verb) => {
    expect(verbsOn(sentence, axis as IntentAxis)).toContain(verb);
  });

  it('reads the partner of a duel and the target of a thrown tool', () => {
    expect(triples(extractIntent('play chess with a dragon'))).toEqual([`action:duel ${HERO}→dragon`]);
    expect(triples(extractIntent('a frog throws rocks at birds'))).toEqual(['action:throw frog→bird']);
  });

  it('a guessed fight yields to an action the sentence says', () => {
    const knight = extractIntent('a knight defeats a dragon');
    expect(triples(knight)).toEqual(['objective:defeat knight→dragon', 'action:fight knight→dragon']);
    expect(knight.items.find((item) => item.verb === 'fight')?.essential).toBe(false);
    expect(verbsOn('shoot and defeat the aliens', 'action')).toEqual(['shoot']);
  });

  it('what the hero puts out or shoots is not a threat', () => {
    expect(triples(extractIntent('a firefighter puts out fires'))).toEqual(['action:interact firefighter→fire', 'objective:collect firefighter→fire']);
    expect(verbsOn('a robot shoots lasers at aliens', 'threat')).toEqual([]);
  });

  it('scenery is not essential, what the sentence asks for is', () => {
    const cave = extractIntent('a knight explores a lava cave');
    expect(cave.items.map((item) => [item.verb, item.essential])).toEqual([
      ['walk', true],
      ['hazard', false],
    ]);
  });

  it.each([
    ['a car race in a city at night', 'city'],
    ['a fish in the ocean', 'ocean'],
    ['a diver under the sea', 'underwater'],
    ['a space shooter', 'space'],
    ['a fox in a forest', 'forest'],
    ['a camel crosses the desert', 'desert'],
    ['a penguin slides on snow', 'snow'],
    ['a ghost at night', 'night'],
    ['a monkey in the jungle', 'jungle'],
    ['a knight storms a castle', 'castle'],
    ['escape the volcano', 'volcano'],
    ['a cozy game', null],
  ])('"%s" is set in %s', (sentence, setting) => {
    expect(extractIntent(sentence).setting).toBe(setting);
  });

  it('counts come from the sentence, lives too', () => {
    expect(extractIntent('collect 10 coins with 3 lives').counts).toEqual([
      { count: 10, noun: 'coins' },
      { count: 3, noun: 'lives' },
    ]);
    expect(extractIntent('survive 60 seconds with one life').counts).toEqual([
      { count: 60, noun: 'seconds' },
      { count: 1, noun: 'lives' },
    ]);
    expect(verbsOn('collect 10 coins with 3 lives', 'objective')).toEqual(['collect']);
  });

  // Tiché chyby nalezené na korpusu `evals/play/demand`: vypadají jako čtení, ale aktér nebo předmět je špatně.
  it('a compound word, a plural noun or a bare object does not invent actors, verbs or rivals', () => {
    expect(extractIntent('water gun fight in a backyard').hero).toBeNull();
    expect(verbsOn('motorbike stunts on crazy ramps', 'unknown')).toEqual([]);
    expect(triples(extractIntent('shoot balloons with a bow'))).toEqual([`action:shoot ${HERO}→balloon`]);
    expect(verbsOn('basketball free throws', 'threat')).toEqual([]);
    expect(triples(extractIntent('a pirate ship fires cannons at other ships'))).toEqual(['move:drive ship→-', 'action:shoot ship→ship']);
  });

  it('a sleeping guard and a second clause keep their own actors', () => {
    expect(triples(extractIntent('a mouse sneaks through a house without waking the cat'))).toEqual(['move:walk mouse→-', 'threat:guard cat→mouse']);
    expect(triples(extractIntent('a farmer drives a tractor and harvests carrots'))).toEqual(['move:drive farmer→tractor', 'unknown:harvest farmer→carrot']);
    expect(triples(extractIntent('a wolf chases a fox who collects berries'))).toEqual(['objective:catch wolf→fox', 'action:collect fox→berry']);
  });

  it('a space shooter shoots in space, a zombie shooter shoots zombies', () => {
    expect(extractIntent('a space shooter').hero).toBeNull();
    expect(triples(extractIntent('a zombie shooter'))).toEqual([`action:shoot ${HERO}→zombie`]);
  });
});
