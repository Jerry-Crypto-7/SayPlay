/**
 * P70A T4: `result.md` je přesně `render()` surových souborů (`before`/`after`, `chains-*`, `browser.json`), takže
 * žádné číslo verdiktu nejde opsat ani nechat zastarat. Počty v hlavičce verdiktu se tu přepočítávají znovu, ať chybné
 * pravidlo „splní cíl“ v `result.ts` neprojde jen proto, že by se tabulka a soubor shodly.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readInputs, render } from '../result';

const DIR = join(process.cwd(), 'evals', 'play', 'p70a');
const inputs = readInputs(DIR);
const md = readFileSync(join(DIR, 'result.md'), 'utf8').replace(/\r\n/g, '\n');

describe('p70a result.md', () => {
  it('is recomputed from the raw files', () => {
    expect(md).toBe(render(inputs));
  });

  it('the verdict counts match the raw summaries and browser rows', () => {
    const ok = (row: { survivalS: number | null; winRate: number | null }): boolean => row.survivalS !== null && row.survivalS >= 20 && row.winRate !== null && row.winRate >= 0.5;
    const total = inputs.after.summary.length;
    expect(md).toContain(`${String(inputs.before.summary.filter(ok).length)}/${String(total)} před → ${String(inputs.after.summary.filter(ok).length)}/${String(total)} po`);
    expect(md).toContain(`${String(inputs.chainsBefore.all.chains)}/${String(inputs.chainsBefore.all.sentences)} před → ${String(inputs.chainsAfter.all.chains)}/${String(inputs.chainsAfter.all.sentences)} po`);
    const rows = inputs.browser.rows;
    expect(rows).toHaveLength(6);
    expect(md).toContain(`${String(rows.filter((row) => row.survived20).length)}/6 vět přežije 20 s`);
    // Každý žánr, který cíl nesplní, má v seznamu výjimek řádek s důvodem.
    for (const row of inputs.after.summary.filter((entry) => !ok(entry))) expect(md).toMatch(new RegExp(`- \\*\\*${row.genre}\\*\\* – \\S`));
  });
});
