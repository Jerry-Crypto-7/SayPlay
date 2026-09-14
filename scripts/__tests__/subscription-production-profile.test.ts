import { describe, expect, it } from 'vitest';
import { EMISSION_MODEL } from '../../src/model/prompt';
import { assessProductionReadiness, productionValidationSchema, requireProductionReadiness,
  SUBSCRIPTION_PRODUCTION_PROFILE, type ProductionProfileValidation } from '../subscription-production-profile';

const identity = { validationRunId: 'current-dispatcher-run', launcherSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
function fixture(): ProductionProfileValidation {
  const stages = Object.fromEntries(Object.entries(productionValidationSchema.shape.stages.shape).map(([name, schema]) =>
    [name, { status: 'PASS', reportSha256: 'c'.repeat(64),
      checks: Object.fromEntries(Object.keys(schema.shape.checks.shape).map(key => [key, true])) }]));
  return productionValidationSchema.parse({ kind: 'subscription-production-profile-validation', version: 1,
    profile: { ...SUBSCRIPTION_PRODUCTION_PROFILE }, identity: { ...identity }, stages });
}
describe('trusted caller production readiness contract (synthetic evidence only)', () => {
  it('preserves the current repository model, low effort and production limits', () => {
    expect(SUBSCRIPTION_PRODUCTION_PROFILE.model).toBe(EMISSION_MODEL);
    expect(Object.isFrozen(SUBSCRIPTION_PRODUCTION_PROFILE)).toBe(true);
    expect(SUBSCRIPTION_PRODUCTION_PROFILE).toMatchObject({ effort: 'low', jobDeadlineMs: 180000,
      commandDeadlineMs: 200000, killGraceMs: 5000, maxOutputBytes: 8388608, apiFallback: false });
  });
  it('accepts a complete internally consistent trusted caller record without claiming attestation', () => {
    expect(assessProductionReadiness(fixture(), identity)).toMatchObject({ ready: true,
      blockers: [], assessmentKind: 'trusted-caller-contract-only' });
  });
  it('keeps a successful credential-free runtime probe separate from all production prerequisites', () => {
    const report = fixture();
    for (const [name, stage] of Object.entries(report.stages)) if (name !== 'runtimeProbe') {
      stage.status = 'NOT_RUN'; stage.reportSha256 = null;
      for (const key of Object.keys(stage.checks)) (stage.checks as Record<string, boolean | null>)[key] = null;
    }
    const result = assessProductionReadiness(report, identity);
    expect(result.ready).toBe(false); expect(result.stages.runtimeProbe).toBe('PASS');
    expect(result.blockers).toEqual(['productionSandbox:NOT_RUN', 'chatgptAuth:NOT_RUN', 'productionNetwork:NOT_RUN', 'productionCleanup:NOT_RUN']);
    expect(() => requireProductionReadiness(report, identity)).toThrow('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
  });
  it.each([null, {}, { kind: 'offline-wsl-supervisor-matrix', allCasesRun: true },
    { fixedDummy: true, remoteCleanup: 'verified', modelCalls: 0 },
    { kind: 'runtime-probe', status: 'PASS' }])('rejects unrelated/dummy reports: %j', value => {
    expect(assessProductionReadiness(value, identity).ready).toBe(false);
  });
  it.each(['model', 'effort', 'apiFallback', 'jobDeadlineMs', 'commandDeadlineMs', 'killGraceMs', 'maxOutputBytes', 'distro', 'runtimeVersion', 'runtimeSource'])('rejects changed fixed profile %s', key => {
    const report = fixture(); (report.profile as Record<string, unknown>)[key] = 'changed';
    expect(assessProductionReadiness(report, identity).blockers).toContain('INVALID_PRODUCTION_VALIDATION');
  });
  it.each(['launcherSha256', 'runtimeSha256', 'validationRunId'] as const)('rejects stale current identity %s', key => {
    const expected = { ...identity, [key]: key === 'validationRunId' ? 'next-run' : 'd'.repeat(64) };
    expect(assessProductionReadiness(fixture(), expected).blockers).toContain('CURRENT_DISPATCHER_IDENTITY_MISMATCH');
  });
  it.each(['runtimeProbe', 'productionSandbox', 'chatgptAuth', 'productionNetwork', 'productionCleanup'] as const)('requires every check in %s', name => {
    const report = fixture(); const checks = report.stages[name].checks as Record<string, boolean | null>;
    for (const key of Object.keys(checks)) {
      checks[key] = false;
      expect(assessProductionReadiness(report, identity).stages[name]).toBe('INVALID');
      checks[key] = null;
      expect(assessProductionReadiness(report, identity).ready).toBe(false);
      checks[key] = true;
    }
    report.stages[name].reportSha256 = null;
    expect(assessProductionReadiness(report, identity).ready).toBe(false);
  });
  it('does not promote a failed attempt even with positive checks', () => {
    const report = fixture(); report.stages.chatgptAuth.status = 'FAIL';
    expect(assessProductionReadiness(report, identity).stages.chatgptAuth).toBe('FAIL');
    expect(assessProductionReadiness(report, identity).ready).toBe(false);
  });
  it('rejects launch overrides and mixed NOT_RUN observations', () => {
    expect(assessProductionReadiness({ ...fixture(), executable: 'other' }, identity).ready).toBe(false);
    const report = fixture(); report.stages.productionSandbox.status = 'NOT_RUN';
    expect(assessProductionReadiness(report, identity).stages.productionSandbox).toBe('INVALID');
  });
});
