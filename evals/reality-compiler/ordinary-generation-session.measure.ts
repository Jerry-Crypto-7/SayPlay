/** Opt-in actual core-to-browser integration; all emissions are disclosed stored
 * fixtures. No provider inference, hidden runtime inputs or semantic credit. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { canonical } from '../../src/ir/worlddoc';
import { chooseAuthored, emitterFor } from '../../src/worldstream/authored';
import { serverGrammar } from '../../src/worldstream/sessions';
import { browserRenderer } from '../../scripts/browser-renderer';
import { createReviewArtifactSink, type ReviewArtifactSink } from '../../scripts/reality-compiler-review-runner';
import { experimentDigest, type ReviewExperiment } from '../../scripts/reality-compiler-review-protocol';
import { createPromptMaterializationBridge } from '../../scripts/reality-compiler-live-prompt-session-browser';
import { runOrdinaryGenerationSession } from '../../scripts/reality-compiler-ordinary-generation-session';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const adapterFiles = ['scripts/reality-compiler-ordinary-generation.ts', 'scripts/reality-compiler-ordinary-generation-session.ts',
  'scripts/reality-compiler-live-prompt-session.ts', 'scripts/reality-compiler-live-prompt-session-browser.ts'];
function sourceSnapshot() {
  const tracked = execFileSync('git', ['--no-replace-objects', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src'],
    { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  return [...new Set([...tracked, ...adapterFiles])].sort().map(path => {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('NONREGULAR_SOURCE');
    const bytes = readFileSync(path); return { path, bytes: bytes.length, sha256: sha(bytes) };
  });
}

it.skipIf(process.env.RC_GENERATION_SESSION_SMOKE !== '1')('runs frozen fixture intent/compiler/repair through actual browser frame and UI input', async () => {
  const baseURL = process.env.RC_GENERATION_SESSION_BASE_URL;
  if (!baseURL) throw new Error('RC_GENERATION_SESSION_BASE_URL_REQUIRED');
  const directory = resolve('scratch/session7-ordinary-generation-browser', randomUUID()); mkdirSync(directory, { recursive: true });
  const sourcesBefore = sourceSnapshot(), head = execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  writeFileSync(resolve(directory, 'sources-before.json'), JSON.stringify(sourcesBefore, null, 2), { flag: 'wx' });
  const build = { buildId: readFileSync('.next/BUILD_ID', 'utf8').trim(), pageSha256: sha(readFileSync('.next/server/app/page.js')),
    sourceSnapshotSha256: sha(canonical(sourcesBefore)), head, scope: 'Current source bytes and existing local production artifact; not an atomic historical build attestation.' };
  const prompt = 'A cathedral of stacked shipping containers around a light well.', selected = chooseAuthored(prompt)!;
  const grammar = serverGrammar(); if (typeof grammar === 'string') throw new Error('GRAMMAR_UNAVAILABLE');
  const payloads = new Map<string, Uint8Array>();
  const artifact = (name: string, value: string) => {
    const bytes = Buffer.from(value); payloads.set(name, bytes); writeFileSync(resolve(directory, name), bytes, { flag: 'wx' });
    return { path: name, sha256: sha(bytes) };
  };
  const input = artifact('prompt.txt', prompt), grammarRef = artifact('grammar.json', JSON.stringify(grammar));
  const inputLog = artifact('ui-input.json', JSON.stringify({ version: 'materialization-ui-input-v1', actions: [
    { actionLabel: 'Walk to centralLightWell (visitor)', expectedApplied: 'Applied: sys.moveTo.centralLightWell' }] }));
  const noIntervention = artifact('intervention.json', JSON.stringify({ kind: 'not-used', scope: 'ordinary fixture UI interaction only' }));
  const buildRef = artifact('build.json', JSON.stringify(build)), deviceRef = artifact('device-config.json', JSON.stringify({ renderer: browserRenderer(), viewport: [1280, 900] }));
  const noProductionValidation = artifact('production-not-run.json', JSON.stringify({ status: 'NOT_RUN', mode: 'fixture', modelCalls: 0 }));
  const changeRef = artifact('change.json', JSON.stringify({ change: 'none', scope: 'integration smoke only, not before/after optimization' }));
  const frozenAt = new Date().toISOString();
  const experiment: ReviewExperiment = { version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'fixture-core-browser', frozenAt,
    change: { description: 'No optimization experiment; stored fixture integration', patch: changeRef },
    config: { model: 'gpt-5.6-sol', effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription', apiFallback: false,
      timeoutMs: 180000, limitsHash: sha('fixture-only; 180000ms overall chain; no production process claim'), deviceProfile: deviceRef,
      runtimeValidation: noProductionValidation, sandboxValidation: noProductionValidation },
    before: { commit: head, dirtyPatch: null, build: buildRef }, after: { commit: head, dirtyPatch: null, build: buildRef },
    cases: [{ id: 'fixture', kind: 'prompt', category: 'ordinary', input, inputLog, intervention: noIntervention, repetitions: 1 }] };
  writeFileSync(resolve(directory, 'frozen-scenarios.json'), JSON.stringify({ frozenAt, experiment,
    scenarios: [{ id: 'normal', intentionalInvalidCompilerInvocation: null }, { id: 'repair', intentionalInvalidCompilerInvocation: 2 }],
    missingDirtyPatchEvidence: true, sourceBytesRecordedSeparately: true, expectedOrigin: 'fixture', modelCalls: 0 }, null, 2), { flag: 'wx' });
  const browser = await chromium.launch({ headless: true, args: browserRenderer().args }), results: unknown[] = [];
  try {
    for (const scenario of ['normal', 'repair'] as const) {
      const scenarioRoot = resolve(directory, scenario); mkdirSync(scenarioRoot);
      const generation = { version: 'ordinary-generation-v1', frozenAt, experimentHash: experimentDigest(experiment), caseId: 'fixture', arm: 'before',
        repetition: 1, attemptId: scenario, grammar: grammarRef, sessionSeed: 4021, maxBlueprintRounds: 3, chainDeadlineMs: 180000, maxRequestBytes: 8388608 };
      const session = { version: 'ordinary-generation-session-v1', frozenAt, generationHash: sha(canonical(generation)), browserTimeoutMs: 45000 };
      // Persist every declared scenario and frozen configuration before invoking
      // even a fixture emitter. No failed scenario is discarded or selected away.
      writeFileSync(resolve(scenarioRoot, 'prepared.json'), JSON.stringify({ scenario, generation, session, experiment, mode: 'fixture' }, null, 2), { flag: 'wx' });
      const emit = emitterFor(selected.world); let invocations = 0, browserSink: ReviewArtifactSink | null = null;
      const bridge = createPromptMaterializationBridge({ browser, baseURL, prompt, origin: 'fixture', record: event => {
        if (!browserSink) throw new Error('BROWSER_ARCHIVE_MISSING'); browserSink.append(event);
      } });
      const result = await runOrdinaryGenerationSession({ experiment, generation, session, bridge,
        capability: { mode: 'fixture', emit: async request => {
          invocations++; return { origin: 'fixture', raw: JSON.stringify(scenario === 'repair' && invocations === 2 ? {} : await emit(request)),
            usage: null, remoteCompletion: 'not-started' };
        } }, sink: createReviewArtifactSink(resolve(scenarioRoot, 'session'), `${scenario}/session`),
        createSink: scope => {
          const sink = createReviewArtifactSink(resolve(scenarioRoot, scope), `${scenario}/${scope}`);
          if (scope === 'browser') browserSink = sink; return sink;
        }, readArtifact: path => { const bytes = payloads.get(path); if (!bytes) throw new Error('UNDECLARED_ARTIFACT'); return Uint8Array.from(bytes); } });
      results.push({ scenario, fixtureInvocations: invocations, result });
      expect(result).toMatchObject({ outcome: 'completed', mode: 'fixture', modelCalls: 0, humanObservation: false,
        liveMeasurement: 'NOT_RUN', browserCleanupVerified: true, generated: { outcome: 'compiled', origin: 'fixture', modelCalls: 0 },
        browser: { materializationOrigin: 'fixture', modelCalls: 0, cleanupVerified: true } });
      expect(invocations).toBe(scenario === 'repair' ? 3 : 2);
      expect(result.generated!.rounds).toHaveLength(scenario === 'repair' ? 2 : 1);
      expect(result.browser!.frameMs).not.toBeNull(); expect(result.browser!.interactionMs).not.toBeNull();
      expect(browser.contexts()).toHaveLength(0);
    }
    const sourcesAfter = sourceSnapshot(); writeFileSync(resolve(directory, 'sources-after.json'), JSON.stringify(sourcesAfter, null, 2), { flag: 'wx' });
    expect(sourcesAfter).toEqual(sourcesBefore);
    writeFileSync(resolve(directory, 'smoke-report.json'), JSON.stringify({ status: 'PASS', build, results,
      modelCalls: 0, liveMeasurement: 'NOT_RUN', humanObservation: false, scope: 'Two predeclared fixture core-to-browser cases, not measured optimization.' }, null, 2), { flag: 'wx' });
    console.log(`ORDINARY_GENERATION_SESSION_SMOKE_PASS ${directory}`);
  } catch (error) {
    writeFileSync(resolve(directory, 'smoke-report.json'), JSON.stringify({ status: 'FAIL', build, error: String(error), results }, null, 2), { flag: 'wx' }); throw error;
  } finally { await browser.close(); }
}, 120000);
