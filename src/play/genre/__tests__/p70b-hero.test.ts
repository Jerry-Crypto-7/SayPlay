/**
 * P70B T3: zvíře, které věta jmenuje, zůstane hrdinou. Audit 4. 11. (`evals/play/p70b/dev.json`): „help the rabbit jump“
 * hrála želva, „the rabbit races the turtle“ auto, „feed the hungry rabbits“ průzkumník, „rabbit defends its burrow“
 * rytíř a „baby bunny“ se kreslil jako mimino. Hra vypadá hratelně i se špatnou postavou – oko to nehlídá, proto pin.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { heroChoice, heroModel, riggedModelOf, sceneModelOf } from '@/play/arcade/models';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { counted, RIGGED_ANIMALS } from '@/play/draft/lexicon';
import { extractIntent } from '@/play/intent/extract';

import { GENRE_MODULES } from '../index';

const RABBIT = (JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p70b', 'dev.json'), 'utf8')) as { sentences: { half: string; text: string }[] }).sentences
  .filter((s) => s.half === 'rabbit')
  .map((s) => s.text);
const BUNNY = 'rigged:pet-bunny';

beforeAll(async () => {
  await loadRapier();
});

describe('the named animal stays the hero (P70B T3)', () => {
  it('every rabbit sentence of the audit keeps the rabbit: the hero, or a role drawn as the rabbit', () => {
    expect(RABBIT).toHaveLength(20);
    const lost = RABBIT.filter((text) => {
      const { spec } = draftGameSpecWithMeta(text, 1);
      return heroModel(spec) !== BUNNY && !spec.roles.some((role) => role.kind !== 'player' && heroChoice(role.label, undefined, spec.control, 'enemy').model === BUNNY);
    });
    expect(lost).toEqual([]);
    // „whack the moles but not the bunnies“ je jediná, kde králík hrdinou není – je to, co se nesmí praštit.
    expect(RABBIT.filter((text) => heroModel(draftGameSpecWithMeta(text, 1).spec) !== BUNNY)).toEqual(['whack the moles but not the bunnies']);
  }, 240_000);

  it('help/feed/save the animal makes it the hero only when the sentence has none and the scene animates it', () => {
    expect(extractIntent('help the rabbit jump over holes').hero).toBe('rabbit');
    expect(extractIntent('feed the hungry rabbits').hero).toBe('rabbit');
    expect(extractIntent('save the baby bunnies from the hawk').hero).toBe('bunny');
    // Princezna kreslená s klipy není zvíře; zachraňuje ji hráč, hrdinou nebude.
    expect(extractIntent('save the princess from the dragon').hero).not.toBe('princess');
    // Jmenovaný hrdina vyhrává: „as a fox“ zůstane liškou.
    expect(extractIntent('as a fox, help the rabbit cross the road').hero).toBe('fox');
  });

  it('a whole-game genre takes the sentence hero over its default; a hyphenated verb is no hero', () => {
    expect(draftGameSpecWithMeta('rabbit defends its burrow from snakes', 1).genre?.hero).toBe('rabbit');
    // P70E: holé slovo majitele („rabbit“) hrálo liška z nouze; bez zvířete s klipy zůstane nouze.
    expect(heroModel(draftGameSpecWithMeta('rabbit', 1).spec)).toBe(BUNNY);
    expect(heroModel(draftGameSpecWithMeta('bunnies', 1).spec)).toBe(BUNNY);
    expect(draftGameSpecWithMeta('golf', 1).spec.control).toBe('minigolf');
    expect(extractIntent('ninja cat wall-jumps up a skyscraper').hero).toBe('cat');
    expect(extractIntent('a piano duel between two cats in a jazz bar').hero).toBe('cat');
  }, 60_000);

  it('a race with an animal and nothing to ride runs the animal, a named ride still drives', () => {
    expect(heroChoice('rabbit', undefined, 'steer').model).toBe(BUNNY);
    expect(heroChoice('race car', undefined, 'steer').model).not.toBe(BUNNY);
    expect(heroModel(draftGameSpecWithMeta('the rabbit races the turtle', 1).spec)).toBe(BUNNY);
  }, 60_000);

  it('the scene draws every animated animal as itself, before catalog tags and word vectors', () => {
    expect(RIGGED_ANIMALS.has('rabbit') && RIGGED_ANIMALS.has('bunny') && RIGGED_ANIMALS.has('hare')).toBe(true);
    expect(RIGGED_ANIMALS.has('knight')).toBe(false);
    const wrong = [...RIGGED_ANIMALS].filter((word) => {
      const own = riggedModelOf(word);
      return own === undefined || sceneModelOf(word, true) !== own || sceneModelOf(word, false) !== own || heroChoice(word, undefined, undefined, 'enemy').model !== own;
    });
    expect(wrong).toEqual([]);
    expect(sceneModelOf('baby bunny', true)).toBe(BUNNY);
    expect(sceneModelOf('baby bunny', false)).toBe(BUNNY);
    // U věci rozhoduje hlava fráze: přívlastek-zvíře věc nepřejmenuje.
    expect(sceneModelOf('rabbit hole', false)).not.toBe(BUNNY);
  });
});

describe('counts in goal texts agree with their noun (P70B T3)', () => {
  it('one function says „1 box“ and „3 boxes“', () => {
    expect(counted(1, 'boxes')).toBe('1 box');
    expect(counted(3, 'box')).toBe('3 boxes');
    expect(counted(1, 'wave')).toBe('1 wave');
  });

  it('a one-round duel beats one rival, not „1 boxes“', () => {
    const duel = GENRE_MODULES.duel.compile({ genre: 'duel', mode: 'default', hero: 'boxer', setting: 'gym', cast: [{ label: 'boxes', does: 'fight' }], params: { rounds: 1 } });
    expect(duel.objective.description).toContain('Beat 1 box in a row');
    expect(duel.tutorial.goalLine).toContain('Beat 1 box.');
    const three = GENRE_MODULES.duel.compile({ genre: 'duel', mode: 'default', hero: 'boxer', setting: 'gym', cast: [{ label: 'box', does: 'fight' }], params: { rounds: 3 } });
    expect(three.objective.description).toContain('Beat 3 boxes in a row');
  });
});
