/** In-process project transaction. One immutable pointer owns world and evidence.
 * This is neither durable storage nor a win/semantic certification gate. */
import { z } from 'zod';
import { buildRuntimeWorld } from '../ir/build';
import { canonical, canonicalHash, migrateWorldDoc, validateLook, type WorldDoc } from '../ir/worlddoc';
import { createBranchController, type BranchComparison } from './branch-controller';
import type { RuntimeController } from './runtime-controller';
import { ruleSupportParts } from './rule-support';
import { parameterConfirmationSchema, validateParameterConfirmation, type ParameterConfirmation } from './source-parameters';
import { evidenceRevisionSchema, sourceSnapshotSchema, sealEvidenceDraft, validateEvidenceRevision,
  EVIDENCE_LIMITS, type EvidenceRevision, type SourceSnapshot } from './evidence';

export interface ProjectRevision {
  readonly projectRevision: string;
  readonly branchId: string;
  readonly world: WorldDoc;
  readonly evidence: EvidenceRevision;
  readonly sources: readonly SourceSnapshot[];
  readonly parent: ProjectRevision | null;
  readonly comparison: BranchComparison | null;
  readonly parameterConfirmation: ParameterConfirmation;
}
export type ProjectCommitResult = { readonly ok: true; readonly value: ProjectRevision }
  | { readonly ok: false; readonly issues: readonly string[] };
const reject = (...issues: string[]): ProjectCommitResult => ({ ok: false, issues });
const initialSchema = z.strictObject({ base: z.null(), world: z.unknown(),
  evidence: evidenceRevisionSchema, sources: z.array(sourceSnapshotSchema).max(EVIDENCE_LIMITS.sources),
  parameterConfirmation: parameterConfirmationSchema });
const interventionSchema = z.strictObject({ base: z.string(), ruleId: z.string().min(1).max(128),
  durationTicks: z.int().min(1).max(3_600), forkTick: z.int().min(0).max(3_600),
  observationTick: z.int().min(0).max(12_000), reason: z.string().trim().min(1).max(2_000) });

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function projectWorldRevision(world: WorldDoc): string { return canonicalHash(world); }
function context(world: WorldDoc, sources: readonly SourceSnapshot[], parent: ProjectRevision | null) {
  return { worldRevision: projectWorldRevision(world),
    rules: world.sim.rules,
    ruleIds: new Set(Object.keys(world.sim.rules as object)),
    entityIds: new Set(Object.keys(world.sim.entities as object)),
    sources: new Map(sources.map(source => [source.sourceId, source])),
    parent: parent ? { branchId: parent.branchId, worldRevision: parent.evidence.worldRevision,
      evidenceHash: parent.evidence.evidenceHash } : null };
}
function snapshot(world: WorldDoc, evidence: EvidenceRevision, sources: readonly SourceSnapshot[],
  parent: ProjectRevision | null, comparison: BranchComparison | null, parameterConfirmation: ParameterConfirmation): ProjectRevision {
  const branchId = parent ? 'branch-1' : 'origin';
  return freeze({ projectRevision: canonicalHash({ world, evidenceHash: evidence.evidenceHash, sources,
    branchId, parent: parent?.projectRevision ?? null, comparison, parameterConfirmation }),
    branchId, world, evidence, sources, parent, comparison, parameterConfirmation });
}

/** Application-owned store; never accept a caller-supplied accepted snapshot.
 * Every await precedes a compare-and-swap check. Pilot supports one intervention.
 * Review authorization is deliberately absent: model/caller cannot self-confirm. */
