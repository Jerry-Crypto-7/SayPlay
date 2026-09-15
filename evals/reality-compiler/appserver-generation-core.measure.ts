/** OFFLINE fixture-only core -> fixed JSONL adapter integration. No launcher. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { buildIntentRequest, readPlannerEmission } from '../../src/model/worldstream-intent';
import { compileWithRepair, MAX_BLUEPRINT_ROUNDS } from '../../src/model/worldstream-repair';
import type { UpstreamRequest } from '../../src/model/prompt';
import { chooseAuthored, emitterFor } from '../../src/worldstream/authored';
import { serverGrammar } from '../../src/worldstream/sessions';
import { createAppServerGenerationAdapter, type GenerationCleanup, type GenerationResult, type GenerationTransportFactory } from '../../scripts/subscription-appserver-generation';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const ownFiles = ['scripts/subscription-appserver-generation.ts', 'evals/reality-compiler/appserver-generation-core.measure.ts',
  'evals/reality-compiler/appserver-generation-core.md', 'scripts/subscription-text-model-catalog.json',
  'scripts/subscription-text-model-catalog.py', 'scripts/subscription-text-model-catalog.md',
  'vitest.measure.mts', 'package.json', 'package-lock.json'];
function snapshot() {
  const source = execFileSync('git', ['--no-replace-objects', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src'],
    { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  return [...new Set([...source, ...ownFiles])].sort().map(path => {
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('NONREGULAR_SOURCE');
    const bytes = readFileSync(path); return { path, bytes: bytes.length, sha256: sha(bytes) };
  });
}

it.skipIf(process.env.RC_APPSERVER_GENERATION_CORE !== '1')('measures actual core through fixture JSONL normal/repair and unknown-cleanup fence', async () => {
  const directory = resolve('scratch/session8-appserver-generation-core', randomUUID()); mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const sourceBefore = snapshot(); write('sources-before.json', sourceBefore);
  const head = execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  const prompt = 'A cathedral of stacked shipping containers around a light well.';
  const selected = chooseAuthored(prompt); if (!selected) throw new Error('FIXTURE_UNAVAILABLE');
  const grammar = serverGrammar(); if (typeof grammar === 'string') throw new Error('GRAMMAR_UNAVAILABLE');
  write('frozen.json', { frozenAt: new Date().toISOString(), head, sourceBeforeSha256: sha(JSON.stringify(sourceBefore)),
    prompt, grammar, seed: 4021, model: 'gpt-5.6-sol', maxBlueprintRounds: MAX_BLUEPRINT_ROUNDS, overallBudgetMs: 180000,
    origin: 'fixture', actualModelCalls: 0, actualProcessStarts: 0, browser: 'NOT_RUN', auth: 'NOT_RUN', network: 'NOT_RUN',
    scenarios: [{ id: 'normal', expectedEmits: 2, expectedRounds: 1 },
      { id: 'repair', expectedEmits: 3, expectedRounds: 2, malformedCompilerInvocation: 2 },
      { id: 'unknown-cleanup', unknownRemoteCleanupInvocation: 2, expectedEmits: 2, nextDispatchBlocked: true }] });
  // Store fixture bytes before any protocol invocation. This is deliberately
  // disclosed authored content, never new provider evidence.
  write('fixture-planner.json', selected.world.planner); write('fixture-compiler.json', selected.world.compiler);
  write('fixture-rejected-compiler.json', { intentionalMalformedCompiler: true });
  const summaries: unknown[] = [];
  let allPassed = true;
  for (const scenario of ['normal', 'repair', 'unknown-cleanup'] as const) {
    mkdirSync(resolve(directory, scenario));
    const began = performance.now(), deadlineAt = began + 180000, controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 180000);
    const emitFixture = emitterFor(selected.world);
    let factories = 0, calls = 0, observedTurns = 0;
    const attempts: { call: number; stage: string; remainingBudgetMs: number; outputBytes: number; outcome: string;
      error: string | null; modelCalls: number | null; observedTurns: number; cleanup: GenerationCleanup }[] = [];
    const phases: unknown[] = [], pendingSends = new Set<ReturnType<typeof setImmediate>>();
    const outbound: Record<number, unknown[]> = {};
    const factory: GenerationTransportFactory = callbacks => {
      const own = ++factories, threadId = `fixture-thread-${own}`, turnId = `fixture-turn-${own}`;
      let finish!: (value: GenerationCleanup) => void, system = '', closed = false;
      const cleanup = new Promise<GenerationCleanup>(resolve => { finish = resolve; });
      outbound[own] = [];
      const frame = (value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value) + '\n');
        // Actual byte chunks, deliberately split mid-line; decoder/state-machine
        // is the real adapter. These bytes originate solely in this fixture.
        const split = Math.max(1, Math.floor(bytes.length / 3));
        callbacks.onOutput('stdout', bytes.subarray(0, split)); callbacks.onOutput('stdout', bytes.subarray(split));
      };
      return {
        cleanup,
        close: () => { closed = true; finish({ local: 'confirmed', remote: scenario === 'unknown-cleanup' && own === 2 ? 'unknown' : 'confirmed' }); },
        send: async sent => {
          outbound[own].push(structuredClone(sent));
          const timer = setImmediate(() => {
            pendingSends.delete(timer);
            if (closed) return;
            void (async () => {
              if (sent.method === 'initialize') {
                frame({ id: 1, result: { userAgent: 'fixture-codex-0.145.0', codexHome: '/work/appserver-home/fixed-abcdefgh', platformFamily: 'unix', platformOs: 'linux' } });
              } else if (sent.method === 'initialized') {
                frame({ method: 'remoteControl/status/changed', emittedAtMs: 1234, params: { status: 'disabled', serverName: 'offline-fixture',
                  installationId: 'a464dc32-582b-48ae-a6b8-2b1978c1ddae', environmentId: null } });
              } else if (sent.method === 'thread/start') {
                const p = sent.params as Record<string, unknown>;
                expect(p).toMatchObject({ ephemeral: true, environments: [], model: 'gpt-5.6-sol', modelProvider: 'openai',
                  config: { 'features.multi_agent': false, 'features.multi_agent_v2': false } });
                expect(typeof p.developerInstructions).toBe('string'); system = p.developerInstructions as string;
                frame({ id: 2, result: { thread: { id: threadId, path: null, ephemeral: true }, model: 'gpt-5.6-sol', modelProvider: 'openai',
                  reasoningEffort: 'low', cwd: '/work', approvalPolicy: 'never', runtimeWorkspaceRoots: [], sandbox: { type: 'readOnly', networkAccess: false } } });
              } else if (sent.method === 'turn/start') {
                const p = sent.params as { model: string; effort: string; input: { type: string; text: string }[]; environments: unknown[] };
                expect(p).toMatchObject({ model: 'gpt-5.6-sol', effort: 'low', environments: [], input: [{ type: 'text' }] });
                const request = { model: p.model, system, user: p.input[0].text };
                const value = scenario === 'repair' && own === 2 ? { intentionalMalformedCompiler: true } : await emitFixture(request);
                const text = JSON.stringify(value), turn = { id: turnId, status: 'inProgress', error: null, items: [], itemsView: 'notLoaded' };
                frame({ method: 'turn/started', params: { threadId, turn }, emittedAtMs: 1235 });
                frame({ id: 3, result: { turn } });
                const params = { threadId, turnId };
                frame({ method: 'item/started', params: { ...params, item: { type: 'agentMessage', id: `item-${own}`, text: '', phase: null } } });
                frame({ method: 'item/agentMessage/delta', params: { ...params, itemId: `item-${own}`, delta: text } });
                frame({ method: 'item/completed', params: { ...params, item: { type: 'agentMessage', id: `item-${own}`, text, phase: 'final_answer' } } });
                frame({ method: 'turn/completed', params: { threadId, turn: { ...turn, status: 'completed' } } });
              } else throw new Error('UNEXPECTED_OUTBOUND_RPC');
            })().catch(error => {
              write(`${scenario}/fixture-error-${own}.json`, { error: String(error) });
              frame({ id: -1, error: { code: -1, message: 'fixture-failure' } });
            });
          });
          pendingSends.add(timer);
        },
      };
    };
    const adapter = createAppServerGenerationAdapter(factory);
    const late: unknown[] = [];
    const recordResponse = (number: number, result: GenerationResult) => {
      const { wireRaw, stderrRaw, jsonText, json, ...metadata } = result;
      writeFileSync(resolve(directory, `${scenario}/call-${number}-wire.jsonl`), wireRaw, { flag: 'wx' });
      writeFileSync(resolve(directory, `${scenario}/call-${number}-stderr.txt`), stderrRaw, { flag: 'wx' });
      write(`${scenario}/call-${number}-generation-text.json`, { jsonText, sha256: jsonText === null ? null : sha(jsonText) });
      write(`${scenario}/call-${number}-normalized.json`, json);
      write(`${scenario}/call-${number}-result.json`, { ...metadata, wireSha256: sha(wireRaw), outbound: outbound[number] ?? [],
        origin: 'fixture', actualModelCalls: 0, processCleanupScope: 'injected fixture lifecycle only; no OS process exists' });
    };
    const emit = async (request: UpstreamRequest) => {
      const remainingBudgetMs = Math.floor(deadlineAt - performance.now());
      if (controller.signal.aborted || remainingBudgetMs <= 0) throw new Error('SHARED_DEADLINE');
      const number = ++calls, stage = number === 1 ? 'planner' : number === 2 ? 'compiler' : 'repair';
      write(`${scenario}/call-${number}-request.json`, { request, stage, remainingBudgetMs, overallBudgetMs: 180000 });
      const result = await adapter.generate({ request, remainingBudgetMs }, controller.signal, () => { observedTurns++; }, value => { late.push({ call: number, value }); });
      recordResponse(number, result);
      attempts.push({ call: number, stage, remainingBudgetMs, outputBytes: result.outputBytes, outcome: result.outcome,
        error: result.error, modelCalls: result.modelCalls, observedTurns: result.observedTurns, cleanup: result.cleanup });
      if (result.outcome !== 'completed') throw new Error(result.error ?? 'GENERATION_FAILED');
      return result.json;
    };
    try {
      const plannerRequest = buildIntentRequest(prompt), plannerRaw = await emit(plannerRequest);
      const plan = readPlannerEmission(plannerRaw); write(`${scenario}/planner-validation.json`, plan);
      expect(plan.ok).toBe(true); if (!plan.ok) throw new Error('PLANNER_REJECTED');
      const compiled = await compileWithRepair({ plan: plan.value, grammar, sessionSeed: 4021, maxRounds: MAX_BLUEPRINT_ROUNDS, emit,
        now: () => performance.now(), observePhase: name => {
          const started = performance.now(); return outcome => { phases.push({ name, outcome, elapsedMs: performance.now() - started }); };
        } });
      write(`${scenario}/compiler-outcome.json`, compiled.kind === 'unavailable' ? { kind: compiled.kind, detail: compiled.detail, rounds: compiled.rounds } : compiled);
      if (scenario === 'unknown-cleanup') {
        expect(compiled.kind).toBe('unavailable'); expect(calls).toBe(2); expect(factories).toBe(2);
        const fenced = await adapter.generate({ request: plannerRequest, remainingBudgetMs: Math.floor(deadlineAt - performance.now()) });
        write(`${scenario}/blocked-next-dispatch.json`, fenced);
        expect(fenced.error).toBe('PRIOR_TERMINATION_UNKNOWN'); expect(factories).toBe(2);
        expect(attempts[1]).toMatchObject({ error: 'TERMINATION_UNKNOWN', modelCalls: null, cleanup: { remote: 'unknown' } });
      } else {
        expect(compiled.kind).toBe('compiled'); if (compiled.kind !== 'compiled') throw new Error('COMPILER_REJECTED');
        expect(calls).toBe(scenario === 'normal' ? 2 : 3); expect(compiled.rounds).toHaveLength(scenario === 'normal' ? 1 : 2);
        if (scenario === 'repair') expect(compiled.rounds[0].fault).not.toBeNull();
        write(`${scenario}/derived-blueprint.json`, { origin: 'fixture-derived-by-compiler', blueprint: compiled.result.value,
          sha256: sha(JSON.stringify(compiled.result.value)), rawProviderResponse: false });
      }
      expect(observedTurns).toBe(factories); expect(attempts.every(value => value.modelCalls === null)).toBe(true);
      expect(attempts.every((value, index) => value.remainingBudgetMs > 0 && value.remainingBudgetMs <= 180000 &&
        (index === 0 || value.remainingBudgetMs <= attempts[index - 1].remainingBudgetMs))).toBe(true);
      expect(performance.now()).toBeLessThan(deadlineAt);
      summaries.push({ scenario, status: 'PASS', calls, factories, observedTurns, adapterModelCalls: null, actualModelCalls: 0,
        actualProcessStarts: 0, elapsedMs: performance.now() - began, attempts, rounds: compiled.rounds });
    } catch (error) {
      allPassed = false; summaries.push({ scenario, status: 'FAIL', error: String(error), calls, factories, attempts });
    } finally {
      clearTimeout(deadline); controller.abort(); for (const timer of pendingSends) clearImmediate(timer);
      write(`${scenario}/phases.json`, phases); write(`${scenario}/late-evidence.json`, late);
    }
  }
  const sourceAfter = snapshot(); write('sources-after.json', sourceAfter);
  const sourcesStable = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
  write('summary.json', { status: allPassed && sourcesStable ? 'PASS' : 'FAIL', sourceStable: sourcesStable, results: summaries,
    actualModelCalls: 0, actualProcessStarts: 0, auth: 'NOT_RUN', network: 'NOT_RUN', browser: 'NOT_RUN', productionReady: false,
    scope: 'Actual core and adapter over in-process synthetic JSONL; not a live CLI, optimization experiment, browser or inference measurement.' });
  console.log(`APPSERVER_GENERATION_CORE_ARTIFACT ${directory}`);
  expect(sourcesStable).toBe(true); expect(allPassed).toBe(true);
}, 60000);
