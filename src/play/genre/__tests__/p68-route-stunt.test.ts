/**
 * P68 T8: klasifikátor pouští závod s triky (`stunt`). Znak žánru, který přetáhne obyčejné závody `voyage` („race
 * a sports car around the city“) nebo skok bez vozidla plošinovky, vypadá jako úspěch – proto test nad štítky P68:
 * každá věta, kterou klasifikátor dá hře, ji má v `acceptable`, a uložená stráž (`route-stunt.json`) nepohnula žádnou
 * větu mezi dvěma starými žánry ani nezhoršila `wrongRate` sady 200 proti `main`.
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
const DEV = json<{ sentences: { id: string; genre: string; text: string }[] }>('dev.json').sentences.filter((s) => s.genre === 'stunt');
const CATEGORY = json<{ sentences: { game: string; text: string }[] }>('vozidla-sport/dev.json').sentences.filter((s) => s.game === 'stunt');

describe('stunt is routed (P68 T8)', () => {
  it('is out of the activation gate', () => {
    expect(ROUTE_PENDING.has('stunt')).toBe(false);
  });

  it('at least 6 of the 8 P68 dev sentences and 9 of the 10 category dev sentences play the stunt race', () => {
    expect(DEV).toHaveLength(8);
    expect(DEV.filter((s) => top(s.text) === 'stunt.default').length).toBeGreaterThanOrEqual(6);
    expect(CATEGORY).toHaveLength(10);
    expect(CATEGORY.filter((s) => top(s.text) === 'stunt.default').length).toBeGreaterThanOrEqual(9);
  });

  it.each([
    ['race a sports car around the city', 'voyage.race'],
    ['drive a rusty van through a rainy harbor', 'voyage.race'],
    ['a speedboat races between islands', 'voyage.race'],
    ['a jellyfish drifts upward avoiding fishing nets', 'voyage.race'],
    ['a frog jumps over logs to reach the pond', 'platformer.default'],
  ])('a race without jumps or crashes, or a jump without a vehicle, stays where it was: %s', (sentence, where) => {
    expect(top(sentence)).toBe(where);
  });

  it('a drawn ramp is not a stunt ramp', () => {
    expect(top('draw a ramp so the rolling apple does not fall into the river')).not.toBe('stunt.default');
  });
});

describe('the route guard over the P68 labels (P68 T8)', () => {
  const labels = json<{ sentences: Labelled[] }>('genre-labels.json').sentences;

  it('every labelled sentence the classifier gives the stunt race has it in acceptable', () => {
    const stolen = labels.filter((s) => top(s.text) === 'stunt.default' && !s.acceptable.includes('stunt')).map((s) => s.text);
    expect(stolen).toEqual([]);
  });

  it('the stored guard run moves no sentence between two old genres and keeps wrongRate on the 200 set', () => {
    const main = json<Route>('route-main.json');
    const branch = json<Route>('route-stunt.json');
    const before = new Map(main.rows.map((row) => [row.text, row.genre]));
    expect(branch.rows).toHaveLength(main.rows.length);
    const oldToOld = branch.rows.filter((row) => {
      const was = before.get(row.text)!;
      return was !== row.genre && !NEW.has(was) && !NEW.has(row.genre);
    });
    expect(oldToOld.map((row) => row.text)).toEqual([]);
    for (const row of branch.rows) if (row.genre === 'stunt') expect(row.acceptable, row.text).toContain('stunt');
    expect(branch.wrongRate.test200.wrongRate).toBeLessThanOrEqual(main.wrongRate.test200.wrongRate);
  });
});
