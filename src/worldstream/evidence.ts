/** Versioned evidence sidecar. Structural validity is not semantic truth. */
import { z } from 'zod';

import { ID_PATTERN } from '../ir/types';
import { canonical } from '../ir/worlddoc';
import { isUnaddressableToken } from '../patch/reject';

export const EVIDENCE_VERSION = 'worldstream-evidence-v1';
export const EVIDENCE_LIMITS = Object.freeze({
  sourceCodePoints: 4_000, sourceBytes: 16_000, sources: 4,
  claims: 64, bindings: 128, references: 16, spans: 8,
});
const encoder = new TextEncoder();
// Keep a leading BOM in excerpts; source bytes are never normalized.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const id = z.string().regex(ID_PATTERN).refine((value) => !isUnaddressableToken(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().min(1).max(128);
const text = z.string().min(1).max(2_000);
const references = z.array(id).min(1).max(EVIDENCE_LIMITS.references);

function wellFormed(value: string): boolean {
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

const sourceText = z.string().min(1).max(EVIDENCE_LIMITS.sourceCodePoints * 2)
  .refine(wellFormed, 'unpaired UTF-16 surrogate')
  .refine((value) => [...value].length <= EVIDENCE_LIMITS.sourceCodePoints, 'source code point limit')
  .refine((value) => encoder.encode(value).byteLength <= EVIDENCE_LIMITS.sourceBytes, 'source byte limit');

const sourceFields = {
  sourceId: id, text: sourceText, title: z.string().min(1).max(256),
  mediaType: z.literal('text/plain'), origin: z.enum(['own', 'provided']),
  rights: z.enum(['owned', 'licensed', 'unreviewed']),
};
export const sourceSnapshotSchema = z.strictObject({ ...sourceFields, sha256: hash });
const sourceInputSchema = z.strictObject(sourceFields);
export type SourceSnapshot = Readonly<z.infer<typeof sourceSnapshotSchema>>;

const reviewSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unchecked') }),
  z.strictObject({
    status: z.enum(['confirmed', 'disputed']), reviewerId: id,
    at: z.iso.datetime(), scope: z.enum(['textual-support', 'assumption']),
  }),
]);
const commonClaim = {
  claimId: id, text, review: reviewSchema,
  interventionId: id.nullable(),
};
const spanSchema = z.strictObject({
  sourceId: id, startByte: z.int().min(0).max(EVIDENCE_LIMITS.sourceBytes),
  endByte: z.int().min(1).max(EVIDENCE_LIMITS.sourceBytes),
  excerpt: z.string().min(1).max(EVIDENCE_LIMITS.sourceCodePoints * 2),
});
const claimSchema = z.discriminatedUnion('support', [
  z.strictObject({ ...commonClaim, support: z.literal('sourced'), spans: z.array(spanSchema).min(1).max(EVIDENCE_LIMITS.spans) }),
  z.strictObject({ ...commonClaim, support: z.literal('derived'), premiseClaimIds: references, derivation: text }),
  z.strictObject({ ...commonClaim, support: z.literal('assumed'), reason: text }),
]);
const bindingSchema = z.strictObject({
  bindingId: id, target: z.strictObject({ kind: z.enum(['rule', 'entity']), id }), claimIds: references,
});
const scalar = z.union([z.number().finite().refine((value) => !Object.is(value, -0)), z.boolean(), z.string().min(1).max(128)]);
const interventionSchema = z.strictObject({
  // BranchStore uses origin / branch-1; these are not IR identifiers.
  interventionId: id, parentBranchId: revision, forkTick: z.int().min(0).max(3_600),
  baseWorldRevision: revision, ruleId: id, before: scalar, after: scalar,
  reason: text,
});
const fields = {
  schemaVersion: z.literal(EVIDENCE_VERSION), worldRevision: revision,
  parentEvidenceHash: hash.nullable(),
  sources: z.array(z.strictObject({ sourceId: id, sha256: hash })).max(EVIDENCE_LIMITS.sources),
  claims: z.array(claimSchema).min(1).max(EVIDENCE_LIMITS.claims),
  bindings: z.array(bindingSchema).min(1).max(EVIDENCE_LIMITS.bindings),
  interventions: z.array(interventionSchema).max(EVIDENCE_LIMITS.claims),
};
export const evidenceDraftSchema = z.strictObject(fields);
export const evidenceRevisionSchema = z.strictObject({ ...fields, evidenceHash: hash });
export type EvidenceDraft = z.infer<typeof evidenceDraftSchema>;
export type EvidenceRevision = z.infer<typeof evidenceRevisionSchema>;
export type EvidenceResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Trusted application inputs, never fields supplied by the model. */
export interface EvidenceContext {
  readonly worldRevision: string;
  readonly ruleIds: ReadonlySet<string>;
  readonly entityIds: ReadonlySet<string>;
  readonly sources: ReadonlyMap<string, SourceSnapshot>;
  readonly parent: { readonly branchId: string; readonly evidenceHash: string; readonly worldRevision: string } | null;
  /** Exact reviewed revision digests from an authoritative review store. */
  readonly reviewedRevisionHashes?: ReadonlySet<string>;
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSourceSnapshot(input: unknown): Promise<EvidenceResult<SourceSnapshot>> {
  const parsed = sourceInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: ['SOURCE_INVALID'] };
  const value = parsed.data;
  return { ok: true, value: Object.freeze({ ...value, sha256: await sha256(encoder.encode(value.text)) }) };
}

