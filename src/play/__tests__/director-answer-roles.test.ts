/**
 * Co AI verze přidá a co nesmí rozbít (P32B T7, z náhledu O10). Všechno by
 * vypadalo dobře a bylo špatně: „without hitting a rocks“ je jen o písmeno
 * delší, hasič, kterého honí jeho vlastní voda, hru dohraje, a AI verze, která
 * opíše rychlou, projde každou kontrolou. Model se nevolá – odpovědi jsou zmrazené.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { goldenPrompts } from '../../../evals/play/golden';
import sentenceSet from '../../../evals/play/p32/sentences.json';
import { answered, fakeBranch } from '../director/__fixtures__/branch';
import { buildCompactRequest } from '../director/compact';
import { fidelity } from '../director/critic';
import { direct } from '../director/index';
import { buildDirectorRequest } from '../director/prompt';
import { readGenreAnswer } from '../director/read';
import { draftGameSpecWithMeta } from '../draft';
import { readRoles, singular, toolsOf } from '../draft/lexicon';
import type { GenreSpec } from '../genre/contract';

const sentence = (id: string): string => sentenceSet.sentences.find((entry) => entry.id === id)!.text;
const draftOf = (text: string) => {
  const meta = draftGameSpecWithMeta(text);
  if (meta.genre === null || meta.genre === undefined) throw new Error(`no genre for ${text}`);
  return { genre: meta.genre, spec: meta.spec };
};
const answer = (spec: GenreSpec) => ({ plan: 'frozen', spec });
const directed = (text: string, spec: GenreSpec) => direct(text, { branch: fakeBranch([answered(answer(spec))]), now: () => 0 });

describe('the director answer, read like the quick version', () => {
  it('turns plural role labels singular, so the goal line matches the quick version', () => {
    const penguin = draftOf(sentence('penguin'));
    const chef = draftOf(sentence('chef'));
    const plural = [
      { quick: penguin.spec, written: { ...penguin.genre, enemy: 'rocks', collectible: 'snowflakes' } },
      { quick: chef.spec, written: { ...chef.genre, target: { ...chef.genre.target!, label: 'pancakes' } } },
    ];
    for (const { quick, written } of plural) {
      const read = readGenreAnswer(answer(written));
      if (!read.ok) throw new Error(read.detail);
      expect(read.spec.objective.description).toBe(quick.objective.description);
    }
    expect(penguin.spec.objective.description).toContain('a rock.');
    expect(chef.spec.objective.description).toContain('pancake ');
  });

  it('keeps -us words, names and irregular plurals whole when it makes a label singular', () => {
    expect(['wolves', 'knives', 'mice', 'octopus', 'bus', 'Thomas', 'glowing fish', 'burning trees'].map(singular)).toEqual(['wolf', 'knife', 'mouse', 'octopus', 'bus', 'Thomas', 'glowing fish', 'burning tree']);
  });

  // Revize fáze 3, nález 3: „horses“ dávalo „hors“ a „cyclops“ „cyclop“ – teď jím prochází každý popisek režiséra.
  it('drops only the -s of -se words, keeps -s singulars and changes nothing on a second pass', () => {
    const words = ['horses', 'wild horses', 'houses', 'burning houses', 'roses', 'glasses', 'boxes', 'torches', 'bushes', 'buses', 'viruses', 'cactuses', 'cyclops', 'lens', 'gas', 'species', 'news'];
    expect(words.map(singular)).toEqual(['horse', 'wild horse', 'house', 'burning house', 'rose', 'glass', 'box', 'torch', 'bush', 'bus', 'virus', 'cactus', 'cyclops', 'lens', 'gas', 'species', 'news']);
    for (const word of words) expect(singular(singular(word)), word).toBe(singular(word));
    expect(draftOf('A farmer escapes from wild horses on a ranch').genre.enemy).toBe('wild horse');
  });

  // Revize fáze 3, kolo 2, nález 3: zúžené pravidlo -se zkazilo -us a -s slova („bonuses“ → „bonuse“).
  it('makes -us, -as, -is and -se plurals singular alike, and a second pass changes nothing', () => {
    const table: [string, string][] = [
      ['bonuses', 'bonus'], ['hippopotamuses', 'hippopotamus'], ['angry hippopotamuses', 'angry hippopotamus'], ['campuses', 'campus'],
      ['platypuses', 'platypus'], ['crocuses', 'crocus'], ['geniuses', 'genius'], ['atlases', 'atlas'], ['canvases', 'canvas'],
      ['irises', 'iris'], ['biases', 'bias'], ['quizzes', 'quiz'], ['buses', 'bus'], ['viruses', 'virus'], ['octopuses', 'octopus'],
      ['cactuses', 'cactus'], ['walruses', 'walrus'], ['circuses', 'circus'], ['gases', 'gas'], ['lenses', 'lens'],
      ['horses', 'horse'], ['wild horses', 'wild horse'], ['houses', 'house'], ['burning houses', 'burning house'], ['blouses', 'blouse'],
      ['causes', 'cause'], ['fuses', 'fuse'], ['roses', 'rose'], ['cases', 'case'], ['vases', 'vase'], ['noses', 'nose'],
      ['glasses', 'glass'], ['boxes', 'box'], ['torches', 'torch'], ['bushes', 'bush'], ['buzzes', 'buzz'],
      ['cyclops', 'cyclops'], ['lens', 'lens'], ['gas', 'gas'], ['bias', 'bias'], ['iris', 'iris'], ['bonus', 'bonus'],
      ['species', 'species'], ['news', 'news'], ['candles', 'candle'], ['wolves', 'wolf'], ['zombies', 'zombie'], ['dummies', 'dummy'],
    ];
    expect(table.map(([word]) => [word, singular(word)])).toEqual(table);
    for (const [word, one] of table) expect(singular(one), word).toBe(one);
    expect(draftOf('A robot collects bonuses in a factory').spec.objective.description).not.toMatch(/bonuse\b/);
  });

  it('every role label the draft writes for the golden and demand sentences is already singular', () => {
    const demand = JSON.parse(readFileSync('evals/play/demand/corpus.json', 'utf8')) as { readonly text: string }[];
    for (const text of [...goldenPrompts().map((entry) => entry.prompt), ...demand.map((entry) => entry.text)]) {
      const genre = draftGameSpecWithMeta(text).genre;
      for (const label of [genre?.enemy, genre?.collectible, genre?.target?.label]) if (label !== undefined) expect(singular(label), `${text}: ${label}`).toBe(label);
    }
  });
});

describe('the thing the player uses is never a role', () => {
  const FIRE = sentence('firefighter');
  const WATER_CHASES: GenreSpec = {
    genre: 'quest',
    mode: 'spatial',
    hero: 'firefighter robot',
    enemy: 'water',
    target: { label: 'burning trees', verb: 'extinguish', states: 2 },
    setting: 'burning forest',
    params: { chasers: 2 },
  };

  it('reads the tools out of the sentence', () => {
    const texts = [FIRE, 'A kid throws water balloons at bullies', 'An elf shoots arrows at goblins', 'Shoot the zombies in a mall', 'A cat swings from vines'];
    expect(texts.map(toolsOf)).toEqual([['water'], ['water balloon'], ['arrow'], [], []]);
    expect(toolsOf('A bully throws rocks while a kid throws snowballs')).toEqual(['rock', 'snowball']);
  });

  // B-R12, třetí přístup: dvě opravy čtení podmětu padly („She's spraying“, „Firefighters spray“ bez hrdiny).
  // Pravidlo teď podmět nečte vůbec – předmět slovesa nástroje nikdy nehoní, ať ho vrhá kdokoli.
  it('never lets the object of a tool verb chase, whoever does the verb', () => {
    const toolIssue = expect.objectContaining({ code: 'ENEMY_IS_TOOL' });
    const WATER = [
      'A firefighter robot runs into the forest and she sprays water at burning trees',
      'The player sprays water at burning trees in a forest',
      "She's spraying water at burning trees in a forest",
      "I'm spraying water at burning trees in a forest",
      "We're firefighters spraying water at burning trees",
      "You're spraying water at burning fires in a city",
      'Anna sprays water at burning trees in a forest',
      'Firefighters spray water at burning trees in a forest',
    ];
    for (const text of WATER) {
      expect(toolsOf(text), text).toEqual(['water']);
      expect(draftOf(text).genre.enemy, text).not.toBe('water');
      expect(readRoles(text).hazard, text).not.toBe('water');
      expect(fidelity({ ...draftOf(text).genre, enemy: 'water' }, text), text).toContainEqual(toolIssue);
    }
    expect(readRoles('A firefighter runs inside and she sprays water at the fire').hazard).toBe('fire');
    // Obr kámen hází, kámen proto nikoho nehoní – obr sám honit smí (revize T7, nález 6).
    for (const giantText of ['An angry giant throws rocks at the village', 'An angry giant who hates the hero throws rocks at the village', 'An angry giant roars and throws rocks at the village']) {
      const giant = draftOf(giantText).genre;
      expect(giant.enemy, giantText).not.toBe('rock');
      expect(fidelity({ ...giant, hero: 'villager', enemy: 'rock' }, giantText), giantText).toContainEqual(toolIssue);
      expect(fidelity({ ...giant, hero: 'villager', enemy: 'angry giant' }, giantText), giantText).not.toContainEqual(toolIssue);
    }
    expect(toolsOf('Goblins that chase the player throw spears in a cave')).toEqual(['spear']);
    expect(toolsOf('A knight fights a dragon that throws fireballs')).toEqual(['fireball']);
    for (const text of ['defend a castle and throw snowballs at dragons', 'Throw snowballs at snowmen in a park', 'defend a castle from dragons by throwing snowballs', 'Play as a kid who throws snowballs at bullies']) {
      expect(toolsOf(text), text).toEqual(['snowball']);
    }
    expect(toolsOf('fps where u shoot paint at robots')).toEqual(['paint']);
  });

  it('rejects an answer whose chaser is the water the firefighter sprays, with the reason', () => {
    const read = readGenreAnswer(answer(WATER_CHASES));
    if (!read.ok) throw new Error(read.detail);
    expect(read.spec.objective.description).toContain('before the water catch');
    expect(fidelity(read.genre, FIRE)).toContainEqual(expect.objectContaining({ code: 'ENEMY_IS_TOOL', path: '/enemy', evidence: expect.stringContaining('"water"') }));
  });

  it('repairs it with the enemy and the chaser count of the sentence, so nothing chases the firefighter', async () => {
    const game = await directed(FIRE, WATER_CHASES);
    expect(game.fallbackReason).toBeNull();
    expect(game.spec.roles.map((role) => role.label)).not.toContain('water');
    expect(game.spec.roles.some((role) => role.kind === 'chaser')).toBe(false);
    expect(game.spec.objective.description).toBe('Extinguish all 5 burning tree within 40 seconds.');
  });

  it('keeps the quick version off the tool too', () => {
    expect(draftOf(FIRE).spec.roles.map((role) => role.label)).not.toContain('water');
    expect(draftOf('An elf shoots arrows at goblins in a forest').genre.target?.label).toBe('goblin');
  });
});

describe('the AI version adds what the sentence says and the quick version misses', () => {
  const SNOW = 'A kid throws snowballs at a snowman while a dog chases him';

  it('asks for it in both prompt forms', () => {
    const quick = draftOf(SNOW).genre;
    for (const request of [buildDirectorRequest(SNOW, quick), buildCompactRequest(SNOW, quick, true)]) {
      expect(request.system).toContain('add one thing the sentence says and it misses');
      expect(request.system).toContain('Role labels are singular');
      expect(request.system).toContain('The enemy is never what the player holds, sprays or throws');
    }
  });

  it('plays the chaser the sentence names when the frozen answer adds it', async () => {
    const quick = draftOf(SNOW);
    expect(quick.spec.roles.some((role) => role.kind === 'chaser')).toBe(false);
    const game = await directed(SNOW, { ...quick.genre, params: { ...quick.genre.params, chasers: 1 } });
    expect(game.source).toBe('authored');
    expect(game.fallbackReason).toBeNull();
    expect(game.spec.roles).toContainEqual(expect.objectContaining({ kind: 'chaser', label: 'dog' }));
    expect(game.spec.objective.description).not.toBe(quick.spec.objective.description);
  });
});
