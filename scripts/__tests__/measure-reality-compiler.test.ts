import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, configuredTransport, digest, fileJournal, nearestRank, runBenchmark, validateSuite,
  type Adapter, type Checks, type Dependencies, type RunConfig, type Suite } from '../measure-reality-compiler';
import type { GenerationBranch } from '../../src/server/pipeline';
import type { UpstreamRequest } from '../../src/model/prompt';
import * as upstream from '../../src/server/upstream';

const request = { model: 'test', system: 'system', user: 'input' } as UpstreamRequest;
function suite(): Suite {
  return { status: 'holdout', oracleSha256: 'a'.repeat(64), cases: Array.from({ length: 10 }, (_, i) => ({
    id: `case-${i}`, kind: i < 5 ? 'complete' : i < 8 ? 'missing' : 'conflict',
    source: `Independent source ${i}`, intervention: 'Change the time limit.', clarification: i < 5 ? null : '20 seconds.',
  })) };
}
function setup() {
  const input = suite();
  const config: RunConfig = { runId: 'test', commit: 'test-commit', dirty: true, model: 'test', modelConfig: {},
    origin: 'live', suiteSha256: digest(input), authorized: true, spendLimitUsd: 10, maxCalls: 200, maxWallMs: 1e6 };
  const checks: Checks = { invariants: true, criticalSupported: true, criticalCitations: true,
    otherCitations: { passed: 1, total: 1 }, rejectedUnchanged: true, problematicBlocked: true,
    branchDelta: true, rules: { tp: 20, fp: 0, fn: 0 }, visualUsable: true };
  let clock = 0;
  const settle = vi.fn(async () => 0);
  const branch: GenerationBranch = { id: 'test', pricing: { usdPerMTokIn: 1, usdPerMTokOut: 1 },
    worstCaseUsd: () => 0.1, generate: vi.fn(async () => {
      clock += 10;
      return { ok: true as const, body: { generated: true }, usage: { inputTokens: 1000, outputTokens: 1000 }, provenance: {} };
    }) };
  const adapter: Adapter = { execute: vi.fn(async (_input, _phase, _previous, ctx) => {
    const artifact = await ctx.emit(request);
    await ctx.stage('validation', async () => { clock += 2; });
    await ctx.stage(_phase === 'edit' ? 'comparison' : 'firstInteraction', async () => { clock += 3; });
    return { completed: true, artifact };
  }), evaluate: vi.fn(async () => structuredClone(checks)) };
  const events: unknown[] = [];
  const deps: Dependencies = { branch, cap: { reserve: vi.fn(async () => ({ ok: true as const, reservedUsd: 0.1, settle })) } as Dependencies['cap'],
    adapter, now: () => clock, journal: (event) => events.push(structuredClone(event)), redact: (x) => x };
  return { input, config, deps, checks, events, branch, adapter, settle, advance: (n: number) => { clock += n; } };
}

