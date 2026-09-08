import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonical } from '../../ir/worlddoc';
import {
  createSourceSnapshot, evidenceDigest, sealEvidenceDraft, validateEvidenceRevision,
  EVIDENCE_VERSION, type EvidenceContext, type EvidenceDraft,
} from '../evidence';

const SOURCE = '\ufeffČasovač běží 20 sekund.\r\nŽádný restart.';
const SOURCE_INPUT = { sourceId: 'procedure', text: SOURCE, title: 'Museum', mediaType: 'text/plain', origin: 'own', rights: 'owned' };

async function fixture() {
  const created = await createSourceSnapshot(SOURCE_INPUT);
  if (!created.ok) throw new Error(created.issues.join(','));
  const source = created.value;
  const excerpt = '20 sekund';
  const startByte = Buffer.byteLength(SOURCE.slice(0, SOURCE.indexOf(excerpt)), 'utf8');
  const draft: EvidenceDraft = {
    schemaVersion: EVIDENCE_VERSION, worldRevision: 'world_1', parentEvidenceHash: null,
    sources: [{ sourceId: source.sourceId, sha256: source.sha256 }],
    claims: [{
      claimId: 'duration', text: 'The timer lasts 20 seconds.', support: 'sourced',
      interventionId: null, review: { status: 'unchecked' },
      spans: [{ sourceId: source.sourceId, startByte, endByte: startByte + Buffer.byteLength(excerpt), excerpt }],
    }],
    bindings: [{ bindingId: 'duration_rule', target: { kind: 'rule', id: 'start_countdown' }, claimIds: ['duration'] }],
    interventions: [],
  };
  const context: EvidenceContext = {
    worldRevision: 'world_1', parent: null, ruleIds: new Set(['start_countdown']),
    entityIds: new Set(['sensorA']), sources: new Map([[source.sourceId, source]]),
  };
  return { draft, context, source };
}

async function rejected(draft: unknown, context: EvidenceContext, issue: string) {
  const result = await sealEvidenceDraft(draft, context);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues).toContain(issue);
}

describe('immutable UTF-8 source snapshots', () => {
  it('hashes exact bytes including BOM and CRLF, using independent Node SHA-256', async () => {
    const { source } = await fixture();
    expect(source.text).toBe(SOURCE);
    expect(source.sha256).toBe(createHash('sha256').update(Buffer.from(SOURCE)).digest('hex'));
    expect(Object.isFrozen(source)).toBe(true);
  });

  it.each(['a'.repeat(4_001), '😀'.repeat(4_001), '\ud800', '\udc00', '', 'a'.repeat(16_001)])('rejects invalid/oversized text %#', async (text) => {
    expect((await createSourceSnapshot({ ...SOURCE_INPUT, text })).ok).toBe(false);
  });

  it('accepts exactly 4000 supplementary characters (16000 UTF-8 bytes)', async () => {
    const result = await createSourceSnapshot({ ...SOURCE_INPUT, text: '😀'.repeat(4_000) });
    expect(result.ok).toBe(true);
  });

  it('does not accept a caller-supplied hash or reserved identifier', async () => {
    expect((await createSourceSnapshot({ ...SOURCE_INPUT, sha256: '0'.repeat(64) })).ok).toBe(false);
    expect((await createSourceSnapshot({ ...SOURCE_INPUT, sourceId: 'constructor' })).ok).toBe(false);
  });
});

