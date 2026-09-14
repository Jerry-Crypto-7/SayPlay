/** Offline contract for a trusted dispatcher caller, NOT cryptographic attestation.
 * This module neither launches a process nor verifies a report's provenance or
 * its bytes. The caller must obtain current evidence from the actual dispatcher
 * and compare its launcher/runtime identity immediately before each operation.
 * A successful schema check cannot validate an arbitrary caller or executable.
 * Dummy, prepared and credential-free probes never establish live/auth credit.
 */
import { z } from 'zod';

export const SUBSCRIPTION_PRODUCTION_PROFILE = Object.freeze({
  id: 'codex-chatgpt-wsl-production-v1', model: 'gpt-6-astra', effort: 'low',
  billing: 'subscription', apiFallback: false, distro: 'Ubuntu-24.04',
  runtimeVersion: '0.145.0',
  runtimeSource: '/home/troy/.codex/packages/standalone/releases/0.145.0-x86_64-unknown-linux-musl/bin/codex',
  jobDeadlineMs: 180_000, commandDeadlineMs: 200_000,
  killGraceMs: 5_000, maxOutputBytes: 8 * 1024 * 1024,
} as const);

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.strictObject({
  validationRunId: z.string().min(1).max(200), launcherSha256: hash, runtimeSha256: hash,
});
export type ProductionValidationIdentity = z.infer<typeof identitySchema>;
const profileSchema = z.strictObject({
  id: z.literal(SUBSCRIPTION_PRODUCTION_PROFILE.id), model: z.literal(SUBSCRIPTION_PRODUCTION_PROFILE.model),
  effort: z.literal('low'), billing: z.literal('subscription'), apiFallback: z.literal(false),
  distro: z.literal('Ubuntu-24.04'), jobDeadlineMs: z.literal(180_000), commandDeadlineMs: z.literal(200_000),
  runtimeVersion: z.literal(SUBSCRIPTION_PRODUCTION_PROFILE.runtimeVersion),
  runtimeSource: z.literal(SUBSCRIPTION_PRODUCTION_PROFILE.runtimeSource),
  killGraceMs: z.literal(5_000), maxOutputBytes: z.literal(8 * 1024 * 1024),
});
const check = z.boolean().nullable();
const evidence = <T extends z.ZodRawShape>(checks: T) => z.strictObject({
  status: z.enum(['PASS', 'FAIL', 'NOT_RUN']), reportSha256: hash.nullable(), checks: z.strictObject(checks),
});
const stagesSchema = z.strictObject({
  runtimeProbe: evidence({ nativeLinuxRuntime: check, fixedBinaryIdentity: check,
    isolatedVersionAndHelp: check, cleanEnvironment: check }),
  productionSandbox: evidence({ actualCliProfile: check, exclusivePidNamespace: check,
    readOnlyRuntime: check, hostPathsDenied: check, auditFdDenied: check,
    capabilitiesDropped: check, noNewPrivileges: check, filesystemEnvelopeVerified: check }),
  chatgptAuth: evidence({ actualCliProfile: check, runtimeAndSandboxValidatedBeforeAuth: check,
    chatgptLogin: check, noApiFallback: check, noCredentialContentsRecorded: check }),
  productionNetwork: evidence({ actualCliProfile: check, allowedTransportVerified: check,
    deniedTrafficVerified: check, dnsAndTlsVerified: check }),
  productionCleanup: evidence({ actualCliProfile: check, exactProductionLimits: check,
    normalExit: check, cancel: check, deadline: check, controlEof: check, wrapperDisconnect: check,
    detachedDescendant: check, outputBackpressure: check, inputBackpressure: check,
    partialSetupFailure: check, ownedReapAndEsrch: check, noExternalHarnessCleanup: check }),
});
export const productionValidationSchema = z.strictObject({
  kind: z.literal('subscription-production-profile-validation'), version: z.literal(1),
  profile: profileSchema, identity: identitySchema, stages: stagesSchema,
});
export type ProductionProfileValidation = z.infer<typeof productionValidationSchema>;
export type ProductionValidationStage = keyof ProductionProfileValidation['stages'];
export interface ProductionReadiness {
  ready: boolean;
  blockers: string[];
  stages: Record<ProductionValidationStage, 'PASS' | 'FAIL' | 'NOT_RUN' | 'INVALID'>;
  // This assessment is not an inference, human review or independent validation.
  assessmentKind: 'trusted-caller-contract-only';
}
const stageNames = ['runtimeProbe', 'productionSandbox', 'chatgptAuth', 'productionNetwork', 'productionCleanup'] as const;

/** expected must come from the trusted current dispatcher, not from value.
 * Comparing an archived report against its own identity is not revalidation.
 * No API accepts executable paths, environment overrides or arbitrary argv.
 */
export function assessProductionReadiness(value: unknown, expected: ProductionValidationIdentity): ProductionReadiness {
  const result: ProductionReadiness = { ready: false, blockers: [],
    stages: { runtimeProbe: 'INVALID', productionSandbox: 'INVALID', chatgptAuth: 'INVALID',
      productionNetwork: 'INVALID', productionCleanup: 'INVALID' }, assessmentKind: 'trusted-caller-contract-only' };
  const parsed = productionValidationSchema.safeParse(value);
  const current = identitySchema.safeParse(expected);
  if (!parsed.success || !current.success) { result.blockers.push('INVALID_PRODUCTION_VALIDATION'); return result; }
  const report = parsed.data;
  if (Object.keys(current.data).some(key => report.identity[key as keyof ProductionValidationIdentity] !== current.data[key as keyof ProductionValidationIdentity]))
    result.blockers.push('CURRENT_DISPATCHER_IDENTITY_MISMATCH');
  for (const name of stageNames) {
    const stage = report.stages[name];
    const allTrue = Object.values(stage.checks).every(value => value === true);
    // PASS needs complete positive observations and an evidence reference.
    // NOT_RUN cannot carry observations from a different historical attempt.
    const consistent = stage.status === 'PASS' ? allTrue && stage.reportSha256 !== null
      : stage.status === 'NOT_RUN' ? stage.reportSha256 === null && Object.values(stage.checks).every(value => value === null)
      : stage.reportSha256 !== null;
    result.stages[name] = consistent ? stage.status : 'INVALID';
    if (result.stages[name] !== 'PASS') result.blockers.push(`${name}:${result.stages[name]}`);
  }
  result.ready = result.blockers.length === 0;
  return result;
}

/** Use at a transport boundary after the caller performs actual revalidation. */
export function requireProductionReadiness(value: unknown, expected: ProductionValidationIdentity): void {
  if (!assessProductionReadiness(value, expected).ready) throw new Error('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
}
