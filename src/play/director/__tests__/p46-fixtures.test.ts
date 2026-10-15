/**
 * Nahrané odpovědi režiséra s bossem, akcemi a úseky (P46E T5) přehrané offline skutečnou cestou upgradu.
 * Nahrávky zapisuje jen `evals/play/p46e/record.cmd` (gpt-oss-20b, dnešní prompt), souhrn `after.json`
 * měřidlo `evals/play/p46e/upgrade.measure.ts`. Test drží, že každá nahrávka dá týž řádek jako v `after.json`:
 * číslo z měření se nesmí tiše pohnout. Ručně psaná odpověď by prošla vždy, proto jen soubor s modelem a promptem.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '../../arcade/physics/world';
import { P46E_DIR, type UpgradeRow, recordedAnswers, upgradeRow } from '../../../../evals/play/p46e/upgrade';
import { COMPACT_PROMPT_VERSION } from '../compact';

const ANSWERS = 'src/play/director/__fixtures__/p46-answers';
const after = JSON.parse(readFileSync(join(process.cwd(), P46E_DIR, 'after.json'), 'utf8')) as { readonly answers: string; readonly rows: readonly UpgradeRow[] };
const fixtures = recordedAnswers(join(process.cwd(), ANSWERS));

describe('recorded P46E director answers replay offline as measured (P46E T5)', () => {
  beforeAll(async () => {
    await loadRapier();
  });

  it('covers every recorded answer, each recorded by a model with the current compact prompt', () => {
    expect(after.answers).toBe(ANSWERS);
    expect(fixtures.map((fixture) => fixture.id)).toEqual(after.rows.map((row) => row.id));
    for (const fixture of fixtures) {
      expect(fixture.model, fixture.id).not.toBe('none');
      expect(fixture.promptVersion, `${fixture.id}: recorded with another compact prompt`).toBe(COMPACT_PROMPT_VERSION);
    }
  });

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))('%s gives the measured upgrade', async (id, fixture) => {
    expect(await upgradeRow(fixture)).toEqual(after.rows.find((row) => row.id === id));
  }, 180_000);
});
