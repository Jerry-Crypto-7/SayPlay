/** Explicit opt-in T18 live series. Ordinary tests never include *.measure.ts. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { it, expect } from 'vitest';
import { buildIntentRequest, readPlannerEmission } from '@/model/worldstream-intent';
import { compileWithRepair } from '@/model/worldstream-repair';
import { requestStage } from '@/model/worldstream-prompt';
import { frozenGrammar } from '@/model/client';
import { observePhase, observePhaseAsync } from '@/model/phase-observer';
import { createServerMetrics } from '@/server/worldstream-metrics';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import type { UpstreamRequest } from '@/model/prompt';
import { readQualityCases, frozenFiles, qualityRoot } from './corpus';
import { createCallBudget, INTEGRATED_LIMITS, summarizeIntegrated } from './integrated';

it('records all 30 current hybrid generations without replacing the historical baseline', async () => {
  const requested = process.env.P20_T18_RUN_DIR;
  if (!requested) throw new Error('P20_T18_RUN_DIR must explicitly name a new private run directory');
  const runVersion=process.env.P20_T18_RUN_VERSION??'p20-t18-hybrid-v1';
  if(!/^p20-t18-hybrid-v[1-9][0-9]*$/.test(runVersion))throw new Error('Invalid explicit experiment version');
  const root = resolve(requested), cases = readQualityCases('all'); expect(cases).toHaveLength(30);
  const grammar = frozenGrammar(); if (!grammar.ok) throw new Error(grammar.detail);
  const config = upstreamConfigFromEnv({ ...process.env, WORLDSMITH_MODEL_ENDPOINT: 'codex-cli',
    WORLDSMITH_MODEL: 'gpt-6-astra', WORLDSMITH_MODEL_EFFORT: 'medium', WORLDSMITH_MODEL_PROFILE: 'subscription',
    WORLDSMITH_MODEL_KEY: 'unused-cli-transport', WORLDSMITH_CALL_CAP: String(INTEGRATED_LIMITS.calls),
    WORLDSMITH_UPSTREAM_TIMEOUT_MS: String(INTEGRATED_LIMITS.callTimeoutMs), WORLDSMITH_MAX_OUTPUT_TOKENS: String(INTEGRATED_LIMITS.outputTokens),
    WORLDSMITH_USD_PER_MTOK_IN: '1', WORLDSMITH_USD_PER_MTOK_OUT: '1' });
  if (!config) throw new Error('Existing authorized CLI transport unavailable');
  mkdirSync(root); mkdirSync(join(root, 'raw')); mkdirSync(join(root, 'hybrid'));
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const write = (file: string, value: unknown) => {
    const target = join(root, file); writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 2)); renameSync(`${target}.tmp`, target);
  };
  const code: Record<string, { sha256: string; archivePath: string }> = {};
  const snapshot = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) snapshot(file);
      else if (entry.isFile() && /\.(ts|tsx|json|mjs|glsl)$/.test(entry.name)) {
        const bytes = readFileSync(file), name = relative(process.cwd(), file).replaceAll('\\', '/');
        const archivePath = `source/${name}.txt`;
        code[name] = { sha256: hash(bytes), archivePath }; const target = join(root, archivePath); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' });
      }
    }
  };
  for (const directory of ['model', 'ir', 'sim', 'verify', 'scene', 'geom', 'shape', 'worldstream', 'assets', 'server']) snapshot(join('src', directory));
  snapshot('evals/worldstream/world-quality');
  const datasetHashes = Object.fromEntries([...frozenFiles, 'MANIFEST.lock'].map(file => [file, hash(readFileSync(join(qualityRoot, file)))]));
  const a4Path = 'plans/P20/a4/replay-20260917/local-replay.json';
  const environment = { version: runVersion, startedAt: new Date().toISOString(), provenance: 'live generation via existing authorized codex-cli',
    model: 'gpt-6-astra', effort: 'medium', speed: 'standard', seed: 4021, limits: INTEGRATED_LIMITS,
    accounting: 'nominal subscription accounting units, not a USD price claim', commit: execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirtyDiffHash: hash(execFileSync('git', ['--no-replace-objects', 'diff', 'HEAD'], { maxBuffer: 64 * 1024 ** 2 })), code, datasetHashes,
    node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, gpu: null, browser: null, cacheState: 'unknown',
    a4: { provenance: 'existing ten-case local fixture replay; not ten live interventions; not rerun', path: a4Path, sha256: hash(readFileSync(a4Path)) } };
  write('environment.json', environment); write('expected-cases.json', cases);
  for (const [file, record] of Object.entries(code)) if (hash(readFileSync(file)) !== record.sha256) throw new Error(`Source changed during snapshot: ${file}`);
  const branch = upstreamBranch(config), budget = createCallBudget();
  type Row = { id: string; status: string; intentMs: number | null; totalMs: number | null; calls: number; failure: unknown; rounds: unknown; phases: unknown };
  const rows: Row[] = cases.map(entry => ({ id: entry.id, status: 'pending', intentMs: null, totalMs: null, calls: 0, failure: null, rounds: [], phases: [] }));
  const checkpoint = () => { write('results.json', rows); write('summary.json', { ...summarizeIntegrated(rows), calls: budget.total, updatedAt: new Date().toISOString() }); };
  checkpoint();
  let transportFailure = false;
  for (const [index, entry] of cases.entries()) {
    const row = rows[index], started = performance.now(), metrics = createServerMetrics(entry.id, 'prompt'); metrics.setProvenance('live');
    row.status = 'running'; checkpoint();
    let malformed = false;
    const emit = async (request: UpstreamRequest) => {
      const taken = budget.take(entry.id), file = `raw/${entry.id}-${taken.caseCall}.json`, at = performance.now(); row.calls++;
      const pending = { ...taken, caseId: entry.id, stage: requestStage(request), startedAt: new Date().toISOString(), request, status: 'pending' };
      write(file, pending); checkpoint();
      let responseSaved = false;
      try {
        const result = await branch.generate({ prompt: request.user, request });
        write(file, { ...pending, status: result.ok ? 'answered' : 'failed', ms: performance.now() - at, result });
        responseSaved = true;
        if (!result.ok) { malformed = result.reason === 'MALFORMED_RESPONSE'; transportFailure = !malformed; throw new Error(`${result.reason}: ${result.detail}`); }
        return result.body;
      } catch (error) {
        if (!responseSaved) { transportFailure = true; write(file, { ...pending, status: 'threw', ms: performance.now() - at, error: String(error) }); }
        // Keep the already written upstream failure body; thrown process errors get their own artifact.
        write(`raw/${entry.id}-${taken.caseCall}-exception.json`, { caseId: entry.id, ms: performance.now() - at, error: String(error) }); throw error;
      }
    };
    try {
      const answer = await observePhaseAsync(metrics.observe, 'intent-emitter', () => emit(buildIntentRequest(entry.prompt)));
      const plan = observePhase(metrics.observe, 'intent-validation', () => readPlannerEmission(answer, { prompt: entry.prompt, requireSceneSpec: true }));
      write(`raw/${entry.id}-planner.json`, plan);
      if (!plan.ok) { row.status = 'rejected'; row.failure = plan; }
      else {
        row.intentMs = performance.now() - started; checkpoint();
        const outcome = await compileWithRepair({ plan: plan.value, grammar: grammar.value, sessionSeed: 4021, emit,
          maxRounds: INTEGRATED_LIMITS.compilerAttempts, observePhase: metrics.observe });
        write(`raw/${entry.id}-outcome.json`, outcome); row.rounds = outcome.rounds;
        if (outcome.kind === 'compiled') {
          row.status = 'compiled'; write(`hybrid/${entry.id}.json`, { id: entry.id, prompt: entry.prompt, model: `gpt-6-astra@medium#cli / ${runVersion}`, blueprint: outcome.result.value });
        } else { row.status = outcome.kind === 'unavailable' && !malformed ? 'unavailable' : 'rejected'; row.failure = outcome; }
      }
    } catch (error) { row.status = malformed ? 'rejected' : 'unavailable'; row.failure = String(error); }
    finally { row.totalMs = performance.now() - started; row.phases = metrics.snapshot(); checkpoint();
      process.stdout.write(`${entry.id} ${row.status} ${Math.round(row.totalMs)}ms calls=${row.calls} total=${budget.total}/90\n`); }
    if (transportFailure) break; // Do not repeatedly launch requests against an unavailable transport.
  }
  write('completion.json', { finishedAt: new Date().toISOString(), complete: rows.every(row => row.status !== 'pending' && row.status !== 'running'),
    stopReason: transportFailure ? 'transport-failure-no-automatic-retry' : null, calls: budget.total });
  checkpoint(); expect(rows.every(row => row.status !== 'pending' && row.status !== 'running')).toBe(true);
}, INTEGRATED_LIMITS.runnerTimeoutMs);
