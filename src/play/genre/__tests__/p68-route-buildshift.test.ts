/**
 * P68 T11: klasifikátor pouští směnu se stavbou obchodu (`buildshift`). Znak žánru, který přetáhne věty stanoviště
 * `quest` nebo věty bez slovesa („a cat naps in a rainy café“), vypadá jako úspěch – proto test nad štítky P68:
 * každá věta, kterou klasifikátor dá hře, ji má v `acceptable`, a uložená stráž (`route-buildshift.json`) nepohnula
 * žádnou větu mezi dvěma starými žánry ani nezhoršila `wrongRate` sady 200 proti `main`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUTE_PENDING, classifyGenre } from '../classify';

const P68 = join(process.cwd(), 'evals', 'play', 'p68');
const json = <T>(name: string): T => JSON.parse(readFileSync(join(P68, name), 'utf8')) as T;
const top = (sentence: string): string => {
  const best = classifyGenre(sentence, null).ranked[0]!;
  return `${best.genre}.${best.mode}`;
};

interface Labelled { readonly text: string; readonly best: string; readonly acceptable: readonly string[] }
interface Row extends Labelled { readonly genre: string; readonly sets: readonly string[] }
interface Route { readonly wrongRate: { readonly test200: { readonly wrong: number; readonly wrongRate: number } }; readonly rows: readonly Row[] }

const NEW = new Set(['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave']);
const DEV = json<{ sentences: { id: string; genre: string; text: string }[] }>('dev.json').sentences.filter((s) => s.genre === 'buildshift');
const CATEGORY = json<{ text: string }[] | { sentences: { text: string }[] }>('stavba/dev.json');
const CATEGORY_TEXTS = (Array.isArray(CATEGORY) ? CATEGORY : CATEGORY.sentences).map((row) => row.text);

describe('buildshift is routed (P68 T11)', () => {
  it('is out of the activation gate', () => {
    expect(ROUTE_PENDING.has('buildshift')).toBe(false);
  });

  it('at least 6 of the 8 P68 dev sentences and 18 of the 20 category sentences play the shop', () => {
    expect(DEV).toHaveLength(8);
    expect(DEV.filter((s) => top(s.text) === 'buildshift.default').length).toBeGreaterThanOrEqual(6);
    expect(CATEGORY_TEXTS).toHaveLength(20);
    expect(CATEGORY_TEXTS.filter((text) => top(text) === 'buildshift.default').length).toBeGreaterThanOrEqual(18);
  });

  it.each([
    ['a chef cooks burgers at one grill, order after order', 'quest.station'],
    ['a waiter serves soup to the king at a royal banquet', 'quest.station'],
    ['serve the ball and win the tennis match', 'quest.station'],
    ['sort the fruit into crates at the market stall', 'sort.default'],
    ['catch falling donuts in a basket outside the bakery', 'catch.default'],
    ['deliver pizzas across town on a scooter', 'quest.spatial'],
  ])('one workplace or another game stays where it was: %s', (sentence, where) => {
    expect(top(sentence)).toBe(where);
  });

  it.each([
    'grocery shopping list for a vegan week',
    'a magpie snatches shiny spoons from a café terrace',
    'a waiter balances ten plates across a crowded restaurant',
    'a sleepy cat naps in a cozy rainy café',
    'a jungle growing out of an abandoned shopping mall',
    'run a marathon through the city',
    'catch the last bus home after a night shift at the hospital',
  ])('a shop word without a shift does not take the sentence: %s', (sentence) => {
    expect(top(sentence)).not.toBe('buildshift.default');
  });
});

describe('the route guard over the P68 labels (P68 T11)', () => {
  const labels = json<{ sentences: Labelled[] }>('genre-labels.json').sentences;

  it('every labelled sentence the classifier gives the shop has the shop in acceptable', () => {
    const stolen = labels.filter((s) => top(s.text) === 'buildshift.default' && !s.acceptable.includes('buildshift')).map((s) => s.text);
    expect(stolen).toEqual([]);
  });

  it('the stored guard run moves no sentence between two old genres and keeps wrongRate on the 200 set', () => {
    const main = json<Route>('route-main.json');
    const branch = json<Route>('route-buildshift.json');
    const before = new Map(main.rows.map((row) => [row.text, row.genre]));
    expect(branch.rows).toHaveLength(main.rows.length);
    const oldToOld = branch.rows.filter((row) => {
      const was = before.get(row.text)!;
      return was !== row.genre && !NEW.has(was) && !NEW.has(row.genre);
    });
    expect(oldToOld.map((row) => row.text)).toEqual([]);
    for (const row of branch.rows) if (row.genre === 'buildshift') expect(row.acceptable, row.text).toContain('buildshift');
    expect(branch.wrongRate.test200.wrongRate).toBeLessThanOrEqual(main.wrongRate.test200.wrongRate);
  });
});
