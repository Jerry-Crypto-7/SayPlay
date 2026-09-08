import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'vitest';
import { renderReport, type Run } from '../../scripts/measure-reality-compiler';
import { applyReview, loadHoldout, scoreStudy } from '../../scripts/reality-compiler-evaluation';

it('reports recorded study observations and optionally applies attributed semantic review without changing raw runs', () => {
  const study = scoreStudy(JSON.parse(readFileSync('evals/reality-compiler/user-study.json', 'utf8')));
  writeFileSync('evals/reality-compiler/user-study-results.json', `${JSON.stringify(study, null, 2)}\n`);
  const runFile = process.env.RC_RUN_FILE;
  const reviewFile = process.env.RC_REVIEW_FILE;
  if (!runFile && !reviewFile) return;
  if (!runFile || !reviewFile) throw new Error('BOTH_RUN_AND_REVIEW_REQUIRED');
  const { oracle } = loadHoldout('evals/reality-compiler/holdout-v1');
  const run = JSON.parse(readFileSync(runFile, 'utf8')) as Run;
  const rawReview = JSON.parse(readFileSync(reviewFile, 'utf8'));
  const reviewed = applyReview(run, rawReview, oracle);
  const directory = resolve('evals/reality-compiler/reviews', randomUUID());
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'reviewed-run.json'), `${JSON.stringify(reviewed, null, 2)}\n`);
  writeFileSync(resolve(directory, 'review.json'), `${JSON.stringify(rawReview, null, 2)}\n`);
  writeFileSync(resolve(directory, 'report.md'), renderReport(reviewed, study.gates));
});