describe('T10 benchmark accounting and denominators (synthetic transport only)', () => {
  it('accounts subscription usage without an API reservation or invented USD tariff', async () => {
    const s = setup(); s.config.billing = 'subscription'; s.config.spendLimitUsd = null;
    s.deps.subscription = vi.fn(async () => ({ body: {}, usage: { inputTokens: 10, outputTokens: 5 } }));
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(s.deps.subscription).toHaveBeenCalledTimes(60);
    expect(s.branch.generate).not.toHaveBeenCalled(); expect(s.deps.cap!.reserve).not.toHaveBeenCalled();
    const report = buildReport(run);
    expect(report.completion.completed).toBe(30); expect(report.gates.cost).toBe('NOT_RUN');
    expect(report.cost.totalUsd).toBeNull(); expect(report.cost.usage).toEqual({ inputTokens: 600, outputTokens: 300, unknownCalls: 0 });
    expect(run.pairs[0].calls[0].priceMethod).toBe('subscription-no-unit-tariff');
  });
  it('stops subscription inference on unknown usage or failure, retaining all planned pairs', async () => {
    for (const failed of [false, true]) {
      const s = setup(); s.config.billing = 'subscription'; s.config.spendLimitUsd = null;
      s.deps.subscription = vi.fn(async () => { if (failed) throw new Error('limit'); return { body: {}, usage: null }; });
      const run = await runBenchmark(s.input, s.config, s.deps);
      expect(s.deps.subscription).toHaveBeenCalledTimes(1); expect(s.branch.generate).not.toHaveBeenCalled();
      expect(run.pairs).toHaveLength(30); expect(run.pairs[1].phases.create?.status).toBe('NOT_RUN');
      expect(run.stopReason).toBe(failed ? 'SUBSCRIPTION_STOPPED' : 'UNKNOWN_USAGE');
    }
  });
  it('requires subscription authority and observes the call cap without API fallback', async () => {
    for (const authorized of [false, true]) {
      const s = setup(); Object.assign(s.config, { billing: 'subscription', authorized, maxCalls: 1 });
      s.deps.subscription = vi.fn(async () => ({ body: {}, usage: { inputTokens: 10, outputTokens: 5 } }));
      const run = await runBenchmark(s.input, s.config, s.deps);
      expect(s.deps.subscription).toHaveBeenCalledTimes(authorized ? 1 : 0);
      expect(s.branch.generate).not.toHaveBeenCalled(); expect(run.pairs).toHaveLength(30);
    }
  });
  afterEach(() => vi.restoreAllMocks());
  it('plans exactly 30 independent pairs, keeps all calls and stage times', async () => {
    const s = setup(); const run = await runBenchmark(s.input, s.config, s.deps); const report = buildReport(run);
    expect(run.pairs).toHaveLength(30); expect(s.branch.generate).toHaveBeenCalledTimes(60);
    expect(report.completion).toEqual({ completed: 30, planned: 30, attempted: 30 });
    expect(report.cost.totalUsd).toBeCloseTo(0.12); expect(report.gates.completion).toBe('PASS');
    expect(report.gates.usersComplete).toBe('NOT_RUN'); expect(report.gates.promptLatency).toBe('NOT_RUN');
    expect(run.pairs[0].phases.create?.stages).toEqual({ compiler: [10], validation: [2], firstInteraction: [3] });
    expect(run.pairs[0].calls[0].latencyMs).toBe(10);
    expect(s.events.some((e: any) => e.event === 'call-start' && e.record.usd === null)).toBe(true);
  });
  it.each(['unauthorized', 'no limit', 'NaN limit', 'no cap', 'no provider', 'no adapter'])(
    'does not spend when %s and retains every planned phase', async (reason) => {
      const s = setup();
      if (reason === 'unauthorized') s.config.authorized = false;
      if (reason === 'no limit') s.config.spendLimitUsd = null;
      if (reason === 'NaN limit') s.config.spendLimitUsd = NaN;
      if (reason === 'no cap') delete s.deps.cap;
      if (reason === 'no provider') delete s.deps.branch;
      if (reason === 'no adapter') delete s.deps.adapter;
      const run = await runBenchmark(s.input, s.config, s.deps);
      expect(s.branch.generate).not.toHaveBeenCalled(); expect(run.pairs).toHaveLength(30);
      expect(run.pairs.every((p) => p.phases.create?.status === 'NOT_RUN' && p.phases.edit?.status === 'NOT_RUN')).toBe(true);
      expect(Object.values(buildReport(run).gates).every((v) => v === 'NOT_RUN')).toBe(true);
    });
  it.each(['offline', 'cache', 'prepared'] as const)('%s cannot call provider or pass cold gates', async (origin) => {
    const s = setup(); s.config.origin = origin;
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(s.branch.generate).not.toHaveBeenCalled();
    expect(Object.values(buildReport(run).gates).every((v) => v === 'NOT_RUN')).toBe(true);
  });
  it('records a paid failure and retry without inflating the pair denominator', async () => {
    const s = setup(); let first = true;
    s.adapter.execute = async (_i, _p, _prev, ctx) => {
      const retry = first ? 1 : 0;
      if (first) { first = false; try { await ctx.emit(request, 'compiler'); } catch {} }
      const artifact = await ctx.emit(request, 'repair', retry);
      await ctx.stage(_p === 'edit' ? 'comparison' : 'firstInteraction', async () => {});
      return { completed: true, artifact };
    };
    vi.mocked(s.branch.generate).mockResolvedValueOnce({ ok: false, reason: 'MALFORMED_RESPONSE', detail: 'private endpoint', usage: { inputTokens: 2000, outputTokens: 1000 } });
    const run = await runBenchmark(s.input, s.config, s.deps); const report = buildReport(run);
    expect(report.cost.calls).toBe(61); expect(report.cost.retries).toBe(1);
    expect(report.cost.totalUsd).toBeCloseTo(0.123); expect(report.completion.planned).toBe(30);
    expect(JSON.stringify(run)).not.toContain('private endpoint');
    expect(run.pairs[0].calls[0].status).toBe('failed');
  });
  it.each(['missing usage', 'exception'])( '%s remains UNKNOWN, settles worst case and stops new spending', async (reason) => {
    const s = setup();
    if (reason === 'exception') vi.mocked(s.branch.generate).mockRejectedValueOnce(new Error('secret'));
    else vi.mocked(s.branch.generate).mockResolvedValueOnce({ ok: true, body: {}, usage: null, provenance: {} });
    const run = await runBenchmark(s.input, s.config, s.deps); const report = buildReport(run);
    expect(s.branch.generate).toHaveBeenCalledTimes(1); expect(s.settle).toHaveBeenCalledWith('unknown');
    expect(report.cost.totalUsd).toBeNull(); expect(report.cost.unknownCosts).toBe(1);
    expect(report.gates.cost).toBe('NOT_RUN'); expect(JSON.stringify(run)).not.toContain('secret');
  });
  it('preserves timeouts and edit skips, fails completion instead of reporting only successes', async () => {
    const s = setup(); let n = 0;
    s.adapter.execute = async (_i, phase, _p, ctx) => {
      await ctx.emit(request);
      await ctx.stage(phase === 'edit' ? 'comparison' : 'firstInteraction', async () => {});
      return { completed: ++n > 4, artifact: {}, error: 'TIMEOUT' };
    };
    const run = await runBenchmark(s.input, s.config, s.deps); const report = buildReport(run);
    expect(report.completion.completed).toBe(26); expect(report.gates.completion).toBe('FAIL');
    expect(report.latency.create.timeouts).toBe(4); expect(report.latency.edit.notRun).toBe(4);
  });
  it('one corrupt accepted run fails even if later work is NOT_RUN', async () => {
    const s = setup(); s.checks.invariants = false; s.config.maxCalls = 1;
    const report = buildReport(await runBenchmark(s.input, s.config, s.deps));
    expect(report.gates.invariants).toBe('FAIL'); expect(s.branch.generate).toHaveBeenCalledTimes(1);
  });
  it('all-rejected cannot pass completion or rule precision', async () => {
    const s = setup(); s.adapter.execute = async () => ({ completed: false, artifact: null, error: 'REJECTED' });
    s.checks.rules = { tp: 0, fp: 0, fn: 20 };
    const report = buildReport(await runBenchmark(s.input, s.config, s.deps));
    expect(report.gates.completion).toBe('FAIL'); expect(report.gates.rules).not.toBe('PASS');
    expect(report.cost.usdPerCompletedPair).toBeNull();
  });
  it('enforces run dollar budget before reservation and keeps unrun rows', async () => {
    const s = setup(); s.config.spendLimitUsd = 0.101;
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(s.branch.generate).toHaveBeenCalledTimes(1); expect(run.stopReason).toBe('RUN_LIMIT');
    expect(run.pairs).toHaveLength(30);
  });
  it('settlement failure blocks subsequent calls', async () => {
    const s = setup(); s.settle.mockRejectedValueOnce(new Error('store down'));
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(run.stopReason).toBe('SETTLEMENT_FAILED'); expect(s.branch.generate).toHaveBeenCalledTimes(1);
  });
  it('caps even an adapter that catches every retry failure', async () => {
    const s = setup();
    s.adapter.execute = async (_i, _p, _prev, ctx) => {
      for (let i = 0; i < 10; i++) { try { await ctx.emit(request); } catch {} }
      return { completed: false, artifact: null };
    };
    await runBenchmark(s.input, s.config, s.deps);
    expect(s.branch.generate).toHaveBeenCalledTimes(4);
  });
  it('separates recorded human wait from machine time', async () => {
    const s = setup(); s.adapter.execute = async (_i, _p, _prev, ctx) => {
      await ctx.stage('humanWait', async () => s.advance(1000)); s.advance(20);
      return { completed: true, artifact: {} };
    };
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(run.pairs[0].phases.create).toMatchObject({ wallMs: 1020, machineMs: 20 });
  });
  it('does not start another call after a journal failure', async () => {
    const s = setup(); s.deps.journal = (event: any) => { if (event.event === 'call-start') throw new Error('disk full'); };
    await expect(runBenchmark(s.input, s.config, s.deps)).rejects.toThrow('JOURNAL_FAILED');
    expect(s.branch.generate).not.toHaveBeenCalled(); expect(s.settle).toHaveBeenCalledWith(0);
  });
  it('validates the frozen bytes and independently required oracle before any call', async () => {
    const s = setup(); s.input.cases[0].source += '!';
    await expect(runBenchmark(s.input, s.config, s.deps)).rejects.toThrow('SUITE_HASH_MISMATCH');
    expect(s.branch.generate).not.toHaveBeenCalled();
    s.input.oracleSha256 = ''; expect(() => validateSuite(s.input, digest(s.input))).toThrow('ORACLE_HASH_REQUIRED');
  });
  it('rejects duplicate identities, bad distribution and missing clarification', () => {
    const s = suite(); s.cases[1].id = s.cases[0].id;
    expect(() => validateSuite(s, digest(s))).toThrow('DUPLICATE_CASE');
    const d = suite(); d.cases[0].kind = 'conflict'; d.cases[0].clarification = 'reply';
    expect(() => validateSuite(d, digest(d))).toThrow('INVALID_DISTRIBUTION');
    const c = suite(); c.cases[9].clarification = null;
    expect(() => validateSuite(c, digest(c))).toThrow('INVALID_CASE');
  });
  it('nearest-rank p95 of 30 is observation 29, not interpolated or maximum', () => {
    expect(nearestRank(Array.from({ length: 30 }, (_, i) => i + 1), 0.95)).toBe(29);
    expect(nearestRank([], 0.95)).toBeNull();
  });
  it('model response without a measured interaction/compare endpoint is not completion', async () => {
    const s = setup(); s.adapter.execute = async () => ({ completed: true, artifact: {} });
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(run.pairs[0].phases.create?.error).toBe('ENDPOINT_NOT_MEASURED');
    expect(buildReport(run).gates.completion).toBe('FAIL');
  });
  it('permits explicitly deterministic edits with no provider cost after live create', async () => {
    const s = setup(); const create = s.adapter.execute;
    s.adapter.execute = async (input, phase, previous, ctx) => {
      if (phase !== 'edit') return create(input, phase, previous, ctx);
      ctx.notUsed('compiler');
      await ctx.stage('comparison', async () => s.advance(4));
      return { completed: true, artifact: {}, execution: 'deterministic' };
    };
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(s.branch.generate).toHaveBeenCalledTimes(30);
    expect(buildReport(run).completion.completed).toBe(30);
    expect(run.pairs[0].phases.edit?.stageStatus?.compiler).toBe('not-used');
  });
  it('preparation and screenshots cannot inflate the browser confirmation-to-end latency', async () => {
    const s = setup(); s.adapter.prepare = async () => { s.advance(20000); };
    const execute = s.adapter.execute;
    s.adapter.execute = async (...args) => ({ ...await execute(...args), timing: { wallMs: 50, humanWaitMs: 10 } });
    s.config.maxWallMs = 2_000_000;
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(run.pairs[0].phases.create).toMatchObject({ wallMs: 50, machineMs: 40 });
  });
  it('zero-token usage is UNKNOWN, matching the production provider receipt contract', async () => {
    const s = setup(); vi.mocked(s.branch.generate).mockResolvedValueOnce({ ok: true, body: {},
      usage: { inputTokens: 0, outputTokens: 0 }, provenance: {} });
    const report = buildReport(await runBenchmark(s.input, s.config, s.deps));
    expect(report.cost.totalUsd).toBeNull(); expect(s.settle).toHaveBeenCalledWith('unknown');
  });
  it('ordinary planner + compiler calls are not labeled retries', async () => {
    const s = setup(); s.config.maxCalls = 2;
    s.adapter.execute = async (_i, _p, _prev, ctx) => {
      await ctx.emit(request, 'planner'); await ctx.emit(request, 'compiler');
      return { completed: false, artifact: null };
    };
    const report = buildReport(await runBenchmark(s.input, s.config, s.deps));
    expect(report.cost.calls).toBe(2); expect(report.cost.retries).toBe(0);
  });
  it('a prepared result cannot pass as live merely by reporting a frame', async () => {
    const s = setup(); s.adapter.execute = async (_i, phase, _p, ctx) => {
      await ctx.stage(phase === 'edit' ? 'comparison' : 'firstInteraction', async () => {});
      return { completed: true, artifact: {} };
    };
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(run.pairs[0].phases.create?.error).toBe('LIVE_CALL_NOT_OBSERVED');
    expect(buildReport(run).gates.completion).toBe('FAIL');
  });
  it('an underestimated reservation keeps the full price and stops further spending', async () => {
    const s = setup(); vi.mocked(s.branch.generate).mockResolvedValueOnce({ ok: true, body: {},
      usage: { inputTokens: 200000, outputTokens: 0 }, provenance: {} });
    const run = await runBenchmark(s.input, s.config, s.deps);
    expect(run.stopReason).toBe('RESERVATION_OVERRUN'); expect(s.branch.generate).toHaveBeenCalledTimes(1);
    expect(buildReport(run).cost.totalUsd).toBe(0.2);
    expect(run.pairs[0].calls[0].reservedUsd).toBe(0.1);
  });
  it('never discovers provider configuration without authorization and explicit budget', () => {
    const spy = vi.spyOn(upstream, 'upstreamConfigFromEnv'); const s = setup();
    s.config.authorized = false; expect(configuredTransport(s.config).branch).toBeUndefined();
    s.config.authorized = true; s.config.spendLimitUsd = null;
    expect(configuredTransport(s.config).branch).toBeUndefined(); expect(spy).not.toHaveBeenCalled();
  });
  it('redacts provider secrets in nested inputs/outputs and rejects configuration drift', () => {
    const s = setup();
    const value: upstream.UpstreamConfig = { endpoint: 'https://private.invalid/model', apiKey: 'fake-test-key',
      model: 'test', effort: 'low', maxOutputTokens: 100, timeoutMs: 1000,
      pricing: { usdPerMTokIn: 1, usdPerMTokOut: 2 }, profile: 'api', callCap: null };
    vi.spyOn(upstream, 'upstreamConfigFromEnv').mockReturnValue(value);
    expect(() => configuredTransport(s.config)).toThrow('MODEL_CONFIG_MISMATCH');
    s.config.modelConfig = { effort: 'low', maxOutputTokens: 100, timeoutMs: 1000, usdPerMTokIn: 1, usdPerMTokOut: 2 };
    const transport = configuredTransport(s.config);
    expect(transport.branch).toBeDefined();
    expect(transport.redact({ output: [value.apiKey, `Error: ${value.endpoint}`] })).toEqual({ output: ['[REDACTED]', 'Error: [REDACTED]'] });
  });
  it('creates an append-only exclusive journal and refuses overwriting an earlier run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-benchmark-'));
    try { const path = join(dir, 'run.jsonl'); const journal = fileJournal(path);
      journal({ event: 'start' }); journal({ event: 'end' });
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
      expect(() => fileJournal(path)).toThrow();
    } finally { rmSync(dir, { recursive: true }); }
  });
});
