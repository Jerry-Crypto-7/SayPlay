/** T10: sekvenční runner. Adaptér měří skutečný produkt; oracle nikdy nejde do emitoru. */
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import protocol from '../evals/reality-compiler/protocol.json';
import type { UpstreamRequest } from '../src/model/prompt';
import type { GenerationBranch } from '../src/server/pipeline';
import { costUsd, processSpendCap, type SpendCap, type Usage } from '../src/server/spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from '../src/server/upstream';
import { killState } from '../src/server/kill-switch';

export type Origin = 'live' | 'cache' | 'prepared' | 'offline';
export type Phase = 'create' | 'edit' | 'prompt';
export type Gate = 'PASS' | 'FAIL' | 'NOT_RUN';
export type Stage = typeof protocol.stages[number];
export interface CaseInput {
  id: string;
  kind: 'complete' | 'missing' | 'conflict' | 'prompt';
  source: string;
  intervention: string;
  clarification: string | null;
}
export interface Suite {
  status: 'holdout' | 'development';
  cases: CaseInput[];
  /** Samostatný hash oraclu pořízený před generováním, nikoli obsah pro model. */
  oracleSha256: string;
}
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface RunConfig {
  billing?: 'api' | 'subscription';
  runId: string; commit: string; dirty: boolean; model: string; modelConfig: Record<string, string | number | boolean>;
  origin: Origin; suiteSha256: string; authorized: boolean; spendLimitUsd: number | null;
  maxCalls: number; maxWallMs: number;
}
export interface CallRecord {
  index: number; phase: Phase; retry: number; stage: string; status: 'started' | 'ok' | 'failed' | 'blocked';
  latencyMs: number | null; usage: Usage | null; usd: number | null; reservedUsd: number;
  settledUsd: number | null;
  priceMethod: 'usage-times-configured-tariff' | 'subscription-no-unit-tariff' | 'UNKNOWN' | 'not-called';
  input: unknown; output: unknown; error: string | null;
}
export interface PhaseResult {
  status: 'success' | 'failed' | 'NOT_RUN'; error: string | null;
  wallMs: number | null; machineMs: number | null; stages: Record<string, number[]>;
  execution?: 'inference' | 'deterministic' | 'replay';
  stageStatus?: Record<string, 'measured' | 'not-used' | 'NOT_RUN'>;
}
export interface Checks {
  invariants: boolean | null; criticalSupported: boolean | null; criticalCitations: boolean | null;
  otherCitations: { passed: number; total: number } | null;
  rejectedUnchanged: boolean | null; problematicBlocked: boolean | null;
  branchDelta: boolean | null; rules: { tp: number; fp: number; fn: number } | null;
  visualUsable: boolean | null;
}
export interface PairRecord {
  index: number; caseId: string; repeat: number; input: CaseInput;
  phases: Partial<Record<Phase, PhaseResult>>; calls: CallRecord[]; checks: Checks | null;
}
export interface Run {
  config: RunConfig; protocolSha256: string; suiteStatus: Suite['status'];
  startedAt: string; pairs: PairRecord[]; stopReason: string | null;
}
export interface Context {
  /** Každý placený planner/compiler/repair MUSÍ použít tento emitor. */
  emit(request: UpstreamRequest, stage?: 'planner' | 'compiler' | 'repair', retry?: number): Promise<unknown>;
  stage<T>(name: Stage, work: () => Promise<T>): Promise<T>;
  recordStage(name: Stage, ms: number): void;
  notUsed(name: Stage): void;
}
export interface ProductResult {
  /** Jen potvrzený frame/interakce nebo oba výsledky na stejném tiku. */
  completed: boolean;
  artifact: unknown;
  execution?: 'inference' | 'deterministic' | 'replay';
  /** Čas browseru od skutečného potvrzení, nikoli od založení stránky. */
  timing?: { wallMs: number; humanWaitMs: number };
  error?: 'TIMEOUT' | 'REJECTED' | 'VALIDATION_FAILED';
}
export interface Adapter {
  prepare?(input: CaseInput, phase: Phase, previous: unknown): Promise<void>;
  execute(input: CaseInput, phase: Phase, previous: unknown, context: Context): Promise<ProductResult>;
  /** Nezávislý oracle vyhodnocuje až výsledek; není argumentem execute/emit. */
  evaluate(input: CaseInput, created: unknown, edited: unknown): Promise<Checks>;
}
export interface Dependencies {
  subscription?: (request: UpstreamRequest) => Promise<{ body: unknown; usage: Usage | null }>;
  adapter?: Adapter; branch?: GenerationBranch; cap?: Pick<SpendCap, 'reserve'>;
  now?: () => number;
  /** Synchronní durable journal. Selhání zápisu ukončí běh před dalším voláním. */
  journal(event: unknown): void;
  /** Rediguje skutečné secret hodnoty/endpointy před každým zápisem. */
  redact(value: unknown): unknown;
}
/** Zapojení stávajícího provideru bez čtení souborů s přihlašovacími údaji a bez nového capu. */
export function configuredTransport(config: RunConfig): Pick<Dependencies, 'branch' | 'cap' | 'redact'> {
  if (config.origin !== 'live' || !config.authorized || !finitePositive(config.spendLimitUsd))
    return { redact: (value) => value };
  const upstream = upstreamConfigFromEnv(process.env);
  if (!upstream) return { redact: (value) => value };
  if (config.model !== upstream.model || digest(config.modelConfig) !== digest({ effort: upstream.effort,
    maxOutputTokens: upstream.maxOutputTokens, timeoutMs: upstream.timeoutMs,
    usdPerMTokIn: upstream.pricing.usdPerMTokIn, usdPerMTokOut: upstream.pricing.usdPerMTokOut }))
    throw new Error('MODEL_CONFIG_MISMATCH');
  const branch = upstreamBranch(upstream);
  return {
    branch, cap: { reserve: async (usd) => {
      if ((await killState(process.env)).upstream) throw new Error('UPSTREAM_DISABLED');
      return processSpendCap().reserve(usd);
    } },
    redact: (value) => {
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') {
          for (const secret of [upstream.apiKey, upstream.endpoint]) if (secret) v = (v as string).split(secret).join('[REDACTED]');
          return v;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, walk(child)]));
        return v;
      };
      return walk(value);
    },
  };
}
export function fileJournal(path: string): (event: unknown) => void {
  const fd = openSync(path, 'wx'); closeSync(fd);
  return (event) => {
    // fsync chrání i průběžný started záznam před pádem procesu.
    const handle = openSync(path, 'a');
    try { writeSync(handle, `${JSON.stringify(event)}\n`); fsyncSync(handle); }
    finally { closeSync(handle); }
  };
}
export function validateSuite(suite: Suite, expected: string): void {
  if (digest(suite) !== expected) throw new Error('SUITE_HASH_MISMATCH');
  if (!/^[a-f0-9]{64}$/.test(suite.oracleSha256)) throw new Error('ORACLE_HASH_REQUIRED');
  if (new Set(suite.cases.map((c) => c.id)).size !== suite.cases.length) throw new Error('DUPLICATE_CASE');
  if (!suite.cases.length || suite.cases.some((c) => !c.id || !c.source || c.source.length > protocol.maxSourceChars ||
    (c.kind !== 'prompt' && !c.intervention) ||
    (['missing', 'conflict'].includes(c.kind) && !c.clarification))) throw new Error('INVALID_CASE');
  if (suite.status === 'holdout') {
    const prompt = suite.cases.every((c) => c.kind === 'prompt');
    if (suite.cases.length !== 10 || (!prompt && Object.entries(protocol.distribution).some(
      ([kind, count]) => suite.cases.filter((c) => c.kind === kind).length !== count))) throw new Error('INVALID_DISTRIBUTION');
  }
}
const finitePositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const validUsage = (u: Usage | null): u is Usage => u !== null &&
  [u.inputTokens, u.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0) && u.inputTokens + u.outputTokens > 0;

