/**
 * P68 T12: klasifikátor pouští drawsave. Znak žánru, který přetáhne kreslicí program („draw a picture“), frontu obchodu
 * („robots line up“), chytání padajících věcí nebo sestřelování meteorů, vypadá jako úspěch – proto test nad štítky
 * P68: každá věta, kterou klasifikátor dá hře, ji má v `acceptable`, a uložená stráž (`route-drawsave.json`) nepohnula
 * žádnou větu mezi dvěma starými žánry ani nezhoršila `wrongRate` sady 200 proti `main`.
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
const DEV = json<{ sentences: { id: string; genre: string; text: string }[] }>('dev.json').sentences.filter((s) => s.genre === 'drawsave');
const CATEGORY = json<{ sentences: { text: string }[] }>('stavba/dev-drawsave.json').sentences;

describe.skipIf(ROUTE_PENDING.has('drawsave'))('drawsave is routed (P68 T12)', () => {
  it('is out of the activation gate', () => {
    expect(ROUTE_PENDING.has('drawsave')).toBe(false);
  });

  it('at least 6 of the 8 P68 dev sentences and 9 of the 10 category dev sentences play drawsave', () => {
    expect(DEV).toHaveLength(8);
    expect(DEV.filter((s) => top(s.text) === 'drawsave.default').length).toBeGreaterThanOrEqual(6);
    expect(CATEGORY).toHaveLength(10);
    expect(CATEGORY.filter((s) => top(s.text) === 'drawsave.default').length).toBeGreaterThanOrEqual(9);
  });

  // `stavba/integration.md` → „Belong elsewhere“: podobná slova, jiná hra.
  it.each([
    'catch the falling apples in a basket',
    'slice the fruit flying across the screen',
    'build towers to stop the zombie waves',
    'shoot down the meteors before they hit the city',
    'robots line up for pizza at my tiny diner',
    'draw a picture of my cat',
    'paint the walls of my house blue',
    "save the princess from the dragon's castle",
    'a puppy runs and jumps over falling rocks',
    'a quick draw duel at high noon',
  ])('a sentence with drawing or falling words but another game stays out of drawsave: %s', (sentence) => {
    expect(top(sentence)).not.toBe('drawsave.default');
  });

  it('the quick game of a drawsave sentence is the draw-to-save board', () => {
    for (const { text } of DEV.slice(0, 3)) {
      const meta = draftGameSpecWithMeta(text, 1);
      expect(meta.genre?.genre, text).toBe('drawsave');
      expect(meta.spec.control, text).toBe('drawsave');
    }
  }, 120_000);
});

describe('the drawsave route guard over the P68 labels (P68 T12)', () => {
  const labels = json<{ sentences: Labelled[] }>('genre-labels.json').sentences;

  it('every labelled sentence the classifier gives drawsave has it in acceptable', () => {
    const stolen = labels.filter((s) => top(s.text) === 'drawsave.default' && !s.acceptable.includes('drawsave')).map((s) => s.text);
    expect(stolen).toEqual([]);
  });

  it('the stored guard run moves no sentence between two old genres and keeps wrongRate on the 200 set', () => {
    const main = json<Route>('route-main.json');
    const branch = json<Route>('route-drawsave.json');
    const before = new Map(main.rows.map((row) => [row.text, row.genre]));
    expect(branch.rows).toHaveLength(main.rows.length);
    const oldToOld = branch.rows.filter((row) => {
      const was = before.get(row.text)!;
      return was !== row.genre && !NEW.has(was) && !NEW.has(row.genre);
    });
    expect(oldToOld.map((row) => row.text)).toEqual([]);
    for (const row of branch.rows) if (row.genre === 'drawsave') expect(row.acceptable, row.text).toContain('drawsave');
    expect(branch.wrongRate.test200.wrongRate).toBeLessThanOrEqual(main.wrongRate.test200.wrongRate);
  });
});
