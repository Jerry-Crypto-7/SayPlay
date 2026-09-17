import type { CaseOutcome } from '../measure-create';

/** Null is no observation, never a fast result. Nearest-rank percentile. */
export function distribution(values: readonly number[]) {
  if (values.length === 0) return { n: 0, medianMs: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { n: sorted.length,
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

export interface QualityCall {
  readonly caseId: string;
  readonly call: number;
  readonly stage: string;
  readonly repair: boolean;
  readonly ms: number;
  readonly reason?: string | null;
}

/** Repair reasons describe the input to a retry, not its terminal failure. */
export function summarizeQualityRepairs(outcomes: readonly CaseOutcome[], calls: readonly QualityCall[]) {
  summarizeQualityStages(outcomes, calls); // Share raw-call integrity checks.
  const byCase = outcomes.map((outcome) => {
    const records = calls.filter((call) => call.caseId === outcome.id).sort((a, b) => a.call - b.call);
    const repairs = records.filter((call) => call.repair);
    const certified = outcome.worldValid && outcome.certified;
    return {
      id: outcome.id,
      category: !records.length ? 'unobserved' : certified
        ? repairs.length ? 'certified-after-repair' : 'certified-without-repair'
        : repairs.length ? 'rejected-after-repair' : 'rejected-without-repair',
      repairCalls: records.length ? repairs.length : null,
      repairMs: records.length ? repairs.reduce((sum, call) => sum + call.ms, 0) : null,
      repairInputs: repairs.map((call) => ({ call: call.call, reason: call.reason ?? null })),
      terminalFailure: outcome.failure,
    };
  });
  const categories = ['certified-without-repair', 'certified-after-repair',
    'rejected-after-repair', 'rejected-without-repair', 'unobserved'];
  return {
    meaning: 'Completed cases only. Retry input reasons are not terminal failures. Certification after repair is an observed outcome, not a causal estimate of repair benefit. Missing raw calls are unobserved.',
    completed: outcomes.length,
    counts: Object.fromEntries(categories.map((category) => [category, byCase.filter((row) => row.category === category).length])),
    repairTime: distribution(byCase.flatMap((row) => row.repairCalls && row.repairMs !== null ? [row.repairMs] : [])),
    byCase,
  };
}

/** Model wall time includes transport; the residual is not isolated witness time. */
export function summarizeQualityStages(outcomes: readonly CaseOutcome[], calls: readonly QualityCall[]) {
  const seen = new Set<string>();
  for (const call of calls) {
    const key = `${call.caseId}/${call.call}`;
    if (seen.has(key) || !Number.isInteger(call.call) || call.call < 1
      || !['planner', 'compiler'].includes(call.stage) || !Number.isFinite(call.ms) || call.ms < 0) {
      throw new Error(`Invalid or duplicate model call: ${key}`);
    }
    seen.add(key);
  }
  const byCase = outcomes.map((outcome) => {
    const records = calls.filter((call) => call.caseId === outcome.id);
    // Missing raw records cannot mean zero model time.
    if (!records.length) return { id: outcome.id, totalMs: outcome.latencyMs,
      plannerMs: null, compilerIncludingRepairsMs: null, otherProcessingMs: null, repairCalls: null };
    const plannerMs = records.filter((call) => call.stage === 'planner').reduce((sum, call) => sum + call.ms, 0);
    const compilerMs = records.filter((call) => call.stage === 'compiler').reduce((sum, call) => sum + call.ms, 0);
    const residual = outcome.latencyMs - plannerMs - compilerMs;
    if (residual < -1) throw new Error(`Model calls exceed total case time: ${outcome.id}`);
    return { id: outcome.id, totalMs: outcome.latencyMs, plannerMs,
      compilerIncludingRepairsMs: compilerMs, otherProcessingMs: Math.max(0, residual),
      repairCalls: records.filter((call) => call.repair).length };
  });
  return {
    meaning: 'Model call wall times include transport. Other processing is a residual, not isolated witness time. Stage percentiles cannot be added.',
    byCase,
    distributions: Object.fromEntries((['plannerMs', 'compilerIncludingRepairsMs', 'otherProcessingMs', 'totalMs'] as const)
      .map((key) => [key, distribution(byCase.flatMap((row) => row[key] === null ? [] : [row[key]]))])),
    callsForUnfinishedCases: calls.filter((call) => !outcomes.some((outcome) => outcome.id === call.caseId)).length,
  };
}

export function summarizeQualityRun(expectedIds: readonly string[], outcomes: readonly CaseOutcome[]) {
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length) throw new Error('Duplicate expected case');
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (!expected.has(outcome.id) || seen.has(outcome.id)) throw new Error(`Unknown or duplicate outcome: ${outcome.id}`);
    if (!Number.isFinite(outcome.latencyMs) || outcome.latencyMs < 0) throw new Error(`Invalid latency: ${outcome.id}`);
    seen.add(outcome.id);
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  const certified = outcomes.filter((o) => o.worldValid && o.certified);
  const failures: Record<string, string[]> = {};
  for (const outcome of outcomes) {
    if (outcome.failure) (failures[outcome.failure.stage] ??= []).push(outcome.id);
  }
  return {
    status: missing.length ? 'incomplete' : 'complete',
    expected: expectedIds.length, completed: outcomes.length, pending: missing,
    compiled: outcomes.filter((o) => o.blueprintValid).length,
    certifiedProxyWorlds: certified.length,
    geometryAuthored: outcomes.filter((o) => o.geometryAuthored).length,
    failures,
    latencyAllCompleted: distribution(outcomes.map((o) => o.latencyMs)),
    latencyCertifiedProxyWorlds: distribution(certified.map((o) => o.latencyMs)),
    visualRecognition: 'pending: independent blind human ratings required',
    browserReadiness: 'pending: Node completion is not first visible/live browser time',
    performance: 'pending: gallery is not a 1080p frame-time benchmark',
  };
}