export async function runBenchmark(suite: Suite, config: RunConfig, deps: Dependencies): Promise<Run> {
  validateSuite(suite, config.suiteSha256);
  if (!config.runId || !config.commit || !Number.isSafeInteger(config.maxCalls) || config.maxCalls < 1 ||
    !finitePositive(config.maxWallMs)) throw new Error('INVALID_RUN_CONFIG');
  const now = deps.now ?? (() => performance.now());
  const start = now();
  const run: Run = { config: structuredClone(config), protocolSha256: digest(protocol), suiteStatus: suite.status,
    startedAt: new Date().toISOString(), pairs: [], stopReason: null };
  let journalFailed = false;
  const save = (event: unknown) => {
    try { deps.journal(deps.redact(event)); }
    catch (e) { journalFailed = true; throw e; }
  };
  save({ event: 'run-start', run, suite });
  const subscription = config.billing === 'subscription';
  const access = config.origin !== 'live' ? null : !config.authorized ? 'ACCESS_NOT_AUTHORIZED' : subscription ?
    (!deps.subscription ? 'SUBSCRIPTION_UNCONFIGURED' : null) :
    !finitePositive(config.spendLimitUsd) || !deps.cap ? 'SPEND_LIMIT_REQUIRED' :
    !deps.branch ? 'PROVIDER_UNCONFIGURED' : null;
  let charged = 0;
  let callCount = 0;
  for (let repeat = 0; repeat < protocol.repetitions; repeat++) for (const input of suite.cases) {
    const pair: PairRecord = { index: run.pairs.length, caseId: input.id, repeat, input: structuredClone(input),
      phases: {}, calls: [], checks: null };
    run.pairs.push(pair);
    let created: unknown;
    let edited: unknown;
    const phases: Phase[] = input.kind === 'prompt' ? ['prompt'] : ['create', 'edit'];
    for (const phase of phases) {
      const reason = access ?? run.stopReason ?? (!deps.adapter ? 'PRODUCT_ADAPTER_MISSING' :
        now() - start >= config.maxWallMs ? 'WALL_LIMIT' :
        phase === 'edit' && pair.phases.create?.status !== 'success' ? 'CREATE_NOT_COMPLETED' : null);
      if (reason) {
        pair.phases[phase] = { status: 'NOT_RUN', error: reason, wallMs: null, machineMs: null, stages: {} };
        save({ event: 'phase-end', index: pair.index, phase, result: pair.phases[phase] }); continue;
      }
      if (deps.adapter!.prepare) {
        try { await deps.adapter!.prepare(structuredClone(input), phase, created); }
        catch {
          pair.phases[phase] = { status: 'failed', error: 'PREPARATION_FAILED', wallMs: null, machineMs: null, stages: {} };
          save({ event: 'phase-end', index: pair.index, phase, result: pair.phases[phase] }); continue;
        }
      }
      const phaseStart = now();
      const result: PhaseResult = { status: 'failed', error: null, wallMs: null, machineMs: null, stages: {},
        stageStatus: Object.fromEntries(protocol.stages.map(s => [s, 'NOT_RUN' as const])) };
      pair.phases[phase] = result;
      save({ event: 'phase-start', index: pair.index, phase });
      let phaseCalls = 0;
      const recordStage = (name: Stage, ms: number) => {
        if (!protocol.stages.includes(name) || !Number.isFinite(ms) || ms < 0) throw new Error('INVALID_STAGE');
        (result.stages[name] ??= []).push(ms); result.stageStatus![name] = 'measured';
      };
      const context: Context = {
        recordStage,
        notUsed: (name) => {
          if (!protocol.stages.includes(name) || result.stages[name]?.length) throw new Error('INVALID_UNUSED_STAGE');
          result.stageStatus![name] = 'not-used';
        },
        stage: async (name, work) => {
          if (!protocol.stages.includes(name)) throw new Error('INVALID_STAGE');
          const at = now();
          try { return await work(); }
          finally { recordStage(name, now() - at); }
        },
        emit: async (request, stage = 'compiler', retry = 0) => {
          if (config.origin !== 'live') throw new Error('OFFLINE_PROVIDER_FORBIDDEN');
          if (!Number.isSafeInteger(retry) || retry < 0) throw new Error('INVALID_RETRY');
          const call = { prompt: request.user, request };
          const record: CallRecord = { index: pair.calls.length, phase, retry, stage, status: 'blocked',
            latencyMs: null, usage: null, usd: 0, reservedUsd: 0, settledUsd: null, priceMethod: 'not-called', input: request, output: null, error: null };
          pair.calls.push(record);
          if (subscription) {
            if (run.stopReason || callCount >= config.maxCalls || phaseCalls >= protocol.maxCallsPerPhase || now() - start >= config.maxWallMs) {
              record.error = run.stopReason ?? 'RUN_LIMIT'; run.stopReason = record.error;
              save({ event: 'call-end', pair: pair.index, record }); throw new Error(record.error);
            }
            record.status = 'started'; record.usd = null; record.priceMethod = 'subscription-no-unit-tariff';
            save({ event: 'call-start', pair: pair.index, record });
            callCount++; phaseCalls++;
            const at = now();
            try {
              const outcome = await deps.subscription!(request);
              record.usage = validUsage(outcome.usage) ? outcome.usage : null;
              record.output = outcome.body; record.status = 'ok';
              if (!record.usage) run.stopReason = 'UNKNOWN_USAGE';
            } catch {
              record.status = 'failed'; record.error = 'SUBSCRIPTION_STOPPED'; run.stopReason = record.error;
            }
            record.latencyMs = now() - at; recordStage(stage, record.latencyMs);
            save({ event: 'call-end', pair: pair.index, record });
            if (record.status !== 'ok') throw new Error(record.error!);
            return record.output;
          }
          const worst = deps.branch!.worstCaseUsd(call);
          if (run.stopReason || callCount >= config.maxCalls || phaseCalls >= protocol.maxCallsPerPhase ||
            now() - start >= config.maxWallMs || !finitePositive(worst) || charged + worst > config.spendLimitUsd!) {
            record.error = run.stopReason ?? 'RUN_LIMIT'; run.stopReason = record.error;
            save({ event: 'call-end', pair: pair.index, record }); throw new Error('RUN_LIMIT');
          }
          const reservation = await deps.cap!.reserve(worst);
          if (!reservation.ok) {
            record.error = 'SPEND_CAP_BLOCKED'; run.stopReason = record.error;
            save({ event: 'call-end', pair: pair.index, record }); throw new Error(record.error);
          }
          record.reservedUsd = worst; record.status = 'started'; record.usd = null; record.priceMethod = 'UNKNOWN';
          // Zápis před sítí. Pád později zanechá UNKNOWN, nikdy nulovou cenu.
          try { save({ event: 'call-start', pair: pair.index, record }); }
          catch (e) { await reservation.settle(0); throw e; }
          charged += worst; callCount++; phaseCalls++;
          const at = now();
          let body: unknown;
          try {
            const outcome = await deps.branch!.generate(call);
            record.usage = validUsage(outcome.usage) ? outcome.usage : null;
            const amount = record.usage ? costUsd(record.usage, deps.branch!.pricing) : null;
            record.usd = amount !== null && Number.isFinite(amount) && amount >= 0 ? amount : null;
            record.priceMethod = record.usd === null ? 'UNKNOWN' : 'usage-times-configured-tariff';
            record.status = outcome.ok ? 'ok' : 'failed';
            record.error = outcome.ok ? null : outcome.reason;
            record.output = outcome.ok ? outcome.body : null;
            body = outcome.ok ? outcome.body : undefined;
          } catch { record.status = 'failed'; record.error = 'PROVIDER_EXCEPTION'; }
          record.latencyMs = now() - at;
          recordStage(stage, record.latencyMs);
          try { record.settledUsd = await reservation.settle(record.usd ?? 'unknown'); }
          catch { run.stopReason = 'SETTLEMENT_FAILED'; record.error = 'SETTLEMENT_FAILED'; record.status = 'failed'; }
          charged += (record.usd ?? worst) - worst;
          if (record.usd === null) run.stopReason ??= 'UNKNOWN_USAGE';
          if (record.usd !== null && record.usd > worst) run.stopReason ??= 'RESERVATION_OVERRUN';
          if (charged > config.spendLimitUsd!) run.stopReason ??= 'SPEND_OVERRUN';
          save({ event: 'call-end', pair: pair.index, record });
          if (record.status !== 'ok') throw new Error(record.error!);
          return body;
        },
      };
      try {
        const out = await deps.adapter!.execute(structuredClone(input), phase, created, context);
        const endpointMeasured = config.origin !== 'live' ||
          (result.stages[phase === 'edit' ? 'comparison' : 'firstInteraction']?.length ?? 0) > 0;
        const liveCall = config.origin !== 'live' || pair.calls.some((c) => c.phase === phase && c.status === 'ok') ||
          (phase === 'edit' && out.execution === 'deterministic' && !pair.calls.some((c) => c.phase === phase && c.status !== 'blocked'));
        result.execution = out.execution ?? (config.origin === 'live' ? 'inference' : 'replay');
        result.status = out.completed && endpointMeasured && liveCall ? 'success' : 'failed';
        result.error = out.completed && !endpointMeasured ? 'ENDPOINT_NOT_MEASURED' :
          out.completed && !liveCall ? 'LIVE_CALL_NOT_OBSERVED' : out.completed ? null : out.error ?? 'NOT_COMPLETED';
        if (phase === 'edit') edited = out.artifact; else created = out.artifact;
        if (out.timing && Number.isFinite(out.timing.wallMs) && out.timing.wallMs >= 0 &&
          Number.isFinite(out.timing.humanWaitMs) && out.timing.humanWaitMs >= 0 && out.timing.humanWaitMs <= out.timing.wallMs) {
          result.wallMs = out.timing.wallMs;
          result.machineMs = out.timing.wallMs - out.timing.humanWaitMs;
        }
        save({ event: 'product-result', index: pair.index, phase, result: out });
      } catch { result.error = run.stopReason ?? 'ADAPTER_EXCEPTION'; }
      if (journalFailed) throw new Error('JOURNAL_FAILED');
      result.wallMs ??= now() - phaseStart;
      result.machineMs ??= Math.max(0, result.wallMs - (result.stages.humanWait ?? []).reduce((a, b) => a + b, 0));
      save({ event: 'phase-end', index: pair.index, phase, result });
    }
    if (deps.adapter && phases.some((p) => pair.phases[p]?.status !== 'NOT_RUN')) {
      try { pair.checks = await deps.adapter.evaluate(structuredClone(input), created, edited); }
      catch { save({ event: 'oracle-error', index: pair.index, error: 'ORACLE_EXCEPTION' }); }
    }
    save({ event: 'pair-end', pair });
  }
  save({ event: 'run-end', run });
  return deps.redact(run) as Run;
}

