import type { WorldDoc } from '@/ir/worlddoc';
import { createBranchController, type BranchRequest } from './branch-controller';
import type { RuntimeController } from './runtime-controller';
import { createRuntimeController } from './runtime-controller';
import { buildRuntimeWorld } from '@/ir/build';
import { z } from 'zod';
import { MAX_COMPARISON_TICK } from './branch-controller';
export type { BranchComparison } from './branch-controller';

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
  return prepared.controller.compare({ base: prepared.base, accepted, ...ticks });
}

/** Bounded visitor history; certification traces are never substituted. */
export const comparisonCommitSchema = z.object({
  base: z.object({ simRevision: z.int().nonnegative(), simHash: z.string().max(128),
    comparisonRevision: z.int().refine(value => value === 0, 'A commit starts a new comparison.'),
    inputCount: z.int().min(0).max(MAX_COMPARISON_TICK) }).strict(),
  inputs: z.array(z.object({ tick: z.int().min(0).max(MAX_COMPARISON_TICK),
    actor: z.string().min(1).max(128), actionId: z.string().min(1).max(128),
    target: z.string().min(1).max(128).optional() }).strict()).max(MAX_COMPARISON_TICK),
  forkTick: z.int().min(0).max(MAX_COMPARISON_TICK),
  observationTick: z.int().min(0).max(MAX_COMPARISON_TICK),
}).strict().refine(value => value.inputs.every((input, index) => index === 0 || input.tick >= value.inputs[index - 1].tick),
  'Visitor inputs must be chronological.');
export type ComparisonCommit = z.infer<typeof comparisonCommitSchema>;

/** Pure pre-commit gate. The caller writes the accepted snapshot only on COMPARED. */
export function compareCommitCandidate(original: WorldDoc, accepted: WorldDoc, input: unknown) {
  const parsed = comparisonCommitSchema.safeParse(input);
  if (!parsed.success) return { verdict: 'REJECTED' as const, reason: 'INVALID_REQUEST' as const,
    detail: 'Expected a bounded chronological visitor history and comparison ticks.' };
  const built = buildRuntimeWorld(original.sim);
  if (!built.ok) return { verdict: 'REJECTED' as const, reason: 'RUNTIME_FAULT' as const,
    detail: 'The accepted original simulation cannot run.' };
  const source = createRuntimeController({ ...built.world, trace: parsed.data.inputs });
  return createBranchController(original, source).compare({ base: parsed.data.base, accepted,
    forkTick: parsed.data.forkTick, observationTick: parsed.data.observationTick });
}
