/**
 * Verdikt P70B T5 se přepočítá ze surových řádků (směrování obou stran, G2 větve i `main`) a musí se shodovat
 * se zapsaným `result.json`; čísla v `result.md` jsou tatáž. Ručně upravený výsledek nebo text tak neprojde.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GOALS, verdictOf } from '../result.mjs';

const DIR = join(process.cwd(), 'evals', 'play', 'p70b');
const read = (file: string) => JSON.parse(readFileSync(join(DIR, file), 'utf8'));

describe('P70B T5 result', () => {
  const [main, branch, gameplay, gameplayMain, opened] = ['route-main.json', 'route-branch.json', 'gameplay-holdout.json', 'gameplay-main.json', 'holdout-opened.json'].map(read);
  const recorded = read('result.json');

  it('recomputes result.json from the raw rows', () => {
    expect(recorded).toEqual({ schema: 'p70b-result.v1', opened: opened.openedAt, mainCommit: main.commit, branchCommit: branch.commit, ...verdictOf(main, branch, gameplay, gameplayMain) });
  });

  it('holds the verdict written in result.md: hero and G2 missed, golf and general met', () => {
    const { hero, golf, general, g2 } = recorded.goals;
    expect([hero.value, hero.of, hero.met, golf.value, golf.met, general.value, general.main, general.met, g2.value, g2.of, g2.met]).toEqual([21, 30, false, 19, true, 5, 5, true, 29, 52, false]);
    expect(g2.met).toBe(g2.value * 100 >= GOALS.g2Pct * g2.of);
    const md = readFileSync(join(DIR, 'result.md'), 'utf8');
    for (const said of ['21/30', '17/30', '19/20', '7/20', '29/52', '17/40']) expect(md).toContain(said);
  });
});