export function nearestRank(values: number[], p: number): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * values.length) - 1)]!;
}
export function buildReport(run: Run) {
  const pairs = run.pairs;
  const cold = run.config.origin === 'live' && run.suiteStatus === 'holdout';
  const source = pairs.filter((p) => p.input.kind !== 'prompt');
  const completed = source.filter((p) => p.phases.create?.status === 'success' &&
    p.phases.edit?.status === 'success' && p.checks?.branchDelta === true).length;
  const calls = pairs.flatMap((p) => p.calls).filter((c) => c.status !== 'blocked');
  const unknownCosts = calls.filter((c) => c.usd === null).length;
  const knownUsd = calls.reduce((sum, c) => sum + (c.usd ?? 0), 0);
  const totalUsd = unknownCosts ? null : knownUsd;
  const pairCosts = source.map((p) => p.calls.some((c) => c.usd === null) ? null : p.calls.reduce((sum, c) => sum + (c.usd ?? 0), 0));
  const attempted = source.filter((p) => p.phases.create?.status !== 'NOT_RUN').length;
  const allSource = cold && source.length === 30 && source.every((p) => p.phases.create?.status !== 'NOT_RUN' && p.phases.edit?.status !== 'NOT_RUN');
  const gates: Record<string, Gate> = {};
  const gate = (available: boolean, pass: boolean): Gate => available ? pass ? 'PASS' : 'FAIL' : 'NOT_RUN';
  for (const key of ['invariants', 'criticalSupported', 'criticalCitations', 'rejectedUnchanged', 'visualUsable'] as const) {
    const observations = source.map((p) => p.checks?.[key]);
    gates[key] = cold && observations.includes(false) ? 'FAIL' : gate(allSource && observations.every((v) => v === true), true);
  }
  const problematic = source.filter((p) => p.input.kind === 'missing' || p.input.kind === 'conflict');
  gates.problematicBlocked = cold && problematic.some((p) => p.checks?.problematicBlocked === false) ? 'FAIL' :
    gate(cold && problematic.length === 15 && problematic.every((p) => p.checks?.problematicBlocked === true), true);
  gates.completion = gate(cold && source.length === 30 && attempted === 30, completed >= protocol.thresholds.completedPairs);
  const counts = source.reduce((n, p) => ({ tp: n.tp + (p.checks?.rules?.tp ?? 0),
    fp: n.fp + (p.checks?.rules?.fp ?? 0), fn: n.fn + (p.checks?.rules?.fn ?? 0) }), { tp: 0, fp: 0, fn: 0 });
  const precision = counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : null;
  const recall = counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : null;
  gates.rules = gate(allSource && source.every((p) => p.checks?.rules != null) && precision !== null && recall !== null,
    precision! >= protocol.thresholds.precision && recall! >= protocol.thresholds.recall);
  const latency = Object.fromEntries((['create', 'edit', 'prompt'] as const).map((phase) => {
    const results = pairs.flatMap((p) => p.phases[phase] ? [p.phases[phase]!] : []);
    const successes = results.filter((r) => r.status === 'success' && r.machineMs !== null);
    const values = successes.map((r) => r.machineMs!);
    const median = values.length ? (nearestRank(values, 0.5)! + [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)]!) / 2 : null;
    const p95 = nearestRank(values, 0.95);
    const available = cold && results.length === 30 && results.every((r) => r.status !== 'NOT_RUN') && p95 !== null;
    gates[`${phase}Latency`] = gate(available, phase === 'create'
      ? median! <= protocol.thresholds.sourceMedianMs && p95! <= protocol.thresholds.sourceP95Ms
      : p95! <= (phase === 'edit' ? protocol.thresholds.editP95Ms : protocol.thresholds.promptP95Ms));
    return [phase, { planned: results.length, successes: values.length, failures: results.filter((r) => r.status === 'failed').length,
      notRun: results.filter((r) => r.status === 'NOT_RUN').length, timeouts: results.filter((r) => r.error === 'TIMEOUT').length, medianMs: median, p95Ms: p95 }];
  }));
  const meanPairUsd = totalUsd !== null && attempted ? pairCosts.reduce<number>((s, c) => s + (c ?? 0), 0) / attempted : null;
  gates.cost = gate(run.config.billing !== 'subscription' && allSource && meanPairUsd !== null, meanPairUsd! <= protocol.thresholds.meanPairUsd);
  gates.usersComplete = 'NOT_RUN'; gates.usersSpatialHelp = 'NOT_RUN';
  return { origin: run.config.origin, suiteStatus: run.suiteStatus, gates, completion: { completed, planned: source.length, attempted },
    precision, recall, latency, cost: { billing: run.config.billing ?? 'api', knownUsd, totalUsd, unknownCosts, meanPairUsd,
      usage: { inputTokens: calls.reduce((s, c) => s + (c.usage?.inputTokens ?? 0), 0),
        outputTokens: calls.reduce((s, c) => s + (c.usage?.outputTokens ?? 0), 0), unknownCalls: calls.filter(c => !c.usage).length },
      maxPairUsd: unknownCosts || !attempted ? null : Math.max(...pairCosts as number[]),
      usdPerCompletedPair: completed && totalUsd !== null ? totalUsd / completed : null,
      meanCallUsd: calls.length && totalUsd !== null ? totalUsd / calls.length : null,
      calls: calls.length, retries: calls.filter((c) => c.retry > 0).length },
    limitation: 'Small screening sample. Successful-run latency is conditional on completion. Offline/cache/prepared results never certify cold gates.' };
}
export function renderReport(run: Run, userGates?: { usersComplete: Gate; usersSpatialHelp: Gate }): string {
  const report = buildReport(run);
  if (userGates) Object.assign(report.gates, userGates);
  return `# Reality Compiler — benchmark T10\n\nPůvod: ${report.origin}; sada: ${report.suiteStatus}.\n\n` +
    `Cold a uživatelské brány bez skutečného důkazu zůstávají NOT_RUN. Neznámá cena je UNKNOWN; rezervace není účtenka.\n\n` +
    `| Brána | Stav |\n|---|---|\n${Object.entries(report.gates).map(([k,v]) => `| ${k} | ${v} |`).join('\n')}\n\n` +
    `Výsledky včetně jmenovatelů, timeoutů a podmíněných percentilů (nearest-rank, malý vzorek):\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}
