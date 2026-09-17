/** Read-only replay of the two captured compiler responses. No model transport. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileBlueprint } from '@/model/worldstream-compiler';
import { readPlannerEmission } from '@/model/worldstream-intent';
import { buildRepairRequest } from '@/model/worldstream-repair';
import type { UpstreamRequest } from '@/model/prompt';

it('replays every captured hybrid compiler attempt without silently fixing authored events', () => {
  const path = 'plans/P20/hybrid-live-20260917-1550/calls.json';
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const calls = JSON.parse(raw) as { request: UpstreamRequest; result: { body: any } }[];
  const plan = readPlannerEmission(calls[0].result.body);
  if (!plan.ok) throw new Error(plan.detail);
  const rows = calls.slice(1).map((call, index) => {
    const original = compileBlueprint(call.result.body, plan.value, { sessionSeed: 4021, upstream: call.request });
    const edited = structuredClone(call.result.body);
    for (const rule of Object.values(edited.world.sim.rules) as any[]) if (rule.event.kind === 'onClick')
      rule.event = { kind: 'onAction', actor: 'firstPerson', actionId: 'activate', target: 'computerTerminal' };
    const counterexample = compileBlueprint(edited, plan.value, { sessionSeed: 4021, upstream: call.request });
    return { attempt: index + 1, original, counterexampleProvenance: 'manual diagnostic event substitution only; not a new model response',
      counterexample, feedback: original.ok ? null : buildRepairRequest(call.request, call.result.body, original).user };
  });
  const output = 'plans/P20/hybrid-live-20260917-1550/input-contract-replay.json';
  writeFileSync(output, JSON.stringify({ provenance: 'archived replay, no model calls',
    callsSha256: createHash('sha256').update(raw).digest('hex'), rows }, null, 2), { flag: 'wx' });
  expect(rows).toHaveLength(2);
  expect(rows.every(row => !row.original.ok)).toBe(true);
});
