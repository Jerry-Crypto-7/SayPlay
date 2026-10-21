/**
 * Tabulka kompatibility mutátorů (P56C T15) → `src/play/chain/mutator-compat.json` a důvody vyřazených párů do
 * `mutator-compat.md`. Pár (mutátor, mikrohra) projde, když `mutatorPairIssue` na všech semínkách nic nenajde.
 * Bossové mutátor nedostanou (T16), proto v tabulce nejsou.
 *
 * `npx vitest run --config vitest.measure.mts evals/play/p56c/mutator-compat.measure.ts`
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from 'vitest';

import { MICRO } from '../../../src/play/chain/micro';
import { COMPAT_SEEDS, COMPAT_SENTENCE, MUTATORS, MUTATOR_IDS, mutatorPairIssue } from '../../../src/play/chain/mutators';

/** `ONLY=mirror,rush` změří jen tyhle mutátory a nic nezapíše – ladění jednoho mutátoru. */
const ONLY = process.env.ONLY?.split(',');

it('measures which mutator plays on which microgame', () => {
  const entries = MICRO.filter((entry) => entry.boss !== true);
  const rows = MUTATOR_IDS.filter((id) => ONLY === undefined || ONLY.includes(id)).map((id) => ({ id, results: entries.map((entry) => ({ key: entry.key, issue: mutatorPairIssue(COMPAT_SENTENCE, entry, id, COMPAT_SEEDS) })) }));
  if (ONLY !== undefined) {
    // Konfigurace měření konzoli spolkne; výpis jde do dočasného souboru.
    writeFileSync(join(tmpdir(), 'mutator-only.txt'), rows.map(({ id, results }) => `${id}\n${results.map((row) => `  ${row.key}: ${row.issue ?? 'OK'}`).join('\n')}`).join('\n'));
    return;
  }
  const pairs = Object.fromEntries(rows.map(({ id, results }) => [id, results.filter((row) => row.issue === null).map((row) => row.key)]));
  writeFileSync(join(__dirname, '../../../src/play/chain/mutator-compat.json'), `${JSON.stringify({ measuredBy: 'evals/play/p56c/mutator-compat.measure.ts', sentence: COMPAT_SENTENCE, seeds: COMPAT_SEEDS, pairs }, null, 2)}\n`);
  const lines = [
    '# Mutátory × mikrohry (P56C T15)',
    '',
    `Změřeno \`mutator-compat.measure.ts\` na větě „${COMPAT_SENTENCE}“, semínka ${COMPAT_SEEDS.join(', ')}; kola 2 a 4 u přežití, kolo 2 u ostatních. Bossové mutátor nedostanou.`,
    '',
    '| Mutátor | Karta | Hraje na | Vyřazené (první důvod) |',
    '|---|---|---|---|',
    ...rows.map(({ id, results }) => {
      const ok = results.filter((row) => row.issue === null).map((row) => row.key);
      const out = results.filter((row) => row.issue !== null).map((row) => `${row.key}: ${row.issue ?? ''}`);
      return `| \`${id}\` | ${MUTATORS[id].card} | ${String(ok.length)} – ${ok.join(', ')} | ${out.join('; ')} |`;
    }),
    '',
    '**Vypadlo:** `magnet_start` (magnet celého kola, okruh 4–12 jednotek) hrál jen na plošinovce a poletování. Běžec na semínku 2005595638 žádnou věc do okruhu nemine, chytání s přitahováním robot prohraje, obrana věc v dosahu nemá; nad 8 jednotek plošinovku robot vyhraje pod 3 s. Brána se nezkracuje.',
    '',
    '**Mizející podlaha** hraje s robotem, který drolení vidí (`vanishing_floor_bot` uhne ke středu, když je drolení na maximu); bez něj prošla jen střílečka – roboti chytání, bouchání a načasování stojí na místě. Na běžci, plošinovce, poletování a davu se hrdina nezastaví, takže stav se nezmění.',
    '',
  ];
  writeFileSync(join(__dirname, 'mutator-compat.md'), lines.join('\n'));
  for (const { id, results } of rows) console.log(id, results.filter((row) => row.issue === null).length, results.filter((row) => row.issue !== null).map((row) => `${row.key}: ${row.issue ?? ''}`).join(' | '));
}, 1_800_000);
