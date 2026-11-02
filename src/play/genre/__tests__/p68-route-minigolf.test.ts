/**
 * P68 T9: klasifikátor pouští minigolf. Znak žánru, který přetáhne hody (`throw`: „golf“, koš, bowling), kop do branky
 * nebo bouchání na golfovém hřišti, vypadá jako úspěch – proto test nad štítky P68: každá věta, kterou klasifikátor dá
 * hře, ji má v `acceptable`, a uložená stráž (`route-minigolf.json`) nepohnula žádnou větu mezi dvěma starými žánry ani
 * nezhoršila `wrongRate` sady 200 proti `main`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';

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
const DEV = json<{ sentences: { id: string; genre: string; text: string }[] }>('dev.json').sentences.filter((s) => s.genre === 'minigolf');
const CATEGORY = json<{ sentences: { game: string; text: string }[] }>('vozidla-sport/dev.json').sentences.filter((s) => s.game === 'minigolf');

describe.skipIf(ROUTE_PENDING.has('minigolf'))('minigolf is routed (P68 T9)', () => {
  it('is out of the activation gate', () => {
    expect(ROUTE_PENDING.has('minigolf')).toBe(false);
  });

  it('at least 6 of the 8 P68 dev sentences and 9 of the 10 category dev sentences play minigolf', () => {
    expect(DEV).toHaveLength(8);
    expect(DEV.filter((s) => top(s.text) === 'minigolf.default').length).toBeGreaterThanOrEqual(6);
    expect(CATEGORY).toHaveLength(10);
    expect(CATEGORY.filter((s) => top(s.text) === 'minigolf.default').length).toBeGreaterThanOrEqual(9);
  });

  // `integration.md` → „NESMÍ skončit v minigolf“: podobná slova, jiná hra.
  it.each([
    'kick the ball past the goalkeeper into the goal',
    'throw the basketball into the hoop before time runs out',
    'shoot hoops at the fair and sink three in a row',
    'bonk the moles popping out of the golf course',
    'a golfer drives a cart across the golf course collecting lost balls',
    'a monster truck jumps the ramp into a tower of crates',
    'bowl a strike down the lane',
    'putting out fires in a burning city',
  ])('a sentence with golf-like words but another game stays out of minigolf: %s', (sentence) => {
    expect(top(sentence)).not.toBe('minigolf.default');
  });

  it('the quick game of a minigolf sentence is the minigolf hole', () => {
    for (const { text } of DEV.slice(0, 3)) {
      const meta = draftGameSpecWithMeta(text, 1);
      expect(meta.genre?.genre, text).toBe('minigolf');
      expect(meta.spec.control, text).toBe('minigolf');
    }
  }, 120_000);
});

describe('the route guard over the P68 labels (P68 T9)', () => {
  const labels = json<{ sentences: Labelled[] }>('genre-labels.json').sentences;

  it('every labelled sentence the classifier gives minigolf has it in acceptable', () => {
    const stolen = labels.filter((s) => top(s.text) === 'minigolf.default' && !s.acceptable.includes('minigolf')).map((s) => s.text);
    expect(stolen).toEqual([]);
  });

  it('the stored guard run moves no sentence between two old genres and keeps wrongRate on the 200 set', () => {
    const main = json<Route>('route-main.json');
    const branch = json<Route>('route-minigolf.json');
    const before = new Map(main.rows.map((row) => [row.text, row.genre]));
    expect(branch.rows).toHaveLength(main.rows.length);
    const oldToOld = branch.rows.filter((row) => {
      const was = before.get(row.text)!;
      return was !== row.genre && !NEW.has(was) && !NEW.has(row.genre);
    });
    expect(oldToOld.map((row) => row.text)).toEqual([]);
    for (const row of branch.rows) if (row.genre === 'minigolf') expect(row.acceptable, row.text).toContain('minigolf');
    expect(branch.wrongRate.test200.wrongRate).toBeLessThanOrEqual(main.wrongRate.test200.wrongRate);
  });
});
