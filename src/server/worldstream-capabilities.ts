/** Public WORLDSTREAM renderer capability, not the generic WorldDoc contract.
 * Look fields are stored by the IR but are not consumed by this renderer. */
import type { RefinePlan } from '../model/worldstream-refine';
import { pointerFault, pointerTokens } from '../patch/reject';
import { applyPatch } from 'rfc6902';

export const APPEARANCE_UNSUPPORTED = 'Appearance palette, material, lighting and atmosphere edits are not supported in this renderer. Shape edits remain available; nothing was changed.';

export function hasUnsupportedAppearance(plan: Pick<RefinePlan, 'appearance' | 'behavior'>): boolean {
  const lookPath = (path: unknown) => typeof path === 'string' && (path === '/look' || path.startsWith('/look/'));
  return plan.appearance.length > 0 || plan.behavior.some(operation =>
    lookPath(operation.path) || ('from' in operation && lookPath(operation.from)));
}

export const MOTION_UNSUPPORTED = 'Entity motion such as swaying is not supported by this runtime. Nothing was changed. Request a shape change or a supported rule change.';
export const SHAPE_ONLY_MOTION_SUMMARY = 'Only the shape will change. Entity motion such as swaying is not supported. Behavior stays unchanged.';

/** The legacy entity.motion field is retained in archives, but buildRuntimeWorld
 * does not lower it. Inspect decoded paths and ancestor values, including copy
 * sources, so an enclosing entity replacement cannot promise invisible motion. */
export function hasUnsupportedMotion(plan: Pick<RefinePlan, 'behavior'>, world: unknown): boolean {
  if (plan.behavior.length === 0) return false;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const ownsMotion = (value: unknown) => record(value) && Object.hasOwn(value, 'motion');
  const carriesMotion = (path: readonly string[], value: unknown): boolean => {
    if (path[0] !== 'sim') return false;
    if (path.length === 1) return record(value) && carriesMotion(['sim', 'entities'], value.entities);
    if (path[1] !== 'entities') return false;
    if (path.length === 2) return record(value) && Object.values(value).some(ownsMotion);
    if (path.length === 3) return ownsMotion(value);
    return path[3] === 'motion';
  };
  // Patches are ordered: a later copy can read a value created by an earlier
  // operation. Inspect the same sequence, on an isolated JSON draft only.
  let draft: unknown;
  try { draft = structuredClone(world); } catch { return false; }
  const read = (path: readonly string[]): unknown => path.reduce<unknown>((value, token) =>
    (record(value) || Array.isArray(value)) && Object.hasOwn(value, token)
      ? (value as Record<string, unknown>)[token] : undefined, draft);
  for (const operation of plan.behavior) {
    if (typeof operation.path !== 'string') return false; // malformed operations belong to the patch gate
    const path = pointerTokens(operation.path);
    if (carriesMotion(path, 'value' in operation ? operation.value : undefined)) return true;
    if ('from' in operation) {
      if (typeof operation.from !== 'string') return false;
      const from = pointerTokens(operation.from);
      const value = read(from);
      if (carriesMotion(from, value) || carriesMotion(path, value)) return true;
    }
    try {
      // Reject malformed/unsafe pointers before rfc6902 can reinterpret them.
      // This is capability inspection, not an alternate acceptance gate.
      if (pointerFault(draft, operation) !== null) return false;
      const failures = applyPatch(draft as object, [structuredClone(operation)]);
      if (failures.some(failure => failure !== null && failure !== undefined)) return false;
    } catch { return false; }
  }
  return false;
}
