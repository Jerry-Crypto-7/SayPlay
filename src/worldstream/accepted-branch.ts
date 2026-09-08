import { canonical, simHashOf, worldDocSchema, type WorldDoc } from '@/ir/worlddoc';
import { createBranchController, type BranchRequest } from './branch-controller';
import type { RuntimeController } from './runtime-controller';

/** Capture the document and visitor log before asking for a change preview. */
export function prepareBranch(document: WorldDoc, source: RuntimeController) {
  const original = structuredClone(document);
  const controller = createBranchController(original, source);
  return { original, source, controller, base: controller.getBase() };
}
export type PreparedBranch = ReturnType<typeof prepareBranch>;

/** Only an accepted snapshot can supply the new value, never the preview prose.
 * Map keys are the identity; an optional embedded ID must remain unchanged.
 * The HTTP patch validator is deliberately not relaxed for map-only documents.
 */
export function compareAcceptedBranch(prepared: PreparedBranch, accepted: WorldDoc,
  ticks: Pick<BranchRequest, 'forkTick' | 'observationTick'>) {
  const reject = (detail: string) => ({ verdict: 'REJECTED' as const, detail });
  const parsed = worldDocSchema.safeParse(accepted);
  if (!parsed.success || parsed.data.simHash !== simHashOf(parsed.data)) return reject('Invalid accepted simulation.');
  const next = parsed.data;
  const original = prepared.original;
  if (next.simRevision !== original.simRevision + 1 || next.lookRevision !== original.lookRevision
    || canonical(next.look) !== canonical(original.look)) return reject('Comparison requires one simulation revision and unchanged appearance.');
  // Discover one scalar difference, then compare the complete simulation after
  // restoring it. Extra edits, deleted rules and re-ordered actions cannot hide.
  const rules = original.sim.rules as Record<string, { actions?: { kind?: string; durationTicks?: number }[] }>;
  const nextRules = next.sim.rules as typeof rules;
  const candidates: { ruleId: string; index: number; durationTicks: number }[] = [];
  for (const [ruleId, rule] of Object.entries(rules)) {
    if (!Array.isArray(rule.actions)) continue;
    rule.actions.forEach((action, index) => {
      const changed = nextRules[ruleId]?.actions?.[index];
      if (action.kind === 'startTimer' && changed?.kind === 'startTimer'
        && typeof changed.durationTicks === 'number' && action.durationTicks !== changed.durationTicks) {
        candidates.push({ ruleId, index, durationTicks: changed.durationTicks });
      }
    });
  }
  if (candidates.length !== 1) return reject('Comparison supports a single timer duration change.');
  const target = candidates[0];
  const restored = structuredClone(next.sim);
  (restored.rules as typeof rules)[target.ruleId].actions![target.index].durationTicks =
    rules[target.ruleId].actions![target.index].durationTicks;
  if (canonical(restored) !== canonical(original.sim)) return reject('The accepted change also modifies other simulation data.');
  return prepared.controller.compare({ base: prepared.base, ruleId: target.ruleId,
    durationTicks: target.durationTicks, ...ticks });
}