/** Canonical SHA-256 of the entire sidecar; does not modify WorldDoc/simHash. */
export async function evidenceDigest(draft: EvidenceDraft): Promise<string> {
  const checked = evidenceDraftSchema.parse(draft);
  return sha256(encoder.encode(canonical(checked)));
}

export async function sealEvidenceDraft(input: unknown, context: EvidenceContext): Promise<EvidenceResult<EvidenceRevision>> {
  const parsed = evidenceDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: ['EVIDENCE_SCHEMA_INVALID'] };
  const draft = frozen(parsed.data);
  const issues: string[] = [];
  if (draft.worldRevision !== context.worldRevision) issues.push('STALE_WORLD_REVISION');
  if (draft.parentEvidenceHash !== (context.parent?.evidenceHash ?? null)) issues.push('STALE_EVIDENCE_PARENT');

  const unique = (values: readonly string[], kind: string) => {
    if (new Set(values).size !== values.length) issues.push(`DUPLICATE_${kind}`);
  };
  unique(draft.sources.map((source) => source.sourceId), 'SOURCE');
  unique(draft.claims.map((claim) => claim.claimId), 'CLAIM');
  unique(draft.bindings.map((binding) => binding.bindingId), 'BINDING');
  unique(draft.interventions.map((entry) => entry.interventionId), 'INTERVENTION');

  // Parse and clone trusted snapshots before any await, so one validation
  // never mixes source versions across asynchronous digest operations.
  const sources = new Map<string, SourceSnapshot>();
  let sourceBytes = 0;
  for (const ref of draft.sources) {
    const source = sourceSnapshotSchema.safeParse(context.sources.get(ref.sourceId));
    if (!source.success || source.data.sourceId !== ref.sourceId || source.data.sha256 !== ref.sha256) {
      issues.push('SOURCE_SNAPSHOT_MISMATCH');
      continue;
    }
    sourceBytes += encoder.encode(source.data.text).byteLength;
    sources.set(ref.sourceId, source.data);
  }
  if (sourceBytes > EVIDENCE_LIMITS.sourceBytes) issues.push('SOURCE_TOTAL_TOO_LARGE');

  const claims = new Map(draft.claims.map((claim) => [claim.claimId, claim]));
  const interventions = new Map(draft.interventions.map((entry) => [entry.interventionId, entry]));
  for (const entry of draft.interventions) {
    if (!context.parent || entry.baseWorldRevision !== context.parent.worldRevision) issues.push('INTERVENTION_BASE_MISMATCH');
    if (entry.parentBranchId !== context.parent?.branchId) issues.push('INTERVENTION_PARENT_MISMATCH');
    if (!context.ruleIds.has(entry.ruleId)) issues.push('INTERVENTION_RULE_MISSING');
    if (Object.is(entry.before, entry.after)) issues.push('INTERVENTION_NO_CHANGE');
    if (!draft.claims.some((claim) => claim.interventionId === entry.interventionId)) issues.push('INTERVENTION_UNBOUND');
  }
  for (const claim of draft.claims) {
    if (claim.interventionId !== null) {
      if (!interventions.has(claim.interventionId)) issues.push('INTERVENTION_MISSING');
      if (claim.support === 'sourced') issues.push('CHANGED_CLAIM_CANNOT_INHERIT_SOURCE');
    }
    if (claim.support === 'derived') {
      unique(claim.premiseClaimIds, 'PREMISE');
      if (claim.premiseClaimIds.some((premise) => !claims.has(premise))) issues.push('PREMISE_MISSING');
    }
    if (claim.support !== 'sourced') continue;
    for (const span of claim.spans) {
      const source = sources.get(span.sourceId);
      if (!source) { issues.push('SPAN_SOURCE_MISSING'); continue; }
      const bytes = encoder.encode(source.text);
      try {
        if (span.startByte >= span.endByte || span.endByte > bytes.byteLength ||
          decoder.decode(bytes.slice(span.startByte, span.endByte)) !== span.excerpt) issues.push('SOURCE_SPAN_INVALID');
      } catch { issues.push('SOURCE_SPAN_INVALID'); }
    }
  }

  // Flat, bounded claim table; DFS depth cannot exceed the claim limit.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (claimId: string): void => {
    if (visiting.has(claimId)) { issues.push('CLAIM_CYCLE'); return; }
    if (visited.has(claimId)) return;
    visiting.add(claimId);
    const claim = claims.get(claimId);
    if (claim?.support === 'derived') claim.premiseClaimIds.forEach(visit);
    visiting.delete(claimId);
    visited.add(claimId);
  };
  draft.claims.forEach((claim) => visit(claim.claimId));

  const boundRules = new Set<string>();
  for (const binding of draft.bindings) {
    const known = binding.target.kind === 'rule' ? context.ruleIds : context.entityIds;
    if (!known.has(binding.target.id)) issues.push('BINDING_TARGET_MISSING');
    if (binding.target.kind === 'rule') boundRules.add(binding.target.id);
    unique(binding.claimIds, 'BINDING_CLAIM');
    for (const claimId of binding.claimIds) {
      const claim = claims.get(claimId);
      if (!claim) { issues.push('BINDING_CLAIM_MISSING'); continue; }
      if (claim.interventionId !== null) {
        const intervention = interventions.get(claim.interventionId);
        if (binding.target.kind !== 'rule' || intervention?.ruleId !== binding.target.id) issues.push('INTERVENTION_BINDING_MISMATCH');
      }
    }
  }
  for (const ruleId of context.ruleIds) if (!boundRules.has(ruleId)) issues.push('RULE_EVIDENCE_MISSING');
  for (const entry of draft.interventions) {
    if (!draft.bindings.some((binding) => binding.target.kind === 'rule' && binding.target.id === entry.ruleId &&
      binding.claimIds.some((claimId) => claims.get(claimId)?.interventionId === entry.interventionId))) issues.push('INTERVENTION_BINDING_MISMATCH');
  }
  if (issues.length) return { ok: false, issues: [...new Set(issues)] };

  for (const source of sources.values()) {
    if (await sha256(encoder.encode(source.text)) !== source.sha256) issues.push('SOURCE_HASH_MISMATCH');
  }
  const evidenceHash = await evidenceDigest(draft);
  if (draft.claims.some((claim) => claim.review.status !== 'unchecked') &&
    !context.reviewedRevisionHashes?.has(evidenceHash)) issues.push('REVIEW_NOT_AUTHORIZED');
  if (issues.length) return { ok: false, issues: [...new Set(issues)] };
  return { ok: true, value: frozen({ ...draft, evidenceHash }) };
}

export async function validateEvidenceRevision(input: unknown, context: EvidenceContext): Promise<EvidenceResult<EvidenceRevision>> {
  const parsed = evidenceRevisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: ['EVIDENCE_SCHEMA_INVALID'] };
  const { evidenceHash, ...draft } = parsed.data;
  const result = await sealEvidenceDraft(draft, context);
  if (!result.ok) return result;
  if (result.value.evidenceHash !== evidenceHash) return { ok: false, issues: ['EVIDENCE_HASH_MISMATCH'] };
  return result;
}
