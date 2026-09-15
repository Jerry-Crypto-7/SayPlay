import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createBrowserAdapter } from '../scripts/reality-compiler-browser';
import { buildReport, digest, runBenchmark, type Suite } from '../scripts/measure-reality-compiler';
import { judgeBrowser, type CaseOracle } from '../scripts/reality-compiler-evaluation';
import sim from '../evals/reality-compiler/museum.sim.json';

test('browser runner measures the real source UI, clarification, rejected commit and both outcomes with fixture inference', async ({ browser, baseURL }) => {
  test.setTimeout(420_000);
  const text = readFileSync('evals/reality-compiler/museum-source.txt', 'utf8');
  const suite: Suite = { status: 'development', oracleSha256: 'b'.repeat(64), cases: [{ id: 'museum-development',
    kind: 'missing', source: text, intervention: 'Shorten the window to ten seconds.', clarification: 'The timer lasts 20 seconds.' }] };
  let fixtureCalls = 0;
  const oracle: CaseOracle = { actor: 'visitor', startTarget: 'sensorA', finishTarget: 'sensorB', lockedTarget: 'case',
    failureFlag: 'alarm', timerId: 'countdown', originalDurationTicks: 400, changedDurationTicks: 200,
    atomicRequirements: [], requiredClarification: 'Duration', expectedPairedOutcome: {
      original: { locked: false, failed: false }, changed: { locked: true, failed: true } } };
  const adapter = createBrowserAdapter({ browser, baseURL: baseURL!, timeoutMs: 30_000,
    artifactDirectory: 'scratch/reality-compiler-browser-adapter',
    tasks: { 'museum-development': { actor: 'visitor', startTarget: 'sensorA', finishTarget: 'sensorB', approachTarget: 'approachB',
      timerId: 'countdown', actionId: 'activate', waitTicks: 260, newDurationTicks: 200 } },
    fixture: async request => {
      fixtureCalls++;
      const source = JSON.parse(request.user) as { sourceId: string; text: string };
      const claims = [{ claimId: 'fixture_claim', text: 'Scripted structural fixture, not semantic review.', support: 'sourced',
        interventionId: null, review: { status: 'unchecked' }, spans: [{ sourceId: source.sourceId,
          startByte: 0, endByte: Buffer.byteLength(source.text), excerpt: source.text }] }];
      if (!source.text.includes('Clarification:')) return { missingCritical: ['How long does the timer run?'],
        conflicts: [], unsupported: [], sim: null, claims, bindings: [] };
      return { missingCritical: [], conflicts: [], unsupported: [], sim,
        claims,
        bindings: Object.keys(sim.rules).map(id => ({ bindingId: `b.${id}`, target: { kind: 'rule', id }, claimIds: ['fixture_claim'] })) };
    },
    evaluate: async (_input, created, edited) => judgeBrowser(oracle, created, edited),
  });
  const events: unknown[] = [];
  try {
    const run = await runBenchmark(suite, { runId: 'browser-fixture-test', commit: 'working-tree', dirty: true,
      model: 'fixture', modelConfig: {}, origin: 'offline', suiteSha256: digest(suite), authorized: false,
      spendLimitUsd: null, maxCalls: 1, maxWallMs: 360_000 }, { adapter, journal: event => events.push(structuredClone(event)), redact: x => x });
    writeFileSync('scratch/reality-compiler-browser-adapter/events.json', JSON.stringify(events, null, 2));
    expect(run.pairs.map(p => p.phases), JSON.stringify(events.filter((e: any) => e.event === 'product-result'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ create: expect.objectContaining({ status: 'success' }), edit: expect.objectContaining({ status: 'success', execution: 'deterministic' }) }),
    ]));
    expect(run.pairs.every(p => p.phases.create?.status === 'success' && p.phases.edit?.status === 'success'), JSON.stringify(run.pairs)).toBe(true);
    expect(fixtureCalls).toBe(6);
    expect(run.pairs.every(p => p.checks?.invariants && p.checks?.branchDelta && p.checks?.rejectedUnchanged), JSON.stringify(run.pairs.map(p => p.checks))).toBe(true);
    expect(buildReport(run).cost.calls).toBe(0);
    expect(Object.values(buildReport(run).gates).every(g => g === 'NOT_RUN')).toBe(true);
    expect(events.filter((e: any) => e.event === 'product-result')).toHaveLength(6);
    for (const event of events.filter((e: any) => e.event === 'product-result') as { result: { timing?: { wallMs: number } } }[])
      expect(event.result.timing?.wallMs).toBeGreaterThan(0);
  } finally { await adapter.dispose(); }
});
