import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '@/play/draft';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import type { IntentTriple } from '@/play/intent/contract';
import { scoreTriples } from './score';
import { failedMeasurement, prepareDrafting } from './after-harness';

type Label = { id: string; sentence: string; essential: IntentTriple[] };

it('measures composed quick drafts against hand labels without opening held-out', async () => {
  const stage = process.env.P41_STAGE ?? 't10';
  if (!['t10', 't23'].includes(stage)) throw new Error('P41_STAGE must be t10 or t23');
  const set = JSON.parse(readFileSync('evals/play/p41/sentences.json', 'utf8')) as { groups: Record<string, Label[]> };
  const labels = ['multi-action', 'paraphrase', 'negation', 'unsupported', 'single'].flatMap(group => set.groups[group].map(label => ({ ...label, group })));
  const prepared = await prepareDrafting(loadRapier, draftGameSpecWithMeta);
  const rows = [];
  for (const label of labels) for (const seed of [1, 2, 3, 4, 5]) {
    const start = performance.now();
    try {
      const draft = prepared.draft(label.sentence, seed);
      const milliseconds = performance.now() - start;
      await preloadPhysics(draft.spec, loadRapier);
      const made = arcadeWorldOf(draft.spec, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const verified = verifyArcade(made.world, undefined, made.roleBindings);
      const eligible = verified.publishEligible && verified.replayEqual;
      const scored = scoreTriples(label.essential, verified.witnesses, draft.composition?.unmet ?? []);
      rows.push({ id: label.id, group: label.group, seed, sentence: label.sentence, milliseconds,
        cell: draft.composition?.cellId, spec: draft.spec, witnesses: verified.witnesses,
        ...scored, preserved: eligible && scored.preserved, silent: eligible ? scored.silent : [],
        evaluation: eligible ? 'verified' : 'unpublishable',
        publishEligible: verified.publishEligible, failures: verified.failures, replayEqual: verified.replayEqual,
        error: null });
    } catch (error) {
      rows.push({ id: label.id, group: label.group, seed, sentence: label.sentence, milliseconds: performance.now() - start,
        ...failedMeasurement(label.essential), evaluation: 'error', publishEligible: false, failures: [], replayEqual: false, error: String(error) });
    }
  }
  const times = rows.map(row => row.milliseconds).sort((a, b) => a - b);
  const summary = { sentences: labels.length, runs: rows.length,
    startupError: prepared.startupError, errors: rows.filter(row => row.error !== null).length,
    unpublishable: rows.filter(row => row.evaluation === 'unpublishable').length,
    silentEvaluatedRuns: rows.filter(row => row.evaluation === 'verified').length,
    preserved: rows.filter(row => row.preserved).length, preservedRate: rows.filter(row => row.preserved).length / rows.length,
    silent: rows.reduce((sum, row) => sum + row.silent.length, 0),
    builtRate: rows.filter(row => row.error === null && row.publishEligible && row.replayEqual).length / rows.length,
    draftP95ms: times[Math.ceil(times.length * 0.95) - 1] };
  writeFileSync(`evals/play/p41/after-${stage}.json`, `${JSON.stringify({ version: 1, stage, seeds: [1, 2, 3, 4, 5], summary, rows }, null, 2)}\n`);
  expect(summary.errors, 'Measurement failures are not evidence of published silent omissions').toBe(0);
  expect(summary.unpublishable, 'Unpublishable candidates are failed builds').toBe(0);
  expect(summary.silent, JSON.stringify(rows.filter(row => row.silent.length > 0).map(row => ({ id: row.id, seed: row.seed, silent: row.silent })))).toBe(0);
  if (stage === 't23') expect(summary.preservedRate).toBeGreaterThanOrEqual(0.7);
});