describe('sidecar structure, bindings and byte spans', () => {
  it('seals and reloads a revision without accepting its claimed hash on faith', async () => {
    const { draft, context } = await fixture();
    const result = await sealEvidenceDraft(draft, context);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join(','));
    expect(result.value.evidenceHash).toBe(createHash('sha256').update(canonical(draft)).digest('hex'));
    expect(await validateEvidenceRevision(result.value, context)).toEqual(result);
    const invalid = await validateEvidenceRevision({ ...result.value, evidenceHash: '0'.repeat(64) }, context);
    expect(invalid).toEqual({ ok: false, issues: ['EVIDENCE_HASH_MISMATCH'] });
    expect(Object.isFrozen(result.value.claims[0])).toBe(true);
    draft.claims[0].text = 'Changed after validation';
    expect(result.value.claims[0].text).toBe('The timer lasts 20 seconds.');
  });

  it('binds hash to world, claims, source and review while ignoring object key order', async () => {
    const { draft } = await fixture();
    const before = await evidenceDigest(draft);
    const reordered = Object.fromEntries(Object.entries(draft).reverse()) as EvidenceDraft;
    expect(await evidenceDigest(reordered)).toBe(before);
    for (const mutate of [
      (copy: EvidenceDraft) => { copy.worldRevision = 'world_2'; },
      (copy: EvidenceDraft) => { copy.claims[0].text = 'A different rule'; },
      (copy: EvidenceDraft) => { copy.sources[0].sha256 = 'b'.repeat(64); },
    ]) {
      const copy = structuredClone(draft); mutate(copy);
      expect(await evidenceDigest(copy)).not.toBe(before);
    }
  });

  it.each([
    ['unknown property', (d: EvidenceDraft) => Object.assign(d, { arbitraryCode: 'execute()' }), 'EVIDENCE_SCHEMA_INVALID'],
    ['wrong version', (d: EvidenceDraft) => Object.assign(d, { schemaVersion: 'v99' }), 'EVIDENCE_SCHEMA_INVALID'],
    ['stale world', (d: EvidenceDraft) => { d.worldRevision = 'old_world'; }, 'STALE_WORLD_REVISION'],
    ['stale parent', (d: EvidenceDraft) => { d.parentEvidenceHash = 'a'.repeat(64); }, 'STALE_EVIDENCE_PARENT'],
    ['duplicate claim', (d: EvidenceDraft) => { d.claims.push(structuredClone(d.claims[0])); }, 'DUPLICATE_CLAIM'],
    ['duplicate binding', (d: EvidenceDraft) => { d.bindings.push(structuredClone(d.bindings[0])); }, 'DUPLICATE_BINDING'],
    ['missing claim', (d: EvidenceDraft) => { d.bindings[0].claimIds = ['missing']; }, 'BINDING_CLAIM_MISSING'],
    ['missing rule', (d: EvidenceDraft) => { d.bindings[0].target.id = 'missing'; }, 'BINDING_TARGET_MISSING'],
    ['wrong source hash', (d: EvidenceDraft) => { d.sources[0].sha256 = 'c'.repeat(64); }, 'SOURCE_SNAPSHOT_MISMATCH'],
    ['duplicate source', (d: EvidenceDraft) => { d.sources.push(d.sources[0]); }, 'DUPLICATE_SOURCE'],
  ] as const)('rejects %s', async (_name, mutate, code) => {
    const { draft, context } = await fixture(); mutate(draft);
    await rejected(draft, context, code);
  });

  it.each(['wrong excerpt', 'outside source', 'empty span', 'split UTF-8', 'unknown source'])('rejects %s', async (mode) => {
    const { draft, context } = await fixture();
    const claim = draft.claims[0];
    if (claim.support !== 'sourced') throw new Error('fixture');
    const span = claim.spans[0];
    if (mode === 'wrong excerpt') span.excerpt = '10 seconds';
    if (mode === 'outside source') span.endByte = 1_000;
    if (mode === 'empty span') span.endByte = span.startByte;
    if (mode === 'split UTF-8') { span.startByte = 1; span.endByte = 3; span.excerpt = '\ufffd'; }
    if (mode === 'unknown source') span.sourceId = 'missing';
    await rejected(draft, context, mode === 'unknown source' ? 'SPAN_SOURCE_MISSING' : 'SOURCE_SPAN_INVALID');
  });

  it('preserves a BOM at the start of a valid span', async () => {
    const { draft, context } = await fixture();
    const claim = draft.claims[0];
    if (claim.support !== 'sourced') throw new Error('fixture');
    claim.spans[0] = { sourceId: 'procedure', startByte: 0, endByte: 5, excerpt: '\ufeffČ' };
    expect((await sealEvidenceDraft(draft, context)).ok).toBe(true);
  });

  it('rehashes even a structurally valid source loaded from storage', async () => {
    const { draft, context, source } = await fixture();
    const fake = { ...source, sha256: 'd'.repeat(64) };
    draft.sources[0].sha256 = fake.sha256;
    await rejected(draft, { ...context, sources: new Map([[source.sourceId, fake]]) }, 'SOURCE_HASH_MISMATCH');
  });

  it('requires coverage for every surface rule supplied by the application', async () => {
    const { draft, context } = await fixture();
    await rejected(draft, { ...context, ruleIds: new Set(['start_countdown', 'unlock_case']) }, 'RULE_EVIDENCE_MISSING');
  });

  it('accepts an unchecked structural citation without pretending to prove entailment', async () => {
    const { draft, context } = await fixture();
    draft.claims[0].text = 'The source guarantees this outcome in real life.';
    const result = await sealEvidenceDraft(draft, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.claims[0].review.status).toBe('unchecked');
  });

  it('allows a source-free prompt only with explicit non-sourced claims', async () => {
    const { draft, context } = await fixture();
    draft.sources = [];
    await rejected(draft, context, 'SPAN_SOURCE_MISSING');
    draft.claims[0] = { claimId: 'duration', text: 'A 20 second timer.', support: 'assumed',
      reason: 'User prompt, no supporting source supplied.', interventionId: null, review: { status: 'unchecked' } };
    expect((await sealEvidenceDraft(draft, context)).ok).toBe(true);
  });

  it('bounds the whole source set, not just individual documents', async () => {
    const { draft, context } = await fixture();
    const sources = new Map(context.sources);
    for (const sourceId of ['extraA', 'extraB']) {
      const made = await createSourceSnapshot({ ...SOURCE_INPUT, sourceId, text: '😀'.repeat(2_500) });
      if (!made.ok) throw new Error('fixture');
      sources.set(sourceId, made.value);
      draft.sources.push({ sourceId, sha256: made.value.sha256 });
    }
    await rejected(draft, { ...context, sources }, 'SOURCE_TOTAL_TOO_LARGE');
  });

  it('accepts the declared claim limit and rejects one more claim', async () => {
    const { draft, context } = await fixture();
    for (let index = 1; index < 64; index += 1) draft.claims.push({ ...draft.claims[0], claimId: `claim${index}` });
    expect((await sealEvidenceDraft(draft, context)).ok).toBe(true);
    draft.claims.push({ ...draft.claims[0], claimId: 'overflow' });
    await rejected(draft, context, 'EVIDENCE_SCHEMA_INVALID');
  });

  it('validates entity bindings separately from rules and rejects duplicate references', async () => {
    const { draft, context } = await fixture();
    draft.bindings.push({ bindingId: 'sensor_binding', target: { kind: 'entity', id: 'sensorA' }, claimIds: ['duration'] });
    expect((await sealEvidenceDraft(draft, context)).ok).toBe(true);
    draft.bindings[1].target.id = 'missing';
    await rejected(draft, context, 'BINDING_TARGET_MISSING');
    draft.bindings[1].target.id = 'sensorA';
    draft.bindings[1].claimIds.push('duration');
    await rejected(draft, context, 'DUPLICATE_BINDING_CLAIM');
  });
});

