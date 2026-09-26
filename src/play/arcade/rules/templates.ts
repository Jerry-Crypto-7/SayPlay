/**
 * Hotová pravidla pro nejčastější slovesa bez dílku (P29A T10): nést, hodit,
 * strčit, otevřít/zatáhnout, dát, stohovat. Šablona je jméno + role, které
 * doplní hra (`item`, `goal`, …); `expandTemplate` z ní udělá pravidla jazyka
 * (`schema.ts`), stejná, jaká by napsal režisér. `verbs` jsou slova věty, na
 * která šablona sedí – podle nich měří pokrytí `evals/play/rules/coverage.ts`.
 */

import type { Rule } from './schema';

/** Místo pro roli hry, kterou šablona potřebuje. */
export type TemplateSlot = 'item' | 'goal' | 'target' | 'lever' | 'door';

export interface RuleTemplate {
  /** Slova věty, na která šablona sedí (základní tvar, anglicky). */
  readonly verbs: readonly string[];
  readonly slots: readonly TemplateSlot[];
  /** Pravidla s `$slot` místo role. */
  readonly rules: readonly Rule[];
}

const S = (slot: TemplateSlot): string => `$${slot}`;

export const RULE_TEMPLATES = {
  carry: {
    verbs: ['carry', 'bring', 'deliver', 'fetch', 'haul', 'transport', 'grab'],
    slots: ['item', 'goal'],
    rules: [
      { id: 'take', verb: 'carry', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'deliver', verb: 'deliver', when: { contact: ['player', S('goal')] }, if: [{ holding: S('item') }], do: [{ despawn: 'held' }, { score: 1 }, { win: true }] },
    ],
  },
  throw: {
    verbs: ['throw', 'toss', 'hurl', 'lob', 'fling'],
    slots: ['item', 'target'],
    rules: [
      { id: 'pick', verb: 'pick', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'throw', verb: 'throw', when: { press: 'action' }, if: [{ holding: S('item') }], do: [{ throwHeld: true }] },
      { id: 'hit', verb: 'hit', when: { contact: [S('item'), S('target')] }, do: [{ score: 1 }, { win: true }] },
    ],
  },
  push: {
    verbs: ['push', 'shove', 'nudge', 'kick'],
    slots: ['item', 'goal'],
    rules: [
      { id: 'push', verb: 'push', when: { contact: ['player', S('item')] }, do: [{ push: 'other' }] },
      { id: 'place', verb: 'place', when: { contact: [S('item'), S('goal')] }, do: [{ win: true }] },
    ],
  },
  open: {
    verbs: ['open', 'pull', 'unlock', 'flip'],
    slots: ['lever', 'door', 'goal'],
    rules: [
      { id: 'pull', verb: 'pull', when: { contact: ['player', S('lever')] }, do: [{ toggle: S('door') }] },
      { id: 'pass', verb: 'pass', when: { contact: ['player', S('goal')] }, do: [{ win: true }] },
    ],
  },
  give: {
    verbs: ['give', 'hand', 'offer', 'feed', 'serve'],
    slots: ['item', 'goal'],
    rules: [
      { id: 'pick', verb: 'pick', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'give', verb: 'give', when: { contact: ['player', S('goal')] }, if: [{ holding: S('item') }], do: [{ despawn: 'held' }, { score: 1 }, { win: true }] },
    ],
  },
  stack: {
    verbs: ['stack', 'pile', 'heap'],
    slots: ['item', 'goal'],
    rules: [
      { id: 'pick', verb: 'pick', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'stack', verb: 'stack', when: { contact: ['player', S('goal')] }, if: [{ holding: S('item') }], do: [{ despawn: 'held' }, { count: { counter: 'items', amount: 1 } }] },
      { id: 'tall', verb: 'finish', when: { counter: { name: 'items', atLeast: 3 } }, do: [{ win: true }] },
    ],
  },
} as const satisfies Readonly<Record<string, RuleTemplate>>;

export type TemplateName = keyof typeof RULE_TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(RULE_TEMPLATES) as TemplateName[];

/** Šablona s rolemi hry místo `$slot`; chybějící role = `null`. */
export function expandTemplate(name: TemplateName, roles: Readonly<Partial<Record<TemplateSlot, string>>>): Rule[] | null {
  const template: RuleTemplate = RULE_TEMPLATES[name];
  if (template.slots.some((slot) => roles[slot] === undefined)) return null;
  const text = JSON.stringify(template.rules).replace(/"\$(item|goal|target|lever|door)"/g, (_, slot: TemplateSlot) => JSON.stringify(roles[slot]));
  return JSON.parse(text) as Rule[];
}

/** Šablona, jejíž sloveso věta obsahuje (první podle pořadí `RULE_TEMPLATES`), jinak `null`. */
export function templateFor(sentence: string): TemplateName | null {
  const words = sentence.toLowerCase().match(/[a-z]+/g) ?? [];
  const has = (verb: string): boolean => words.some((word) => word === verb || word === `${verb}s` || word === `${verb}es` || word === `${verb}ing` || word === `${verb.replace(/e$/, '')}ing` || word === `${verb}ed`);
  return TEMPLATE_NAMES.find((name) => RULE_TEMPLATES[name].verbs.some(has)) ?? null;
}
