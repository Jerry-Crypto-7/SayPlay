import type { TraceInput, WorldDocRuntime } from '@/sim/interpreter';

export type RuntimeAction = Omit<TraceInput, 'tick'>;

/** Discover the canonical acted inputs already declared by the lowered IR.
 * Proximity and other rule guards remain the interpreter's responsibility.
 */
export function runtimeActions(document: WorldDocRuntime): readonly RuntimeAction[] {
  const actions = new Map<string, RuntimeAction>();
  for (const node of document.ir.nodes) {
    if (node.kind !== 'ref' || node.ref.space !== 'pulse' || node.ref.fact !== 'acted') continue;
    const [actor, actionId, target] = node.ref.args;
    if (!actor || !actionId) continue;
    const action = Object.freeze({ actor, actionId, ...(target && target !== 'none' ? { target } : {}) });
    actions.set(JSON.stringify(action), action);
  }
  return Object.freeze([...actions.values()]);
}

export function sameAction(a: RuntimeAction, b: RuntimeAction): boolean {
  return a.actor === b.actor && a.actionId === b.actionId && a.target === b.target;
}
