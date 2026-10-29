/**
 * P66 T12: rychlá hra pouští věty do pěti nových žánrů a nekrade je starým. Narážka, která přetáhne sběrací věty
 * z arény do díry, vypadá jako úspěch nového žánru – proto stráž nad štítky slepého soudce z T1 (`genre-labels.json`):
 * žádná věta se nepřesune mezi dvěma starými žánry, každá přesunutá na nový žánr ho má mezi přijatelnými a podíl
 * špatného žánru na sadě 200 ani na otevřených sadách není horší než `main` (`route-main.json`). Stráž se počítá znovu
 * z dnešního `classifyGenre` (regrese kódu ji shodí) a zapsaný `route-branch.json` musí být týž výpočet.
 * Ladí se jen na dev větách; sada 200 se tu jen počítá.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { type RouteRow, routeStats } from '../../../../evals/play/p66/genre-route.mjs';
import { classifyGenre } from '../classify';

const json = <T,>(path: string): T => JSON.parse(readFileSync(new URL(`../../../../evals/play/${path}`, import.meta.url), 'utf8')) as T;

interface Labelled { readonly text: string; readonly sets: readonly { readonly set: string; readonly id: string }[]; readonly best: string | null; readonly acceptable: readonly string[] }
interface Routed { readonly text: string; readonly sets: readonly string[]; readonly best: string | null; readonly acceptable: readonly string[]; readonly genre: string; readonly mode: string }
interface RouteFile { readonly wrongRate: { readonly test200: { readonly wrongRate: number }; readonly open: { readonly wrongRate: number } }; readonly rows: readonly Routed[] }

const NEW = new Set(['survivor', 'hole', 'steal', 'sort', 'arrows']);
const TEST_SET = 'p30/test-200.json';
const labels = json<{ sentences: Labelled[] }>('p66/genre-labels.json').sentences;
const main = json<RouteFile>('p66/route-main.json');
const branch = json<RouteFile>('p66/route-branch.json');
const before = new Map(main.rows.map((row) => [row.text, row]));

/** Dnešní žánr rychlé hry každé označené věty – stejně jako `genre-route.mjs` (první režim `classifyGenre(věta, null)`). */
const now = labels.map((sentence) => {
  const top = classifyGenre(sentence.text, null).ranked[0]!;
  return { ...sentence, sets: sentence.sets.map((s) => `${s.set}#${s.id}`), genre: top.genre, mode: top.mode };
});
const inTest = (row: { sets: readonly string[] }): boolean => row.sets.some((s) => s.startsWith(`${TEST_SET}#`));
const inOpen = (row: { sets: readonly string[] }): boolean => row.sets.some((s) => !s.startsWith(`${TEST_SET}#`));
const rate = (rows: readonly RouteRow[]): number => routeStats(rows).wrongRate as number;

describe('P66 T12: quick games route to the five new genres without stealing (genre-route guard)', () => {
  it('moves no sentence between two old genres, and only to a new genre the labels accept', () => {
    const oldOld: string[] = [];
    const unaccepted: string[] = [];
    let toNew = 0;
    for (const row of now) {
      const was = before.get(row.text)!;
      if (`${was.genre}.${was.mode}` === `${row.genre}.${row.mode}`) continue;
      if (!NEW.has(row.genre)) {
        if (!NEW.has(was.genre)) oldOld.push(`${was.genre}.${was.mode} -> ${row.genre}.${row.mode}: ${row.text}`);
        continue;
      }
      toNew += 1;
      if (row.best !== 'none' && !row.acceptable.includes(row.genre)) unaccepted.push(`${was.genre}.${was.mode} -> ${row.genre} [${row.acceptable.join(', ')}]: ${row.text}`);
    }
    expect(oldOld).toEqual([]);
    expect(unaccepted).toEqual([]);
    // Bez přesunu by stráž byla prázdná: nové žánry mají věty dostat.
    expect(toNew).toBeGreaterThan(0);
  });

  it('the wrong-genre rate is no worse than main, on the 200 set and on the open sets', () => {
    expect(rate(now.filter(inTest))).toBeLessThanOrEqual(main.wrongRate.test200.wrongRate);
    expect(rate(now.filter(inOpen))).toBeLessThanOrEqual(main.wrongRate.open.wrongRate);
  });

  it('route-branch.json is this classifier, and its recorded guard holds', () => {
    const recorded = new Map(branch.rows.map((row) => [row.text, `${row.genre}.${row.mode}`]));
    expect(now.filter((row) => recorded.get(row.text) !== `${row.genre}.${row.mode}`).map((row) => row.text)).toEqual([]);
    expect(branch.wrongRate.test200.wrongRate).toBe(rate(now.filter(inTest)));
    expect(branch.wrongRate.open.wrongRate).toBe(rate(now.filter(inOpen)));
    expect(branch.wrongRate.test200.wrongRate).toBeLessThanOrEqual(main.wrongRate.test200.wrongRate);
    expect(branch.wrongRate.open.wrongRate).toBeLessThanOrEqual(main.wrongRate.open.wrongRate);
  });

  it('puts at least 16 of the 20 P66 dev sentences in their new genre, at least 3 of 4 per genre', () => {
    const dev = json<{ sentences: { id: string; genre: string; text: string }[] }>('p66/dev.json').sentences;
    const hits: Record<string, number> = {};
    const missed: string[] = [];
    for (const row of dev) {
      const top = classifyGenre(row.text, null).ranked[0]!;
      if (top.genre === row.genre) hits[row.genre] = (hits[row.genre] ?? 0) + 1;
      else missed.push(`${row.id} ${row.genre} -> ${top.genre}.${top.mode}`);
    }
    expect(dev).toHaveLength(20);
    expect(20 - missed.length, missed.join('; ')).toBeGreaterThanOrEqual(16);
    for (const genre of NEW) expect(hits[genre] ?? 0, genre).toBeGreaterThanOrEqual(3);
  });

  // `route-main.json` (`main` `e661855c`): dvanáct dev vět P30, na kterých se ladí obecné hry, hraje týž žánr a režim.
  it.each([
    ['s039', 'shooter.default'],
    ['s037', 'shooter.default'],
    ['s002', 'arena.escape'],
    ['s003', 'arena.escape'],
    ['s006', 'runner.default'],
    ['s008', 'runner.default'],
    ['s022', 'platformer.default'],
    ['s021', 'platformer.default'],
    ['s035', 'flap.default'],
    ['s050', 'throw.default'],
    ['s088', 'throw.default'],
    ['s069', 'quest.station'],
  ])('P30 dev %s plays %s as on main', (id, expected) => {
    const dev = json<{ sentences: { id: string; text: string }[] }>('p30/dev.json').sentences;
    expect(dev.slice(0, 12).map((row) => row.id)).toContain(id);
    const top = classifyGenre(dev.find((row) => row.id === id)!.text, null).ranked[0]!;
    expect(`${top.genre}.${top.mode}`).toBe(expected);
  });
});
