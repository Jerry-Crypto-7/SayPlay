/**
 * Měřidlo AI verze P46E nad nahranými odpověďmi režiséra, bez volání modelu:
 * `npx vitest run --config vitest.measure.mts evals/play/p46e/upgrade.measure.ts`
 * Bez proměnných čte `src/play/director/__fixtures__/logic-answers` a zapíše
 * `evals/play/p46e/baseline.json`; `P46E_ANSWERS=<složka>` a `P46E_OUT=<soubor>`
 * jinou sadu (T5: `p46-answers` → `after.json`). Výstup nemá čas ani datum,
 * takže nový běh bez změny kódu nechá git čistý.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { LOGIC_ANSWERS_DIR } from '@/play/director/__fixtures__/logic-answers';

import { P46E_DIR, type UpgradeRow, recordedAnswers, upgradeRow, upgradeSummary } from './upgrade';

it('measures what the AI version keeps and adds over the quick version', async () => {
  await loadRapier();
  const dir = process.env.P46E_ANSWERS ?? LOGIC_ANSWERS_DIR;
  const out = process.env.P46E_OUT ?? join(P46E_DIR, 'baseline.json');
  const rows: UpgradeRow[] = [];
  for (const fixture of recordedAnswers(dir)) rows.push(await upgradeRow(fixture));
  const summary = upgradeSummary(rows);
  writeFileSync(out, `${JSON.stringify({ schema: 'p46e-upgrade.v1', answers: dir.replaceAll('\\', '/'), summary, rows }, null, 1)}\n`);
  expect(rows).toHaveLength(summary.n);
});
