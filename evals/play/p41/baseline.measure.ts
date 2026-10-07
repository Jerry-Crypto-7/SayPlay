import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import type { GameSpecV1 } from '@/play/spec';
import type { IntentTriple } from '@/play/intent/contract';
import { scoreTriples } from './score';

type Label = { id: string; sentence: string; essential: IntentTriple[] };
type Draft = { id: string; seed: number; spec?: GameSpecV1; error?: string; fellBack?: boolean; milliseconds?: number; honesty?: unknown };
type Row = Omit<Draft, 'error'> & { group: string; sentence: string; error: string | null; verification: object | null; witnesses: ReturnType<typeof verifyArcade>['witnesses'] } & ReturnType<typeof scoreTriples>;

it('measures frozen quick drafts with current action witnesses, excluding held-out', async () => {
  const dataset = JSON.parse(readFileSync('evals/play/p41/sentences.json', 'utf8')) as { groups: Record<string, Label[]> };
  const items = ['multi-action', 'paraphrase', 'negation', 'unsupported', 'single'].flatMap(group => dataset.groups[group].map(item => ({ ...item, group })));
  const scratch = join(process.cwd(), '.claude', 'scratchpads');
  mkdirSync(scratch, { recursive: true });
  const input = join(scratch, 'p41-baseline-input.json');
  const output = join(scratch, 'p41-baseline-drafts.json');
  writeFileSync(input, JSON.stringify(items.map(({ id, sentence }) => ({ id, sentence }))));
  try {
    execFileSync(process.execPath, ['scripts/p41/base-drafts.mjs', input, output], { timeout: 600_000, stdio: 'pipe' });
  } finally { unlinkSync(input); }
  const frozen = JSON.parse(readFileSync(output, 'utf8')) as { commit: string; lockSha256: string; seeds: number[]; rows: Draft[] };
  const labels = new Map(items.map(item => [item.id, item]));
  const rows: Row[] = [];
  for (const draft of frozen.rows) {
    const label = labels.get(draft.id)!;
    let witnesses: ReturnType<typeof verifyArcade>['witnesses'] = [];
    let verification: object | null = null;
    let error = draft.error ?? null;
    if (draft.spec) {
      try {
        await preloadPhysics(draft.spec, loadRapier);
        const made = arcadeWorldOf(draft.spec, draft.seed);
        if (!made.ok) error = made.issues.join('; ');
        else {
          const verdict = verifyArcade(made.world, undefined, made.roleBindings);
          witnesses = verdict.witnesses;
          verification = { outcome: verdict.bot.outcome, tick: verdict.bot.tick, hash: verdict.bot.hash, replayEqual: verdict.replayEqual, publishEligible: verdict.publishEligible, failures: verdict.failures };
        }
      } catch (failure) { error = String(failure); }
    }
    // The old generic notice has no triple-level admissions. Keep it for audit;
    // do not credit it with admitting an unrelated missing action.
    rows.push({ ...draft, group: label.group, sentence: label.sentence, error, verification, witnesses, ...scoreTriples(label.essential, witnesses) });
  }
  const summarize = (selected: typeof rows) => ({
    runs: selected.length,
    preserved: selected.filter(row => row.preserved && row.error === null).length,
    preservedRate: selected.filter(row => row.preserved && row.error === null).length / selected.length,
    missingTriples: selected.reduce((sum, row) => sum + row.missing.length, 0),
    silentTriples: selected.reduce((sum, row) => sum + row.silent.length, 0),
    runsWithSilentOmissions: selected.filter(row => row.silent.length > 0).length,
    legacyNotices: selected.filter(row => row.honesty != null).length,
    errors: selected.filter(row => row.error !== null).length,
  });
  const report = { version: 1, source: 'p41-base', commit: frozen.commit, lockSha256: frozen.lockSha256,
    witnessCommit: execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    seeds: frozen.seeds, sentences: items.length,
    notes: ['Held-out excluded.', 'Preservation uses hand-labelled triples and actual action witnesses.', 'Legacy generic notices retained separately; no triple-level admission is inferred.', 'Draft timings exclude bundling and worktree setup.'],
    summary: summarize(rows), groups: Object.fromEntries([...new Set(items.map(item => item.group))].map(group => [group, summarize(rows.filter(row => row.group === group))])), rows };
  writeFileSync('evals/play/p41/baseline.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary));
  expect(rows).toHaveLength(items.length * frozen.seeds.length);
  expect(new Set(rows.map(row => `${row.id}/${row.seed}`)).size).toBe(rows.length);
  expect(rows.every(row => !row.id.startsWith('ho-'))).toBe(true);
});
