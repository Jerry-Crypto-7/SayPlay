import { canonical, simHashOf, worldDocSchema, type WorldDoc } from '@/ir/worlddoc';

export interface RuleIntervention {
  readonly kind: 'condition' | 'action' | 'timer';
  readonly ruleId: string;
  readonly actionIndex?: number;
  readonly before: unknown;
  readonly after: unknown;
  readonly timerId?: string;
  readonly previousDurationTicks?: number;
  readonly durationTicks?: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Exactly one existing rule condition or action can change. Everything else,
 * including declarations, trigger, rule order/identity and appearance, is fixed.
 * Runtime lowering and rebranch shape checks remain separate mandatory gates. */
export function readAcceptedIntervention(original: WorldDoc, input: unknown):
  { ok: true; document: WorldDoc; change: RuleIntervention } | { ok: false; detail: string } {
  const reject = (detail: string) => ({ ok: false as const, detail });
  const parsed = worldDocSchema.safeParse(input);
  if (!parsed.success || parsed.data.simHash !== simHashOf(parsed.data)) return reject('Invalid accepted simulation.');
  const next = parsed.data;
  if (next.simRevision !== original.simRevision + 1 || next.lookRevision !== original.lookRevision
    || canonical(next.look) !== canonical(original.look)) return reject('Comparison requires one simulation revision and unchanged appearance.');
  const rules = record(original.sim.rules);
  const nextRules = record(next.sim.rules);
  if (!rules || !nextRules || canonical(Object.keys(rules)) !== canonical(Object.keys(nextRules)))
    return reject('Rule identities and order must remain unchanged.');
  const changed = Object.keys(rules).filter((id) => canonical(rules[id]) !== canonical(nextRules[id]));
  if (changed.length !== 1) return reject('Comparison requires one existing rule intervention.');
  const ruleId = changed[0];
  const before = record(rules[ruleId]);
  const after = record(nextRules[ruleId]);
  if (!before || !after || (Object.hasOwn(before, 'id') && before.id !== ruleId)
    || (Object.hasOwn(after, 'id') && after.id !== ruleId)) return reject('Rule identity does not match its map key.');
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const fields = [...keys].filter((key) => Object.hasOwn(before, key) !== Object.hasOwn(after, key) || canonical(before[key]) !== canonical(after[key]));
  if (fields.length !== 1 || !['condition', 'actions'].includes(fields[0]))
    return reject('Only an existing rule condition or one action may change; triggers and metadata are fixed.');
  const restored = structuredClone(next.sim);
  (restored.rules as Record<string, unknown>)[ruleId] = structuredClone(before);
  if (canonical(restored) !== canonical(original.sim)) return reject('The accepted change also modifies other simulation data.');
  if (fields[0] === 'condition') return { ok: true, document: next,
    change: { kind: 'condition', ruleId, before: before.condition, after: after.condition } };
  if (!Array.isArray(before.actions) || !Array.isArray(after.actions) || before.actions.length !== after.actions.length)
    return reject('Replace one existing action; adding, deleting or reordering actions is outside this intervention.');
  const indices = before.actions.flatMap((action, index) => canonical(action) === canonical((after.actions as unknown[])[index]) ? [] : [index]);
  if (indices.length !== 1) return reject('Replace exactly one existing action.');
  const actionIndex = indices[0];
  const oldAction = record(before.actions[actionIndex]);
  const newAction = record(after.actions[actionIndex]);
  const change: RuleIntervention = { kind: 'action', ruleId, actionIndex,
    before: before.actions[actionIndex], after: after.actions[actionIndex] };
  if (oldAction?.kind === 'startTimer' && newAction?.kind === 'startTimer'
    && typeof oldAction.ref === 'string' && typeof oldAction.durationTicks === 'number' && typeof newAction.durationTicks === 'number'
    && canonical({ ...newAction, durationTicks: oldAction.durationTicks }) === canonical(oldAction))
    return { ok: true, document: next, change: { ...change, kind: 'timer', timerId: oldAction.ref,
      previousDurationTicks: oldAction.durationTicks, durationTicks: newAction.durationTicks } };
  return { ok: true, document: next, change };
}
