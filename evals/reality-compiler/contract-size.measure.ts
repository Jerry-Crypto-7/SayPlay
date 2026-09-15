/** Offline wire-size experiment; no model request and no semantic verdict. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import sim from './museum.sim.json';
import { componentProposalBindingSchema, evidenceDraftSchema } from '../../src/worldstream/evidence';
import { ruleSupportParts } from '../../src/worldstream/rule-support';

it('measures only the removal of model-written mechanical binding IDs', () => {
  const parts = ruleSupportParts(sim.rules);
  const after = parts.map(({ ruleId, part }) => ({ target: { kind: 'rule', id: ruleId }, part, claimIds: ['fixture'] }));
  const before = after.map((binding, index) => ({ ...binding, bindingId: `binding_${index}` }));
  const oldSchema = componentProposalBindingSchema.extend({ bindingId: evidenceDraftSchema.shape.bindings.element.shape.bindingId });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const result = { kind: 'offline-wire-size', sample: 'scripted-museum-components', bindingCount: parts.length,
    schemaBytes: { before: bytes(z.toJSONSchema(oldSchema)), after: bytes(z.toJSONSchema(componentProposalBindingSchema)) },
    bindingArrayBytes: { before: bytes(before), after: bytes(after) }, modelCalls: 0, modelLatencyMs: null,
    semanticReview: 'NOT_RUN', note: 'Only binding IDs differ. This is not a model latency or total-prompt comparison against evidence-v1.' };
  expect(result.schemaBytes.after).toBeLessThan(result.schemaBytes.before);
  expect(result.bindingArrayBytes.after).toBeLessThan(result.bindingArrayBytes.before);
  mkdirSync('scratch', { recursive: true });
  writeFileSync('scratch/source-contract-size.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
});