describe('derived claims and independently authorized review', () => {
  it('accepts a non-cyclic derivation and rejects a missing premise or cycle', async () => {
    const { draft, context } = await fixture();
    draft.claims.push({ claimId: 'ticks', text: '400 ticks at 20 Hz', support: 'derived',
      premiseClaimIds: ['duration'], derivation: '20 * 20 = 400', review: { status: 'unchecked' }, interventionId: null });
    expect((await sealEvidenceDraft(draft, context)).ok).toBe(true);
    const derived = draft.claims[1];
    if (derived.support !== 'derived') throw new Error('fixture');
    derived.premiseClaimIds = ['missing'];
    await rejected(draft, context, 'PREMISE_MISSING');
    derived.premiseClaimIds = ['ticks'];
    await rejected(draft, context, 'CLAIM_CYCLE');
    draft.claims[0] = { ...derived, claimId: 'duration', premiseClaimIds: ['ticks'] };
    derived.premiseClaimIds = ['duration'];
    await rejected(draft, context, 'CLAIM_CYCLE');
  });

  it.each(['confirmed', 'disputed'] as const)('does not let the payload invent a %s review', async (status) => {
    const { draft, context } = await fixture();
    draft.claims[0].review = { status, reviewerId: 'reviewer', at: '2026-09-07T00:00:00Z', scope: 'textual-support' };
    await rejected(draft, context, 'REVIEW_NOT_AUTHORIZED');
    const digest = await evidenceDigest(draft);
    const reviewed = { ...context, reviewedRevisionHashes: new Set([digest]) };
    expect((await sealEvidenceDraft(draft, reviewed)).ok).toBe(true);
    draft.claims[0].text = 'The same reviewer allegedly approved this different claim.';
    await rejected(draft, reviewed, 'REVIEW_NOT_AUTHORIZED');
  });

  it('rejects both missing review metadata and review authority smuggled into the draft', async () => {
    const { draft, context } = await fixture();
    await rejected({ ...draft, reviewedRevisionHashes: ['a'.repeat(64)] }, context, 'EVIDENCE_SCHEMA_INVALID');
    draft.claims[0].review = { status: 'confirmed' } as never;
    await rejected(draft, context, 'EVIDENCE_SCHEMA_INVALID');
  });
});

