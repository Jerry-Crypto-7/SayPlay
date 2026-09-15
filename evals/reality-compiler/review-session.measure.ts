/** Opt-in fixture smoke only. Does not expose a live transport or launch a server. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createReviewArtifactReader } from '../../scripts/reality-compiler-artifact-reader';
import { chromium, expect } from '@playwright/test';
import { it } from 'vitest';
import { EMISSION_MODEL } from '../../src/model/prompt';
import { PARAMETER_KEYS } from '../../src/worldstream/source-parameters';
import { ruleSupportParts } from '../../src/worldstream/rule-support';
import { browserRenderer } from '../../scripts/browser-renderer';
import { createReviewArtifactSink } from '../../scripts/reality-compiler-review-runner';
import { runInteractiveReviewSession } from '../../scripts/reality-compiler-review-runner-browser';
import { verifyReviewArtifacts, type ReviewExperiment } from '../../scripts/reality-compiler-review-protocol';
import museum from './museum.sim.json';

it.skipIf(process.env.RC_REVIEW_SMOKE !== '1')('archives scripted completion and missing confirmation without human or inference credit', async () => {
  const baseURL = process.env.RC_REVIEW_BASE_URL;
  if (!baseURL) throw new Error('RC_REVIEW_BASE_URL_REQUIRED_EXISTING_LOCAL_PRODUCTION_SERVER');
  const directory = resolve(process.env.RC_REVIEW_ARTIFACT_ROOT ?? 'scratch/review-session', randomUUID()); mkdirSync(directory, { recursive: true });
  const put = (path: string, body: string) => {
    writeFileSync(resolve(directory, path), body, { flag: 'wx' });
    return { path, sha256: createHash('sha256').update(body).digest('hex') };
  };
  const json = (path: string, value: unknown) => put(path, JSON.stringify(value, null, 2));
  const source = put('source.txt', readFileSync('evals/reality-compiler/museum-source.txt', 'utf8'));
  const log = json('input-log.json', []);
  const intervention = json('intervention.json', { ruleId: 'start_countdown', durationTicks: 200, forkTick: 0, observationTick: 1 });
  const scope = json('fixture-scope.json', { scripted: true, modelCalls: 0, humanObservation: false,
    experiment: 'NOT_RUN', purpose: 'Runner integration smoke; no before/after optimization claim or independent holdout.',
    runtimeValidation: 'NOT_RUN; fixture requires no dispatcher', sandboxValidation: 'NOT_RUN; fixture requires no dispatcher' });
  const build = json('build.json', { buildId: readFileSync('.next/BUILD_ID', 'utf8').trim(),
    pageSha256: createHash('sha256').update(readFileSync('.next/server/app/page.js')).digest('hex') });
  const commit = execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  const manifest: ReviewExperiment = {
    version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'fixture-smoke-not-an-optimization-experiment',
    frozenAt: new Date().toISOString(), change: { description: 'Fixture-only integration smoke; no before/after claim', patch: scope },
    config: { model: EMISSION_MODEL, effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription', apiFallback: false,
      timeoutMs: 180000, limitsHash: scope.sha256, deviceProfile: json('renderer.json', browserRenderer()), runtimeValidation: scope, sandboxValidation: scope },
    before: { commit, dirtyPatch: scope, build }, after: { commit, dirtyPatch: scope, build },
    cases: [{ id: 'fixture-source', kind: 'source', category: 'complete', input: source, inputLog: log, intervention, repetitions: 1 }],
  };
  json('fixture-manifest.json', manifest);
  const browser = await chromium.launch({ headless: true, args: browserRenderer().args });
  try {
    const readArtifact = createReviewArtifactReader(directory);
    for (const id of ['unconfirmed', 'scripted-completed', 'cancelled-driver'] as const) {
      const confirm = id === 'scripted-completed';
      const cancellation = new AbortController();
      const result = await runInteractiveReviewSession({ browser, baseURL, experiment: manifest,
        slot: { id, caseId: 'fixture-source', arm: 'before', repetition: 1, attempt: 1, retryOf: null },
        sink: createReviewArtifactSink(resolve(directory, id), id), readArtifact, humanTimeoutMs: confirm ? 60000 : 10000,
        signal: cancellation.signal,
        transport: { mode: 'fixture-smoke', fixture: async request => {
          const data = JSON.parse(request.user);
          return { sim: museum, missingCritical: [], conflicts: [], unsupported: [],
            claims: [{ claimId: 'fixture', text: 'Scripted smoke; semantic review unchecked.', support: 'sourced', interventionId: null,
              review: { status: 'unchecked' }, spans: [{ sourceId: data.sourceId, startByte: 0, endByte: Buffer.byteLength(data.text), excerpt: data.text }] }],
            bindings: ruleSupportParts(museum.rules).map(({ ruleId, part }) => ({ target: { kind: 'rule', id: ruleId }, part, claimIds: ['fixture'] })) };
        } },
        onFixturePage: async page => {
          await page.getByTestId('source-submit').click();
          await expect(page.getByTestId('source-parameter-review')).toBeVisible();
          if (id === 'cancelled-driver') {
            // Start real pending browser work, then synchronously abort before
            // returning it. Closing the context rejects this operation later.
            const pending = page.getByTestId('fixture-never-present').waitFor({ timeout: 60000 });
            cancellation.abort();
            return pending;
          }
          if (!confirm) return;
          // Deliberately automated test input. The runner exports protocolAttempt
          // null even if the browser marks an automation-generated click trusted.
          for (const key of PARAMETER_KEYS) await page.getByTestId(`parameter-${key}`).selectOption('supported');
          await page.getByTestId('source-confirm').click();
          await expect(page.getByTestId('runtime-controls')).toBeVisible();
          await page.getByText('Experiment with a future timer', { exact: true }).evaluate(element => (element as HTMLElement).click());
          await page.getByLabel('New duration (ticks, 20 per second)', { exact: true }).fill('200');
          await page.getByLabel('Fork tick', { exact: true }).fill('0');
          await page.getByLabel('Observation tick', { exact: true }).fill('1');
          await page.getByLabel('Reason for intervention', { exact: true }).fill('Scripted runner smoke, not human review');
          await page.getByRole('button', { name: 'Confirm timer experiment', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
          await expect(page.getByTestId('branch-comparison')).toBeVisible();
        },
      });
      expect(result).toMatchObject({ version: 'review-runner-fixture-v1', protocolAttempt: null, humanObservation: false, humanConfirmations: 0, modelCalls: 0 });
      if (!('result' in result)) throw new Error('FIXTURE_RESULT_REQUIRED');
      expect(result.result.outcome).toBe(confirm ? 'completed' : id === 'cancelled-driver' ? 'cancelled' : 'interrupted');
      if (id === 'cancelled-driver') expect(result.result.error).toBe('SESSION_CANCELLED');
      expect(browser.contexts()).toHaveLength(0);
      expect(result.result.parameterReview).toBeNull();
      expect(result.result.modelCalls).toBe(0);
      verifyReviewArtifacts(result, readArtifact);
    }
    json('smoke-report.json', { status: 'PASS', scripted: true, modelCalls: 0, humanObservation: false,
      cases: ['unconfirmed -> interrupted', 'automated fixture -> completed smoke / no human protocol attempt',
        'synchronous driver abort -> cancelled; late browser rejection consumed; context closed'] });
    console.log(`REVIEW_SESSION_FIXTURE_PASS ${directory}`);
  } catch (error) {
    json('smoke-report.json', { status: 'FAIL', scripted: true, modelCalls: 0, humanObservation: false, error: String(error) });
    throw error;
  } finally { await browser.close(); }
}, 180000);
