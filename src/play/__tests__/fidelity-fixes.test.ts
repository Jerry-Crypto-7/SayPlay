/**
 * Tři největší ztráty z offline mapy (P27A T5), každá celou cestou věta →
 * slovní draft → `drawn`. Negativní věty hlídají, že oprava nezvedne číslo
 * tím, že do specu dá slovo, které věta jako místo, soupeře nebo vozidlo nemyslí.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpec } from '@/play/draft';
import { type ChecklistEntry, fidelityChain } from '@/play/fidelity/chain';

import corpus from '../../../evals/play/fidelity/corpus.json';

const SENTENCES = corpus.sentences as unknown as readonly { id: string; text: string; checklist: ChecklistEntry[] }[];

/** Stav jedné položky kontrolního seznamu věty z korpusu po slovním draftu. */
function itemOf(id: string, item: string) {
  const sentence = SENTENCES.find((candidate) => candidate.id === id)!;
  const entry = sentence.checklist.find((candidate) => candidate.item === item)!;
  const [chain] = fidelityChain(draftGameSpec(sentence.text), [entry]);
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
    expect(itemOf('s039', 'zombie')).toEqual(['zombie', true, 'ok']);
    expect(itemOf('h03', 'dragon')).toEqual(['dragon', true, 'ok']);
  });

  it('never takes a place or a style before "shooter" for the foe', () => {
    const template = label(draftGameSpec('a shooter'), 'enemy');
    expect(label(draftGameSpec('a space shooter'), 'enemy')).toBe(template);
    expect(label(draftGameSpec('a top-down shooter'), 'enemy')).toBe(template);
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

// P28D T3: řetěz počítá jen model z popisku. Náhradník (hydrant za postřikovač)
// číslo věrnosti nezvedne; věž hodu z kostek kreslí model terče, takže krabice ano.
describe('drawn counts the label model only', () => {
  it('a stand-in model does not count as drawn (s006 sprinkler)', () => {
    expect(itemOf('s006', 'sprinkler')).toEqual(['sprinkler', false, 'no-model']);
  });

  it('the throw tower of wood blocks draws the target label (s088 cardboard box)', () => {
    expect(itemOf('s088', 'cardboard box')).toEqual(['cardboard box', true, 'ok']);
  });
});
