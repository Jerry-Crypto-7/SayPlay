/**
 * Tři největší ztráty z offline mapy (P27A T5), každá celou cestou věta →
 * slovní draft → `drawn`. Negativní věty hlídají, že oprava nezvedne číslo
 * tím, že do specu dá slovo, které věta jako místo, soupeře nebo vozidlo nemyslí.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpec, draftGameSpecWithMeta } from '@/play/draft';
import { type ChecklistEntry, fidelityChain } from '@/play/fidelity/chain';
import type { GameSpecV1 } from '@/play/spec';

import corpus from '../../../evals/play/fidelity/corpus.json';

import { legacyDraft } from './legacy-draft';

const SENTENCES = corpus.sentences as unknown as readonly { id: string; text: string; checklist: ChecklistEntry[] }[];

/** Stav jedné položky kontrolního seznamu věty z korpusu po slovním draftu. */
function itemOf(id: string, item: string, draft: (sentence: string) => GameSpecV1 = draftGameSpec) {
  const sentence = SENTENCES.find((candidate) => candidate.id === id)!;
  const entry = sentence.checklist.find((candidate) => candidate.item === item)!;
  const [chain] = fidelityChain(draft(sentence.text), [entry]);
  return [chain.item, chain.drawn, chain.why];
}

const label = (spec: ReturnType<typeof draftGameSpec>, id: string): string | undefined => spec.roles.find((role) => role.id === id)?.label;

describe('place named without a preposition', () => {
  it.each([
    ['h09', 'hospital'],
    ['h10', 'glacier'],
    ['s111', 'city'],
    ['s050', 'snow fort'],
    ['s035', 'underwater'],
  ])('%s keeps %s as the setting and the scene shows it', (id, item) => {
    expect(itemOf(id, item)).toEqual([item, true, 'ok']);
  });

  it('never makes a creature or a thrown thing the setting', () => {
    expect(draftGameSpec('shoot the aliens').theme.setting).not.toMatch(/alien/);
    expect(draftGameSpec('throwing snowballs at kids').theme.setting).not.toMatch(/snowball/);
  });
});

describe('foe named without a verb', () => {
  it('reads the foe before "shooter" and after "defend … from"', () => {
    // Střelnice je od P32B T2 šablona remixu; od P36A T10 dá nová hra zombíky do vln nepřátel žánru Střílečka.
    expect(itemOf('s039', 'zombie', legacyDraft)).toEqual(['zombie', true, 'ok']);
    expect(draftGameSpecWithMeta('zombie shooter in a mall').genre).toMatchObject({ genre: 'shooter', cast: expect.arrayContaining([expect.objectContaining({ label: 'zombie', does: 'shoot_at' })]) });
    // Hod je taky šablona remixu; nová hra dá draky do soupeře souboje arény – nakreslí ho, až scéna bude číst `rival` (B-R9).
    expect(itemOf('h03', 'dragon', legacyDraft)).toEqual(['dragon', true, 'ok']);
    expect(draftGameSpecWithMeta('defend a castle from dragons by throwing snowballs').genre?.cast?.map((item) => item.label)).toContain('dragon');
  });

  it('never takes a place or a style before "shooter" for the foe', () => {
    const shooter = (sentence: string) => legacyDraft(sentence, 1, 'shooter');
    const template = label(shooter('a shooter'), 'enemy');
    expect(template).toBeDefined();
    expect(label(shooter('a space shooter'), 'enemy')).toBe(template);
    expect(label(shooter('a top-down shooter'), 'enemy')).toBe(template);
    for (const sentence of ['a space shooter', 'a top-down shooter']) {
      const shot = draftGameSpecWithMeta(sentence).genre;
      expect(shot?.genre).toBe('shooter');
      // Nepřítel bez jména z věty je výchozí nepřítel žánru, ne místo ani styl.
      for (const item of shot?.cast ?? []) expect(item.label).not.toMatch(/space|top-down/);
    }
  });
});

describe('vehicle named by "… race"', () => {
  it.each([
    ['h02', 'shopping cart'],
    ['s058', 'boat'],
  ])('%s drives the %s', (id, item) => {
    expect(itemOf(id, item)).toEqual([item, true, 'ok']);
  });

  it('never makes a place the racer', () => {
    expect(label(draftGameSpec('space race to the moon'), 'player')).not.toMatch(/space/);
  });
});
