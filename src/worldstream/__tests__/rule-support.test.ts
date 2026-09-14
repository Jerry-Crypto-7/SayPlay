import { describe, expect, it } from 'vitest';
import museum from '../../../evals/reality-compiler/museum.sim.json';
import oracle from '../../../evals/reality-compiler/oracle.json';
import { buildRuntimeWorld } from '../../ir/build';
import { sealSimHash } from '../../ir/worlddoc';
import { COMPONENT_EVIDENCE_VERSION, sealEvidenceDraft, type EvidenceContext, type EvidenceDraft } from '../evidence';
import { createEvidenceProject } from '../evidence-commit';
import { decodeSourceProject, encodeSourceProject } from '../project-storage';
import { ruleSupportParts } from '../rule-support';
import { createRuntimeController } from '../runtime-controller';
import { sourceInputs } from '../source-input';
import { PARAMETER_KEYS, parameterProposalHash } from '../source-parameters';

// Scripted structural fixture, deliberately not a semantic review of the museum.
async function fixture() {
  const sim = structuredClone(museum);
  const made = await sourceInputs({ sourceId: 'procedure', title: 'Scripted museum',
    text: '\ufeffPůvodní podklad.\r\n', mediaType: 'text/plain', origin: 'provided', rights: 'unreviewed' },
  '\ufeffDoplnění: časovač běží 20 sekund.\r\n');
  if (!made.ok) throw new Error(made.issues.join(','));
  const sources = made.value;
  const context: EvidenceContext = { worldRevision: 'proposal', parent: null,
    sources: new Map(sources.map(source => [source.sourceId, source])), rules: sim.rules,
    ruleIds: new Set(Object.keys(sim.rules)), entityIds: new Set(Object.keys(sim.entities)) };
  const draft: EvidenceDraft = { schemaVersion: COMPONENT_EVIDENCE_VERSION, worldRevision: 'proposal',
    parentEvidenceHash: null, sources: sources.map(({ sourceId, sha256 }) => ({ sourceId, sha256 })),
    interventions: [], claims: sources.map((source, i) => ({ claimId: `claim_${i}`,
      text: `Scripted claim ${i}; not independently reviewed.`, support: 'sourced',
      review: { status: 'unchecked' }, interventionId: null,
      spans: [{ sourceId: source.sourceId, startByte: 0, endByte: Buffer.byteLength(source.text), excerpt: source.text }] })),
    bindings: ruleSupportParts(sim.rules).map((part, i) => ({ bindingId: `binding_${i}`,
      target: { kind: 'rule', id: part.ruleId }, part: part.part, declarationHash: part.declarationHash,
      claimIds: [part.ruleId === 'start_countdown' && part.part === 'action.1' ? 'claim_1' : 'claim_0'] })) };
  return { sim, sources, context, draft };
}

describe('component evidence selectors', () => {
  it.each(['operands', 'of', 'clauses'])('enumerates nested %s conditions and not aliases in executable order', alias => {
    const first = { kind: 'flagIs', ref: 'ready', value: true };
    const second = { kind: 'timerRunning', ref: 'timer' };
    const rules = { sample: { event: { kind: 'onStart' }, condition: { kind: 'allOf', [alias]: [
      first, { kind: 'not', of: { kind: 'anyOf', clauses: [second, { kind: 'not', operand: first }] } },
    ] }, actions: [{ kind: 'setFlag', ref: 'done', value: true }, { kind: 'win' }] } };
    const parts = ruleSupportParts(rules);
    expect(parts.map(part => part.part)).toEqual(['event', 'condition', 'condition.0', 'condition.1',
      'condition.1.0', 'condition.1.0.0', 'condition.1.0.1', 'condition.1.0.1.0', 'action.0', 'action.1']);
    expect(parts.find(part => part.part === 'condition.1.0.0')!.declaration).toEqual(second);
    expect(new Set(parts.map(part => part.declarationHash)).size).toBe(parts.length);
  });

  it('uses lowerer alias precedence when multiple child properties exist', () => {
    const primary = { kind: 'flagIs', ref: 'primary' };
    const ignored = { kind: 'flagIs', ref: 'ignored' };
    const parts = ruleSupportParts({ rule: { event: { kind: 'onStart' },
      condition: { kind: 'allOf', operands: [{ kind: 'not', operand: primary, of: ignored }], of: [ignored] },
      actions: [{ kind: 'win' }] } });
    expect(parts.find(part => part.part === 'condition.0.0')!.declaration).toEqual(primary);
    expect(parts).toHaveLength(5);
  });

  it.each(['missing', 'duplicate', 'foreign-rule', 'foreign-part', 'action-range', 'condition-range', 'hash'])(
    'rejects %s component references before sealing', async fault => {
      const { draft, context } = await fixture();
      if (fault === 'missing') draft.bindings.splice(1, 1);
      if (fault === 'duplicate') draft.bindings.push({ ...draft.bindings[0], bindingId: 'duplicate' });
      if (fault === 'foreign-rule') draft.bindings[0].target.id = 'unknown_rule';
      if (fault === 'foreign-part') draft.bindings[0].part = 'event.constructor';
      if (fault === 'action-range') draft.bindings[0].part = 'action.999';
      if (fault === 'condition-range') draft.bindings[0].part = 'condition.999';
      if (fault === 'hash') draft.bindings[0].declarationHash = 'stale';
      const result = await sealEvidenceDraft(draft, context);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Unexpected accepted evidence');
      const expected = fault === 'missing' ? 'RULE_SUPPORT_MISSING' : fault === 'duplicate'
        ? 'RULE_SUPPORT_DUPLICATE' : fault === 'hash' ? 'RULE_SUPPORT_STALE' : fault === 'foreign-part'
          ? 'EVIDENCE_SCHEMA_INVALID' : 'RULE_SUPPORT_TARGET_INVALID';
      expect(result.issues).toContain(expected);
    });

  it.each(['leaf', 'boolean'])('rejects stale %s declaration fingerprints', async mutation => {
    const { draft, context, sim } = await fixture();
    const nested = { kind: 'allOf', operands: [{ kind: 'flagIs', ref: 'ready', value: true }] };
    const originalRules = { sample: { event: { kind: 'onStart' }, condition: nested, actions: [{ kind: 'win' }] } };
    const originalParts = ruleSupportParts(originalRules);
    draft.bindings = originalParts.map((part, i) => ({ bindingId: `b_${i}`, target: { kind: 'rule', id: 'sample' },
      part: part.part, declarationHash: part.declarationHash, claimIds: ['claim_0'] }));
    if (mutation === 'leaf') nested.operands[0].value = false;
    else nested.kind = 'anyOf';
    const updatedParts = ruleSupportParts(originalRules);
    expect(updatedParts.find(part => part.part === 'condition.0')!.declarationHash)
      .not.toBe(originalParts.find(part => part.part === 'condition.0')!.declarationHash);
    const result = await sealEvidenceDraft(draft, { ...context, rules: originalRules, ruleIds: new Set(['sample']),
      entityIds: new Set(Object.keys(sim.entities)) });
    expect(result).toEqual({ ok: false, issues: ['RULE_SUPPORT_STALE'] });
  });
});