export function createEvidenceProject() {
  let current: ProjectRevision | null = null;
  return {
    getSnapshot: () => current,
    async commitInitial(input: unknown): Promise<ProjectCommitResult> {
      if (current !== null) return reject('STALE_REVISION');
      try {
        const parsed = initialSchema.safeParse(input);
        if (!parsed.success) return reject('INVALID_REQUEST');
        // Clone before hashing: no caller-owned object survives an await.
        const request = structuredClone(parsed.data);
        const migrated = migrateWorldDoc(request.world);
        if (!migrated.ok || !migrated.doc) return reject('WORLD_INVALID');
        const world = migrated.doc;
        if (!validateLook(world.look).ok || !buildRuntimeWorld(world.sim).ok) return reject('WORLD_INVALID');
        if (!await validateParameterConfirmation(request.parameterConfirmation, world.sim, request.sources, request.evidence))
          return reject('PARAMETERS_NOT_CONFIRMED');
        const ids = request.sources.map(source => source.sourceId);
        if (new Set(ids).size !== ids.length || ids.length !== request.evidence.sources.length
          || request.evidence.sources.some(ref => !ids.includes(ref.sourceId))) return reject('SOURCE_SNAPSHOT_MISMATCH');
        const ctx = context(world, request.sources, null);
        // T7 seals a proposal revision before the application assembles WorldDoc.
        // Verify that seal first, then rebind it to the complete accepted world.
        const validated = await validateEvidenceRevision(request.evidence,
          { ...ctx, worldRevision: request.evidence.worldRevision });
        if (!validated.ok) return validated;
        const { evidenceHash: _hash, ...draft } = validated.value;
        const evidence = await sealEvidenceDraft({ ...draft, worldRevision: ctx.worldRevision }, ctx);
        if (!evidence.ok) return evidence;
        const next = snapshot(world, evidence.value, request.sources, null, null, request.parameterConfirmation);
        if (current !== null) return reject('STALE_REVISION');
        current = next;
        return { ok: true, value: next };
      } catch { return reject('PROJECT_VALIDATION_FAILED'); }
    },
    async commitIntervention(input: unknown, runtime: RuntimeController): Promise<ProjectCommitResult> {
      const parent = current;
      try {
        const parsed = interventionSchema.safeParse(input);
        if (!parsed.success) return reject('INVALID_REQUEST');
        const request = parsed.data;
        if (!parent || request.base !== parent.projectRevision) return reject('STALE_REVISION');
        if (parent.parent) return reject('UNSUPPORTED_CHANGE');
        // Compare on a private controller: failure cannot publish a branch alone.
        const controller = createBranchController(parent.world, runtime);
        const compared = controller.compare({ base: controller.getBase(), ruleId: request.ruleId,
          durationTicks: request.durationTicks, forkTick: request.forkTick, observationTick: request.observationTick });
        if (compared.verdict !== 'COMPARED') return reject(compared.reason);
        const comparison = compared.snapshot.comparison!;
        const world = comparison.changedDocument;
        const { evidenceHash: _hash, ...draft } = structuredClone(parent.evidence);
        // Allocate stable IDs without colliding with model-chosen identifiers.
        let suffix = 1;
        while (draft.claims.some(claim => claim.claimId === `intervention_${suffix}`)) suffix++;
        const interventionId = `intervention_${suffix}`;
        draft.claims.push({ claimId: interventionId, support: 'assumed', interventionId,
          text: `Timer ${request.ruleId}: ${comparison.previousDurationTicks} → ${comparison.durationTicks} ticks.`,
          reason: request.reason, review: { status: 'unchecked' } });
        // A changed rule must not continue citing the original duration as support.
        const components = draft.schemaVersion === 'worldstream-evidence-v2' ? ruleSupportParts(world.sim.rules) : null;
        draft.bindings = draft.bindings.map(binding => {
          if (binding.target.kind !== 'rule' || binding.target.id !== request.ruleId) return binding;
          // Keep the exact v1 transformation for historical branch replay.
          if (!components) return { ...binding, claimIds: [interventionId] };
          const part = components.find(part => part.ruleId === request.ruleId && part.part === binding.part);
          if (!part?.part.startsWith('action.') || (part.declaration as { kind: string }).kind !== 'startTimer') return binding;
          return { ...binding, claimIds: [interventionId], declarationHash: part.declarationHash };
        });
        draft.interventions = [{ interventionId, parentBranchId: parent.branchId, forkTick: comparison.forkTick,
          baseWorldRevision: parent.evidence.worldRevision, ruleId: comparison.ruleId,
          before: comparison.previousDurationTicks, after: comparison.durationTicks, reason: request.reason }];
        draft.worldRevision = projectWorldRevision(world);
        draft.parentEvidenceHash = parent.evidence.evidenceHash;
        const evidence = await sealEvidenceDraft(draft, context(world, parent.sources, parent));
        if (!evidence.ok) return evidence;
        const next = snapshot(world, evidence.value, parent.sources, parent, comparison, parent.parameterConfirmation);
        if (current !== parent) return reject('STALE_REVISION');
        if (canonical(runtime.getInputLog()) !== canonical(comparison.inputLog)) return reject('STALE_INPUTS');
        current = next;
        return { ok: true, value: next };
      } catch { return reject('PROJECT_VALIDATION_FAILED'); }
    },
  };
}
