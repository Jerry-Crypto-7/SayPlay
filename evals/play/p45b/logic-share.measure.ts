/**
 * P45B: podíl her okamžitého návrhu se stavovým průběhem a p95 návrhu.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p45b/logic-share.measure.ts
 *
 * Výchozí běh čte vývojové sady (`DEV_SETS`) a zapíše `baseline.json`. `P45B_OUT` přesměruje
 * výstup (T9: `dev.json`, T13: `final.json`), `P45B_SET` (čárkou oddělené cesty) vymění sady –
 * T13 tak měří vývojový panel P45A. Zapečetěné sady odmítne `openSet`.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import { DEV_SETS, measureSentence, openSet, summarize, type LogicRow } from './logic-share';

it('records the logic share and draft latency', async () => {
  vi.stubEnv('PLAY_READER', 'off');
  try {
    await loadRapier();
    const sets = process.env.P45B_SET?.split(',').map((path) => path.trim()) ?? [...DEV_SETS];
    const output = process.env.P45B_OUT ?? 'evals/play/p45b/baseline.json';
    // Zahřátí: první návrh platí za načtení modulů, do p95 nepatří.
    measureSentence('warmup', 'a dog runs in the park');
    const rows: (LogicRow & { set: string })[] = [];
    for (const set of sets) for (const { id, text } of openSet(set)) rows.push({ set, ...measureSentence(id, text) });
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const summary = summarize(rows);
    writeFileSync(output, JSON.stringify({ commit, sets, summary, rows }, null, 2) + '\n');
    console.log(JSON.stringify({ output, summary }));
    expect(rows.length).toBeGreaterThan(0);
  } finally { vi.unstubAllEnvs(); }
});
