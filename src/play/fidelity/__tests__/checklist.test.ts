/**
 * Kontrolní seznam z věty (P37A T8). Seznam vidí prompt režiséra i brána
 * upgradu; kdyby do něj prošla výchozí role z prostředí, kterou věta neřekla,
 * návrh by za ni dostal bod, který AI verze dohnat nemůže, a brána by
 * zavírala správné verze.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../draft';
import { singular } from '../../draft/lexicon';
import { CAST_ROLES } from '../../genre/contract';
import type { ChecklistEntry } from '../chain';
import { essentialTriples } from '../../intent/contract';
import { MAX_NOUNS, sentenceChecklist } from '../checklist';

describe('sentenceChecklist', () => {
  it('lists named nouns and all intent relationships, retaining display metadata', () => {
    const result = sentenceChecklist('a walrus chef stirs a big pot of soup on an iceberg');
    expect(result.checklist.filter(entry => entry.slot !== 'verb')).toEqual([
        { item: 'walrus chef', slot: 'hero', match: ['chef'] },
        { item: 'big pot', slot: 'role', match: ['pot'] },
        { item: 'iceberg', slot: 'setting', match: ['iceberg'] },
    ]);
    expect(result.verb).toEqual({ word: 'stir', family: 'cook', genre: 'quest', mode: 'station' });
    expect(result.checklist.filter(entry => entry.slot === 'verb').map(entry => entry.triple)).toEqual(essentialTriples(result.intent));
  });

  it('leaves out the roles the draft took from the setting, not from the sentence', () => {
    const sentence = 'a grandma cat knits a giant scarf by the fireplace';
    const draft = draftGameSpecWithMeta(sentence).genre;
    // Návrh má nepřítele a prostředí, které věta neříká.
    expect(draft).toMatchObject({ genre: 'rhythm', setting: 'neon stage' });
    expect(draft?.cast?.length).toBeGreaterThan(0);
    const { checklist, verb } = sentenceChecklist(sentence);
    expect(checklist.filter(entry => entry.slot !== 'verb')).toEqual([
      { item: 'grandma cat', slot: 'hero', match: ['cat'] },
    ]);
    // An unknown action stays explicit; rhythm cannot prove knitting.
    expect(checklist).toContainEqual({ item: 'knit', slot: 'verb', triple: { actor: 'cat', verb: 'knit', object: 'scarf' } });
    expect(verb).toEqual({ word: 'knit', family: 'craft', genre: 'rhythm', mode: 'default' });
  });

  it('cuts the word the draft left after the noun, so the match is the noun', () => {
    const { checklist } = sentenceChecklist('a fairy lights lanterns along a moonlit forest path');
    expect(checklist).toContainEqual({ item: 'lanterns', slot: 'role', match: ['lantern'] });
    expect(checklist.flatMap((entry) => entry.match ?? [])).not.toContain('along');
  });

  it('has no verb entry when the sentence names no game verb', () => {
    const { checklist, verb } = sentenceChecklist('a long queue at the pharmacy');
    expect(verb).toBeNull();
    expect(checklist.some((entry) => entry.slot === 'verb')).toBe(false);
    expect(checklist).toContainEqual({ item: 'pharmacy', slot: 'setting', match: ['pharmacy'] });
  });

  // Invariant nad celou dev-150: každé slovo shody stojí ve větě, jména se neopakují a je jich nejvýš `MAX_NOUNS`.
  it('on all of dev-150: named nouns stay unique and every essential relationship is present', () => {
    const set = JSON.parse(readFileSync('evals/play/p37a/dev-150.json', 'utf8')) as { sentences: { id: string; text: string }[] };
    for (const { id, text } of set.sentences) {
      const { checklist, intent } = sentenceChecklist(text);
      const nouns = checklist.filter((entry) => entry.slot !== 'verb');
      expect(nouns.length, id).toBeLessThanOrEqual(MAX_NOUNS);
      // Sloveso smí znít jako jméno („park the car in a park“); jména se neopakují.
      expect(new Set(nouns.map((entry) => entry.match![0])).size, id).toBe(nouns.length);
      expect(checklist.filter((entry) => entry.slot === 'verb').map((entry) => entry.triple), id).toEqual(essentialTriples(intent));
      const words = text.toLowerCase().split(/[^a-z0-9-]+/).map(singular);
      for (const entry of nouns) {
        expect(entry.match, id).toHaveLength(1);
        expect(words, `${id}: ${entry.item}`).toContain(entry.match![0]);
      }
    }
  });
});

// P39 T1: dev sada nese u každé věci očekávanou roli – bez ní by stupeň `role` uznal jakoukoli nehráčskou roli.
describe('dev set expected roles', () => {
  it('every role and any item of evals/play/p30/dev.json says what it does, from the closed list', () => {
    const set = JSON.parse(readFileSync('evals/play/p30/dev.json', 'utf8')) as { sentences: { id: string; checklist: ChecklistEntry[] }[] };
    const items = set.sentences.flatMap(({ id, checklist }) => checklist.filter((entry) => entry.slot === 'role' || entry.slot === 'any').map((entry) => ({ id, entry })));
    expect(items.length).toBeGreaterThan(70);
    const missing = items.filter(({ entry }) => !(CAST_ROLES as readonly string[]).includes(entry.does ?? '')).map(({ id, entry }) => `${id}: ${entry.item}`);
    expect(missing).toEqual([]);
  });
});
