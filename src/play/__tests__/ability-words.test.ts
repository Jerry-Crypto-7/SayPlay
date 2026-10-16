/**
 * Sloveso věty na tlačítku akce a v nápovědě (P47B T10). Obecné „Strike“ u věty, která říká
 * „shoves“, by prošlo každým snímkem, a sloveso věty by přesto zůstalo neviditelné – test proto
 * hlídá, že slovo jde z věty („shoves“ → Shove, „dodges“ → Dodge), že slovo mimo uzavřený seznam
 * spec odmítne a že hra bez `abilityWords` má popisky i nápovědu jako dřív a svět bajt po bajtu stejný.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ABILITY_FACES, AbilityButton } from '@/components/play/arcade/ActionButton';
import type { ArcadeSession } from '@/components/play/arcade/session';

import { ABILITIES } from '../arcade/contract';
import { arcadeWorldOf } from '../arcade/compile';
import { ABILITY_WORDS, abilityHint, abilityWordsOf, saidAbilityWords } from '../draft/controls';
import { draftGameSpec } from '../draft';
import { type GameSpecV1, readGameSpec } from '../spec';

const SQUIRREL = 'A squirrel runs and dodges falling acorns';
const SUMO = 'a sumo bear shoves rivals out of the ring';
/** „attacks“ seznam nemá: tlačítko i nápověda zůstávají obecné. */
const GENERIC = 'A knight runs through a castle and attacks goblins';

const without = ({ abilityWords: _words, ...spec }: GameSpecV1): GameSpecV1 => spec;

describe('the closed word list', () => {
  it('holds the verbs each ability may show, the generic label first', () => {
    expect(ABILITY_WORDS).toEqual({
      shoot: ['Shoot', 'Zap', 'Blast', 'Fire'],
      strike: ['Strike', 'Shove', 'Punch', 'Kick', 'Bite', 'Peck', 'Slash'],
      dash: ['Dash', 'Dodge', 'Duck', 'Swerve'],
      shield: ['Shield', 'Block', 'Guard', 'Deflect'],
      grab: ['Grab', 'Steal', 'Snatch', 'Swipe'],
    });
    // Obecný popisek tlačítka je první slovo seznamu – hra bez slov ukáže totéž co dřív.
    for (const id of ABILITIES) expect(ABILITY_WORDS[id][0]).toBe(ABILITY_FACES[id].label);
  });
});

describe('the word comes from the sentence', () => {
  it.each([
    [SUMO, { strike: 'Shove' }],
    [SQUIRREL, { dash: 'Dodge' }],
    ['a knight fights and punches goblins', { strike: 'Punch' }],
    ['a chicken pecks worms and ducks under branches', { strike: 'Peck', dash: 'Duck' }],
    ['a wizard zaps ghosts and blocks fireballs', { shoot: 'Zap', shield: 'Block' }],
    ['a raccoon snatches snacks and swerves past dogs', { grab: 'Snatch', dash: 'Swerve' }],
    // Sloveso bez slova v seznamu nechá obecný popisek; sloveso v záporu ani sloveso nepřítele slovo nedá.
    ['a knight fights goblins', {}],
    ["a fox doesn't punch anyone and dodges cars", { dash: 'Dodge' }],
    ['a fish swims while sharks bite', {}],
  ])('%s → %o', (sentence, words) => {
    expect(saidAbilityWords(sentence.toLowerCase())).toEqual(words);
  });

  it('the squirrel game gets Dodge on J and says it in the hint', () => {
    const spec = draftGameSpec(SQUIRREL);
    expect(spec.abilities).toEqual(['dash']);
    expect(spec.abilityWords).toEqual(['Dodge']);
    expect(spec.tutorial.controlsHint).toMatch(/ J to dodge\.$/);
    expect(spec.tutorial.controlsHint.length).toBeLessThanOrEqual(80);
  });

  it('the sumo duel says shove in its own hint', () => {
    const spec = draftGameSpec(SUMO);
    expect(spec.control).toBe('duel');
    expect(spec.abilities).toEqual(['strike']);
    expect(spec.abilityWords).toEqual(['Shove']);
    expect(spec.tutorial.controlsHint).toBe('Tap right or Space to shove, tap left or Down to dodge.');
  });

  it('a sentence whose verb has no word keeps the generic label and hint', () => {
    const spec = draftGameSpec(GENERIC);
    expect(spec.abilities).toEqual(['strike']);
    expect(spec.abilityWords).toBeUndefined();
    expect(spec.tutorial.controlsHint).toMatch(/ J to strike\.$/);
  });

  it('fills a slot the sentence has no word for with the generic label', () => {
    expect(abilityWordsOf(['strike', 'dash'], { dash: 'Dodge' })).toEqual(['Strike', 'Dodge']);
    expect(abilityWordsOf(['strike', 'dash'], { strike: 'Strike' })).toBeUndefined();
    expect(abilityHint(['strike', 'dash'], ['Strike', 'Dodge'])).toBe('J to strike, K to dodge.');
    expect(abilityHint(['strike', 'dash'])).toBe('J to strike, K to dash.');
  });
});

describe('the spec keeps the word honest', () => {
  const base = draftGameSpec(SQUIRREL);

  it('accepts the sentence word and rejects a word outside the closed list', () => {
    expect(readGameSpec(base).ok).toBe(true);
    for (const abilityWords of [['Smash'], ['Punch'], ['dodge']]) {
      const read = readGameSpec({ ...base, abilityWords });
      expect(read.ok, abilityWords[0]).toBe(false);
      if (!read.ok) expect(read.reason).toBe('MALFORMED_SPEC');
    }
  });

  it('rejects words that do not line up with the abilities', () => {
    const extra = readGameSpec({ ...base, abilityWords: ['Dodge', 'Dash'] });
    const orphan = readGameSpec({ ...without(base), abilities: undefined, abilityWords: ['Dodge'] });
    for (const read of [extra, orphan]) {
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.reason).toBe('MALFORMED_SPEC');
    }
  });

  it('the word is UI only: the world is byte-identical with or without it', () => {
    for (const sentence of [SQUIRREL, SUMO]) {
      const spec = draftGameSpec(sentence);
      expect(spec.abilityWords).toBeDefined();
      const labelled = arcadeWorldOf(spec, 1);
      const plain = arcadeWorldOf(without(spec), 1);
      if (!labelled.ok || !plain.ok) throw new Error(`${sentence}: no world`);
      expect(JSON.stringify(labelled.world)).toBe(JSON.stringify(plain.world));
    }
  });
});

describe('the action button', () => {
  const session = {} as ArcadeSession;
  const button = (word?: string): string => renderToStaticMarkup(createElement(AbilityButton, { session, ability: 'dash', slot: 0, stack: 0, word }));

  it('shows the sentence word and keeps the ability icon', () => {
    const markup = button('Dodge');
    expect(markup).toContain('<span>Dodge</span>');
    expect(markup).toContain('data-testid="arcade-ability-dash"');
    expect(markup).toBe(button('Dash').replace('<span>Dash</span>', '<span>Dodge</span>'));
  });

  it('a game without words keeps the generic label', () => {
    expect(button()).toContain('<span>Dash</span>');
  });
});
