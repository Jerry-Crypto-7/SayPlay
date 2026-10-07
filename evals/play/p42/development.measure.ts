/** Development corpus only; never imports the sealed P42 held-out file. */
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { loadRapier } from '@/play/arcade/physics/world';
import { compose } from '@/play/compose/compose';
import { extractIntent } from '@/play/intent/extract';
import { scoreTriples } from '../p41/score';
import type { IntentTriple } from '@/play/intent/contract';

it('measure development composition', async () => {
  await loadRapier();
  const corpus = JSON.parse(readFileSync('evals/play/p41/sentences.json', 'utf8')) as { groups: Record<string, { id: string; sentence: string; essential: IntentTriple[] }[]> };
  const filter = process.env.P42_DEV_FILTER;
  const rows = process.env.P42_DEV_SENTENCE ? [{ id: 'manual', sentence: process.env.P42_DEV_SENTENCE, essential: [] }] : Object.values(corpus.groups).flat().filter(row => !filter || new RegExp(filter, 'i').test(`${row.id} ${row.sentence}`));
  const results = rows.map(row => {
    const start = performance.now();
    try {
      const intent = extractIntent(row.sentence), made = compose(intent, 1);
      const score = scoreTriples(row.essential, made.witnesses, made.unmet);
      return { id: row.id, sentence: row.sentence, ms: performance.now() - start, intent, recipe: made.recipe, spec: made.spec, score, witnesses: made.witnesses, unmet: made.unmet, issues: made.issues };
    } catch (error) { return { id: row.id, sentence: row.sentence, ms: performance.now() - start, error: String(error) }; }
  });
  writeFileSync('evals/play/p42/development.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(row => ({ id: row.id, ms: Math.round(row.ms), error: row.error, missing: row.score?.missing, silent: row.score?.silent, unmet: row.unmet }))));
});
