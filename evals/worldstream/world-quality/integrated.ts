/** Testable bounds for the T18 live series. No network on import. */
export const INTEGRATED_LIMITS = { cases: 30, calls: 90, callsPerCase: 3, compilerAttempts: 2,
  callTimeoutMs: 240_000, outputTokens: 8000, runnerTimeoutMs: 90 * 240_000 + 10 * 60_000 } as const;

export function createCallBudget() {
  let total = 0;
  const byCase = new Map<string, number>();
  return {
    take(caseId: string) {
      const used = byCase.get(caseId) ?? 0;
      if (total >= INTEGRATED_LIMITS.calls || used >= INTEGRATED_LIMITS.callsPerCase)
        throw new Error('T18 model-call budget exhausted');
      total++; byCase.set(caseId, used + 1); return { globalCall: total, caseCall: used + 1 };
    },
    get total() { return total; },
  };
}

export function summarizeIntegrated(rows: readonly { status: string; intentMs: number | null; totalMs: number | null }[]) {
  const stats = (values: number[]) => {
    values.sort((a, b) => a - b);
    return { n: values.length, p95Ms: values.length ? values[Math.ceil(values.length * .95) - 1] : null };
  };
  return { denominator: INTEGRATED_LIMITS.cases, completed: rows.filter(r => ['compiled', 'rejected', 'unavailable'].includes(r.status)).length,
    certifiedBlueprints: rows.filter(r => r.status === 'compiled').length,
    intent: stats(rows.flatMap(r => r.intentMs === null ? [] : [r.intentMs])),
    generationCompletion: stats(rows.flatMap(r => r.totalMs === null ? [] : [r.totalMs])),
    certifiedCompletion: stats(rows.flatMap(r => r.status === 'compiled' && r.totalMs !== null ? [r.totalMs] : [])),
    firstVisibleCompositionMs: null, browserLiveMs: null, cacheState: 'unknown',
    gates: { 'G-R': 'PENDING_BROWSER', 'G-L': 'PENDING_BROWSER', 'G-V': 'PENDING_HUMANS', 'G-W': 'PENDING_HUMANS',
      'G-A4': 'FIXTURE_EVIDENCE_ONLY', 'G-P': 'PENDING_TARGET_HARDWARE', 'G-E': 'PENDING_REAL_ASSETS', 'G-D': 'PENDING_EXTERNAL' } };
}
