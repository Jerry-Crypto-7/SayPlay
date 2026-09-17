import { expect, it } from 'vitest';
import { createCallBudget, INTEGRATED_LIMITS, summarizeIntegrated } from './integrated';

it('enforces 90 total calls, three per case, without refunding failed calls', () => {
  const budget = createCallBudget();
  for (let c = 0; c < 30; c++) {
    for (let a = 0; a < 3; a++) expect(budget.take(`c${c}`)).toEqual({ globalCall: c * 3 + a + 1, caseCall: a + 1 });
    expect(() => budget.take(`c${c}`)).toThrow('budget exhausted');
  }
  expect(() => budget.take('extra')).toThrow('budget exhausted');
  expect(budget.total).toBe(90);
  expect(INTEGRATED_LIMITS.runnerTimeoutMs).toBeGreaterThan(90 * INTEGRATED_LIMITS.callTimeoutMs);
});
it('preserves absent observations and rejects interpreting rejected time as live time', () => {
  const report = summarizeIntegrated([{ status: 'pending', intentMs: null, totalMs: null },
    { status: 'rejected', intentMs: 25, totalMs: 100 }, { status: 'compiled', intentMs: 50, totalMs: 200 }]);
  expect(report).toMatchObject({ denominator: 30, completed: 2, certifiedBlueprints: 1,
    intent: { n: 2, p95Ms: 50 }, generationCompletion: { n: 2, p95Ms: 200 },
    certifiedCompletion: { n: 1, p95Ms: 200 }, browserLiveMs: null, firstVisibleCompositionMs: null, cacheState: 'unknown' });
  expect(Object.values(report.gates)).not.toContain('PASS');
  expect(summarizeIntegrated([]).intent.p95Ms).toBeNull();
});
