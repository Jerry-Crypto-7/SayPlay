/** Opt-in fixture-only actual browser materialization. Never inference/holdout. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { browserRenderer } from '../../scripts/browser-renderer';
import { createReviewArtifactSink } from '../../scripts/reality-compiler-review-runner';
import { createPromptMaterializationBridge } from '../../scripts/reality-compiler-live-prompt-session-browser';
import { runPromptMaterializationFixture } from '../../scripts/reality-compiler-live-prompt-session';
import { chooseAuthored, emitterFor } from '../../src/worldstream/authored';
import { readPlannerEmission } from '../../src/model/worldstream-intent';
import { compileWithRepair } from '../../src/model/worldstream-repair';
import { serverGrammar } from '../../src/worldstream/sessions';

it.skipIf(process.env.RC_MATERIALIZATION_SMOKE !== '1')('materializes a disclosed fixture through real frame and scripted UI interaction', async () => {
  const baseURL = process.env.RC_MATERIALIZATION_BASE_URL;
  if (!baseURL) throw new Error('RC_MATERIALIZATION_BASE_URL_REQUIRED');
  const directory = resolve('scratch/session7-ordinary-browser', randomUUID()); mkdirSync(directory, { recursive: true });
  const prompt = 'A cathedral of stacked shipping containers around a light well.';
  const selected = chooseAuthored(prompt)!, plan = readPlannerEmission(selected.world.planner), grammar = serverGrammar();
  if (!plan.ok || typeof grammar === 'string') throw new Error('FIXTURE_SETUP_FAILED');
  const compiled = await compileWithRepair({ plan: plan.value, grammar, sessionSeed: 4021, emit: emitterFor(selected.world) });
  if (compiled.kind !== 'compiled') throw new Error('FIXTURE_COMPILE_FAILED');
  const raw = JSON.stringify(compiled.result.value);
  const build = { buildId: readFileSync('.next/BUILD_ID', 'utf8').trim(),
    pageSha256: createHash('sha256').update(readFileSync('.next/server/app/page.js')).digest('hex'),
    scope: 'existing local production artifact, not a source/build identity attestation' };
  writeFileSync(resolve(directory, 'fixture-blueprint.json'), raw, { flag: 'wx' });
  const browser = await chromium.launch({ headless: true, args: browserRenderer().args });
  const results: unknown[] = [];
  try {
    for (const scenario of ['interaction', 'invalid-action', 'cancelled'] as const) {
      const sink = createReviewArtifactSink(resolve(directory, scenario), scenario), control = new AbortController();
      const bridge = createPromptMaterializationBridge({ browser, baseURL, prompt, origin: 'fixture', record: event => sink.append(event) });
      const actions = { version: 'materialization-ui-input-v1', actions: [{
        actionLabel: scenario === 'invalid-action' ? 'Missing synthetic action' : 'Walk to centralLightWell (visitor)',
        expectedApplied: 'Applied: sys.moveTo.centralLightWell' }] };
      if (scenario === 'cancelled') control.abort();
      const result = await runPromptMaterializationFixture({ bridge, raw, prompt, slot: { id: scenario, caseId: 'fixture', arm: 'before', repetition: 1, retryOf: null },
        build, inputLog: Buffer.from(JSON.stringify(actions)), timeoutMs: scenario === 'invalid-action' ? 5000 : 45000, sink, signal: control.signal });
      results.push({ scenario, result });
      expect(result).toMatchObject({ materializationOrigin: 'fixture', modelCalls: 0, humanObservation: false, liveMeasurement: 'NOT_RUN' });
      expect(result.outcome).toBe(scenario === 'interaction' ? 'completed' : 'failed');
      if (scenario === 'interaction') expect(result.cleanupVerified).toBe(true);
      expect(browser.contexts()).toHaveLength(0);
    }
    writeFileSync(resolve(directory, 'smoke-report.json'), JSON.stringify({ status: 'PASS', results }, null, 2), { flag: 'wx' });
    console.log(`MATERIALIZATION_SMOKE_PASS ${directory}`);
  } catch (error) {
    writeFileSync(resolve(directory, 'smoke-report.json'), JSON.stringify({ status: 'FAIL', error: String(error), results }, null, 2), { flag: 'wx' }); throw error;
  } finally { await browser.close(); }
}, 120000);