describe('interventions are explicit and cannot inherit source support', () => {
  async function changed() {
    const setup = await fixture();
    const { draft } = setup;
    draft.worldRevision = 'world_2';
    draft.parentEvidenceHash = 'a'.repeat(64);
    draft.interventions = [{ interventionId: 'shorter', parentBranchId: 'origin', forkTick: 0,
      baseWorldRevision: 'world_1', ruleId: 'start_countdown', before: 400, after: 200, reason: 'User intervention in ticks.' }];
    draft.claims[0] = { claimId: 'duration', text: 'Use a 10 second limit in this branch.', support: 'assumed',
      reason: 'Counterfactual parameter, not a statement from the source.', interventionId: 'shorter', review: { status: 'unchecked' } };
    return { ...setup, context: { ...setup.context, worldRevision: 'world_2', parent: { branchId: 'origin', worldRevision: 'world_1', evidenceHash: 'a'.repeat(64) } } };
  }

  it('accepts an explicit assumption with a matching intervention and unchanged source', async () => {
    const { draft, context, source } = await changed();
    const result = await sealEvidenceDraft(draft, context);
    expect(result.ok).toBe(true);
    expect(source.text).toBe(SOURCE);
  });

  it.each([
    ['missing intervention', (d: EvidenceDraft) => { d.interventions = []; }, 'INTERVENTION_MISSING'],
    ['wrong base', (d: EvidenceDraft) => { d.interventions[0].baseWorldRevision = 'wrong'; }, 'INTERVENTION_BASE_MISMATCH'],
    ['wrong parent', (d: EvidenceDraft) => { d.interventions[0].parentBranchId = 'branch-99'; }, 'INTERVENTION_PARENT_MISMATCH'],
    ['wrong rule', (d: EvidenceDraft) => { d.interventions[0].ruleId = 'missing'; }, 'INTERVENTION_RULE_MISSING'],
    ['no change', (d: EvidenceDraft) => { d.interventions[0].after = 400; }, 'INTERVENTION_NO_CHANGE'],
    ['unbound intervention', (d: EvidenceDraft) => { d.claims[0].interventionId = null; }, 'INTERVENTION_UNBOUND'],
    ['entity binding', (d: EvidenceDraft) => { d.bindings[0].target = { kind: 'entity', id: 'sensorA' }; }, 'INTERVENTION_BINDING_MISMATCH'],
  ] as const)('rejects %s', async (_name, mutate, code) => {
    const { draft, context } = await changed(); mutate(draft);
    await rejected(draft, context, code);
  });

  it('rejects attaching the old citation to a changed claim', async () => {
    const { draft, context } = await changed();
    const original = await fixture();
    draft.claims[0] = { ...original.draft.claims[0], interventionId: 'shorter' };
    await rejected(draft, context, 'CHANGED_CLAIM_CANNOT_INHERIT_SOURCE');
  });

  it('accepts the identifiers actually produced by the existing BranchStore', async () => {
    const { draft, context } = await changed();
    draft.interventions[0].parentBranchId = 'branch-1';
    expect((await sealEvidenceDraft(draft, { ...context, parent: { ...context.parent, branchId: 'branch-1' } })).ok).toBe(true);
  });
});
