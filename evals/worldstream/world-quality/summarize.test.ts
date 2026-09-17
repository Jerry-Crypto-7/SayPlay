import { expect, it } from 'vitest';
import type { CaseOutcome } from '../measure-create';
import { summarizeQualityRun, summarizeQualityStages, summarizeQualityRepairs } from './summarize';

const outcome = (id: string, latencyMs: number, passed: boolean) => ({ id, latencyMs,
  blueprintValid: passed, worldValid: passed, certified: passed, geometryAuthored: passed,
  failure: passed ? null : { stage: 'unavailable', detail: 'transport unavailable' },
}) as CaseOutcome;

it('separates repaired outcomes, retry inputs and terminal failures without counting pending calls', () => {
  const call = { call: 1, stage: 'compiler', repair: false, ms: 10 };
  const calls = [
    { ...call, caseId: 't1' },
    { ...call, caseId: 't2', repair: true, reason: 'schema before retry' },
    { ...call, caseId: 't3', repair: true, reason: 'witness before retry' },
    { ...call, caseId: 'pending', repair: true },
  ];
  const report = summarizeQualityRepairs([
    outcome('t1', 100, true), outcome('t2', 100, true),
    outcome('t3', 100, false), outcome('t4', 100, false),
  ], calls);
  expect(report.counts).toEqual({ 'certified-without-repair': 1, 'certified-after-repair': 1,
    'rejected-after-repair': 1, 'rejected-without-repair': 0, unobserved: 1 });
  expect(report.repairTime).toEqual({ n: 2, medianMs: 10, p95Ms: 10 });
  expect(report.byCase[2]).toMatchObject({ repairInputs: [{ call: 1, reason: 'witness before retry' }],
    terminalFailure: { stage: 'unavailable', detail: 'transport unavailable' } });
  expect(report.byCase[3]).toMatchObject({ repairCalls: null, repairMs: null });
  expect(calls).toHaveLength(4);
});

it('keeps missing and failed cases in the denominator and does not call missing data fast', () => {
  const result = summarizeQualityRun(['t1', 't2', 't3'], [outcome('t1', 100, true), outcome('t2', 300, false)]);
  expect(result).toMatchObject({ status: 'incomplete', expected: 3, completed: 2, pending: ['t3'],
    certifiedProxyWorlds: 1, failures: { unavailable: ['t2'] },
    latencyAllCompleted: { n: 2, medianMs: 200, p95Ms: 300 },
    latencyCertifiedProxyWorlds: { n: 1, medianMs: 100, p95Ms: 100 } });
  expect(summarizeQualityRun(['t1'], []).latencyAllCompleted).toEqual({ n: 0, medianMs: null, p95Ms: null });
});

it('separates model stages, repairs and residual processing without counting unfinished cases', () => {
  const report = summarizeQualityStages([outcome('t1', 100, true), outcome('t2', 200, false)], [
    { caseId: 't1', call: 1, stage: 'planner', repair: false, ms: 10 },
    { caseId: 't1', call: 2, stage: 'compiler', repair: false, ms: 40 },
    { caseId: 't1', call: 3, stage: 'compiler', repair: true, ms: 20 },
    { caseId: 't3', call: 1, stage: 'planner', repair: false, ms: 500 },
  ]);
  expect(report.byCase).toEqual([
    { id: 't1', totalMs: 100, plannerMs: 10, compilerIncludingRepairsMs: 60, otherProcessingMs: 30, repairCalls: 1 },
    { id: 't2', totalMs: 200, plannerMs: null, compilerIncludingRepairsMs: null, otherProcessingMs: null, repairCalls: null },
  ]);
  expect(report.distributions.plannerMs).toEqual({ n: 1, medianMs: 10, p95Ms: 10 });
  expect(report.callsForUnfinishedCases).toBe(1);
});

it('refuses double-counted calls and inconsistent timing artifacts', () => {
  const call = { caseId: 't1', call: 1, stage: 'planner', repair: false, ms: 10 };
  expect(() => summarizeQualityStages([outcome('t1', 100, true)], [call, call])).toThrow();
  expect(() => summarizeQualityStages([outcome('t1', 5, true)], [call])).toThrow();
  expect(() => summarizeQualityStages([], [{ ...call, ms: NaN }])).toThrow();
  expect(() => summarizeQualityStages([], [{ ...call, stage: 'unknown' }])).toThrow();
});

it('does not allow duplicate, unknown or malformed observations to inflate evidence', () => {
  expect(() => summarizeQualityRun(['t1'], [outcome('t1', 1, true), outcome('t1', 1, true)])).toThrow();
  expect(() => summarizeQualityRun(['t1'], [outcome('t2', 1, true)])).toThrow();
  expect(() => summarizeQualityRun(['t1'], [outcome('t1', NaN, true)])).toThrow();
  expect(() => summarizeQualityRun(['t1', 't1'], [])).toThrow();
});
