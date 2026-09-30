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
import { singular, toolOf } from '../draft/lexicon';
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

  it('reads the tool out of the sentence', () => {
    const heroes: [string, string | null][] = [[FIRE, 'firefighter robot'], ['A kid throws water balloons at bullies', 'kid'], ['An elf shoots arrows at goblins', 'elf'], ['Shoot the zombies in a mall', null], ['A cat swings from vines', 'cat']];
    expect(heroes.map(([text, hero]) => toolOf(text, hero))).toEqual(['water', 'water balloon', 'arrow', null, null]);
  });

  // B-R12: nástroj je jen to, co dělá hrdina – co hází obr nebo drak, hráčovo není.
  it('takes the tool only from a verb the hero does', () => {
    const GIANT = 'An angry giant throws rocks at the village';
    expect(toolOf(GIANT, 'angry giant')).toBe('rock');
    expect(toolOf(GIANT, 'villager')).toBeNull();
    expect(toolOf('A villager hides while an angry giant throws rocks at the village', 'villager')).toBeNull();
    expect(toolOf('A knight fights a dragon that throws fireballs', 'knight')).toBeNull();
    expect(toolOf('Play as a kid who throws snowballs at bullies', 'kid')).toBe('snowball');
    expect(toolOf('A kid runs and throws snowballs at bullies', 'kid')).toBe('snowball');
    expect(toolOf('An angry giant roars and throws rocks at the village', 'villager')).toBeNull();
    expect(toolOf('defend a castle and throw snowballs at dragons', null)).toBe('snowball');
    expect(toolOf('A bully throws rocks while a kid throws snowballs', 'kid')).toBe('snowball');
    expect(toolOf('Throw snowballs at snowmen in a park', null)).toBe('snowball');
    expect(toolOf('defend a castle from dragons by throwing snowballs', null)).toBe('snowball');
    expect(toolOf('fps where u shoot paint at robots', null)).toBe('paint');
    // Revize B-R12: zájmeno a „the player“ jsou hrdina – jinak by se voda hasiče zas stala nepřítelem.
    const SHE = 'A firefighter robot runs into the forest and she sprays water at burning trees';
    expect(toolOf(SHE, 'firefighter robot')).toBe('water');
    expect(toolOf('The player sprays water at burning trees in a forest', null)).toBe('water');
    expect(draftOf(SHE).genre.enemy).not.toBe('water');
    expect(fidelity({ ...draftOf(SHE).genre, enemy: 'water' }, SHE)).toContainEqual(expect.objectContaining({ code: 'ENEMY_IS_TOOL' }));
    // Kritik soudí hrdinu odpovědi: vesničana kámen honit smí, obra ne.
    const giant = draftOf(GIANT).genre;
    const toolIssue = expect.objectContaining({ code: 'ENEMY_IS_TOOL' });
    expect(fidelity({ ...giant, hero: 'villager', enemy: 'rock' }, GIANT)).not.toContainEqual(toolIssue);
    expect(fidelity({ ...giant, hero: 'giant', enemy: 'rock' }, GIANT)).toContainEqual(toolIssue);
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
