/**
 * Brány vydání PLAY (P23-D T5): brána s odhadem místo čísla se čte stejně
 * jako brána s číslem. Test proto drží tabulku v `docs/play/GATES.md`:
 * každá řádka má verdikt ze tří slov, verdikt `PASS`/`FAIL` stojí na čísle,
 * `NOT MEASURED` to přizná i ve sloupci čísla, a nikde v dokumentu není
 * „should“, „měl by“ ani „approximately“.
 *
 * Leží v `evals/`, ne v `docs/play/__tests__`: `vitest.config.mts` sbírá jen
 * `src`, `evals`, `scripts` a `ops`, a kontrakt P23 config měnit zakazuje.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const GATES = readFileSync(fileURLToPath(new URL('../../../docs/play/GATES.md', import.meta.url)), 'utf8');

const VERDICTS = new Set(['PASS', 'FAIL', 'NOT MEASURED']);

/** Datové řádky tabulky v sekci „Brány“ jako pole buněk. */
function gateRows(text: string): string[][] {
  const section = text.split(/^## Brány$/m)[1] ?? '';
  return section
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

describe('docs/play/GATES.md', () => {
  const rows = gateRows(GATES);

  it('has the gate table with every gate of the pack', () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const gate of ['crash', 'deterministic mismatch', 'broken objective', 'lineage drift', 'public version regeneration', 'moderation block', 'secret exposure']) {
      expect(rows.some(([name]) => name.includes(gate)), gate).toBe(true);
    }
  });

  it('gives every row a verdict, and a number behind every PASS or FAIL', () => {
    for (const row of rows) {
      expect(row, row[0]).toHaveLength(5);
      const [name, , measured, , verdict] = row;
      expect(VERDICTS.has(verdict), `${name}: ${verdict}`).toBe(true);
      if (verdict === 'NOT MEASURED') expect(measured, name).toMatch(/NOT MEASURED/);
      else expect(measured, name).toMatch(/\d/);
    }
  });

  it('never estimates instead of measuring', () => {
    expect(GATES).not.toMatch(/\bshould\b|měl by|approximately/i);
  });
});
