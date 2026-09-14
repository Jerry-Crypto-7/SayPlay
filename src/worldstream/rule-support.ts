/** Selectors address executable declarations, not arbitrary object properties. */
import { canonicalHash } from '../ir/worlddoc';
import { sourceRulesSchema } from './source-parameters';

export interface RuleSupportPart {
  readonly ruleId: string;
  readonly part: string;
  readonly declaration: unknown;
  readonly declarationHash: string;
}

export function ruleSupportParts(input: unknown): RuleSupportPart[] {
  const rules = sourceRulesSchema.parse(input);
  const parts: RuleSupportPart[] = [];
  for (const [ruleId, rule] of Object.entries(rules)) {
    const add = (part: string, declaration: unknown, context?: unknown) => {
      parts.push({ ruleId, part, declaration, declarationHash: canonicalHash({ ruleId, part, declaration, context: context ?? null }) });
    };
    add('event', rule.event);
    const visit = (node: Record<string, unknown>, path: string, depth: number) => {
      if (depth > 32 || parts.length >= 4096) throw new Error('RULE_SUPPORT_TOO_LARGE');
      // The whole condition binds leaf support to its actual boolean context.
      add(path, node, rule.condition);
      if (node.kind === 'allOf' || node.kind === 'anyOf') {
        const children = node.operands ?? node.of ?? node.clauses;
        if (!Array.isArray(children)) throw new Error('RULE_SUPPORT_INVALID');
        children.forEach((child, index) => visit(child, `${path}.${index}`, depth + 1));
      } else if (node.kind === 'not') {
        const child = node.operand ?? node.of;
        if (!child || typeof child !== 'object') throw new Error('RULE_SUPPORT_INVALID');
        visit(child as Record<string, unknown>, `${path}.0`, depth + 1);
      }
    };
    visit(rule.condition, 'condition', 0);
    rule.actions.forEach((action, index) => add(`action.${index}`, action));
  }
  return parts;
}

export function supportPartLabel(part: string): string {
  if (part === 'event') return 'Trigger';
  if (part === 'condition') return 'Complete condition';
  if (part.startsWith('condition.')) return `Condition ${part.slice(10).split('.').map(value => Number(value) + 1).join('.')}`;
  return `Action ${Number(part.slice(7)) + 1}`;
}