describe('component project intervention and restoration', () => {
  it('changes only the timer action support and restores original/supplement bytes with unchecked reviews', async () => {
    const { draft, context, sim, sources } = await fixture();
    const evidence = await sealEvidenceDraft(draft, context);
    if (!evidence.ok) throw new Error(evidence.issues.join(','));
    const world = sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim,
      look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } });
    const store = createEvidenceProject();
    const accepted = await store.commitInitial({ base: null, world, sources, evidence: evidence.value,
      parameterConfirmation: { version: 'source-parameters-v1', confirmed: [...PARAMETER_KEYS],
        proposalHash: await parameterProposalHash(sim, sources, evidence.value) } });
    if (!accepted.ok) throw new Error(accepted.issues.join(','));
    const root = accepted.value;
    const built = buildRuntimeWorld(sim); if (!built.ok) throw new Error('museum');
    const runtime = createRuntimeController({ ...built.world, trace: oracle.cases[0].inputs });
    runtime.observeAt(300); runtime.setPaused(true);
    const changed = await store.commitIntervention({ base: root.projectRevision, ruleId: 'start_countdown',
      durationTicks: 200, forkTick: 0, observationTick: 300, reason: 'Scripted intervention.' }, runtime);
    if (!changed.ok) throw new Error(changed.issues.join(','));
    const head = changed.value;
    const differences = head.evidence.bindings.filter((binding, index) =>
      JSON.stringify(binding) !== JSON.stringify(root.evidence.bindings[index]));
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ target: { kind: 'rule', id: 'start_countdown' }, part: 'action.1' });
    const intervention = head.evidence.claims.find(claim => claim.interventionId !== null)!;
    expect(differences[0].claimIds).toEqual([intervention.claimId]);
    expect(intervention).toMatchObject({ support: 'assumed', review: { status: 'unchecked' } });
    expect(head.evidence.claims.slice(0, root.evidence.claims.length)).toEqual(root.evidence.claims);
    expect(head.comparison!.original.values).toMatchObject({ 'e:case:locked': 0, 'f:alarm': 0 });
    expect(head.comparison!.changed.values).toMatchObject({ 'e:case:locked': 1, 'f:alarm': 1 });
    const changedWorld = buildRuntimeWorld(head.world.sim); if (!changedWorld.ok) throw new Error('changed museum');
    const fork = runtime.forkAt(changedWorld.world, 0, 300); if (fork.verdict !== 'REBRANCHED') throw new Error('fork');
    const runtimes = new Map([[root, runtime], [head, fork.controller]]);
    const restored = await decodeSourceProject(encodeSourceProject(head, head, runtimes, 'fixture'));
    expect(restored.head).toEqual(head);
    expect(restored.head.parent).toEqual(root);
    expect(restored.selected.projectRevision).toBe(head.projectRevision);
    expect(restored.head.sources.map(source => Buffer.from(source.text)))
      .toEqual(sources.map(source => Buffer.from(source.text)));
    expect(restored.head.sources[1].origin).toBe('user-supplement');
    expect(restored.head.evidence.claims.every(claim => claim.review.status === 'unchecked')).toBe(true);
    expect(restored.runtimes.get(restored.selected)!.getSnapshot().values)
      .toEqual(fork.controller.getSnapshot().values);
  });
});
