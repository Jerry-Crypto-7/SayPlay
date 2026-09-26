/**
 * Jazyk pravidel ve `GameSpec` (P29A T1): platné pravidlo projde, vadné spadne
 * **s cestou** – opravné kolo režiséra potřebuje vědět, které pole opravit.
 */

import { describe, expect, it } from 'vitest';

import arena from '../arcade/__fixtures__/arena.json';
import { RULES_MAX } from '../arcade/rules/schema';
import { readGameSpec } from '../spec';

const base = {
  ...arena,
  roles: [
    { id: 'player', kind: 'player', label: 'knight' },
    { id: 'key', kind: 'key', label: 'golden key' },
    { id: 'door', kind: 'door', label: 'castle door' },
    { id: 'exit', kind: 'exit', label: 'tower stairs' },
  ],
};

const carry = { id: 'carry_key', verb: 'carry', when: { contact: ['player', 'key'] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] };
const open = { id: 'open_door', verb: 'open', when: { contact: ['player', 'door'] }, if: [{ holding: 'key' }], do: [{ toggle: 'door' }, { despawn: 'held' }] };
const leave = { id: 'leave', verb: 'escape', when: { contact: ['player', 'exit'] }, do: [{ win: true }] };

function issuesOf(spec: unknown): { reason: string; issues: readonly string[] } {
  const result = readGameSpec(spec);
  if (result.ok) throw new Error('expected a rejection');
  return result;
}

describe('rules in GameSpec', () => {
  it('accepts a valid rule set with things and keeps it on the read spec', () => {
    const result = readGameSpec({ ...base, rules: [carry, open, leave], things: [{ role: 'door', start: 'present' }] });
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.value.rules).toHaveLength(3);
    expect(result.value.rules?.[1]?.do).toEqual([{ toggle: 'door' }, { despawn: 'held' }]);
    expect(result.value.things).toEqual([{ role: 'door', start: 'present' }]);
  });

  it('accepts every trigger, condition and effect of the language', () => {
    const rules = [
      { id: 'a', verb: 'pull', when: { press: 'action' }, if: [{ near: { role: 'door', within: 2 } }], do: [{ toggle: 'door' }] },
      { id: 'b', verb: 'wait', when: { every: 60 }, do: [{ score: 1 }] },
      { id: 'c', verb: 'collect', when: { counter: { name: 'items', atLeast: 3 } }, if: [{ counter: { name: 'score', below: 5 } }], do: [{ count: { counter: 'items', amount: -3 } }] },
      { id: 'd', verb: 'hit', when: { hit: 'door' }, do: [{ despawn: 'other' }, { spawn: { role: 'key', at: 'other' } }] },
      { id: 'e', verb: 'throw', when: { press: 'alt' }, if: [{ holding: 'key' }], do: [{ throwHeld: true }] },
      { id: 'f', verb: 'drop', when: { contact: ['key', 'exit'] }, do: [{ push: 'self' }, { checkpoint: 'other' }, { release: true }] },
      { id: 'g', verb: 'fall', when: { contact: ['player', 'door'] }, do: [{ damage: 1 }, { respawn: true }, { lose: true }] },
    ];
    const result = readGameSpec({ ...base, rules });
    expect(result.ok ? 'ok' : result.issues.join('; ')).toBe('ok');
  });

  it('keeps specs without rules byte-identical (no default is written in)', () => {
    const result = readGameSpec(arena);
    if (!result.ok) throw new Error('arena fixture must read');
    expect('rules' in result.value).toBe(false);
    expect('things' in result.value).toBe(false);
  });

  it('rejects an unknown body role with the path of the reference', () => {
    const bad = { ...leave, when: { contact: ['player', 'dragon'] } };
    const { reason, issues } = issuesOf({ ...base, rules: [bad] });
    expect(reason).toBe('DANGLING_REFERENCE');
    expect(issues).toContain('/rules/0/when/contact/1: unknown role dragon');
  });

  it('rejects an unknown role in a condition, a toggle and a thing', () => {
    const bad = { ...open, if: [{ holding: 'sword' }], do: [{ toggle: 'gate' }] };
    const { issues } = issuesOf({ ...base, rules: [bad], things: [{ role: 'bridge', start: 'hidden' }] });
    expect(issues).toEqual(['/rules/0/if/0/holding: unknown role sword', '/rules/0/do/0/toggle: unknown role gate', '/things/0/role: unknown role bridge']);
  });

  it('rejects an effect outside the language with a path', () => {
    const { reason, issues } = issuesOf({ ...base, rules: [{ ...leave, do: [{ teleport: 'exit' }] }] });
    expect(reason).toBe('MALFORMED_SPEC');
    expect(issues.some((issue) => issue.startsWith('/rules/0/do/0'))).toBe(true);
  });

  it('rejects a trigger outside the language with a path', () => {
    const { reason, issues } = issuesOf({ ...base, rules: [{ ...leave, when: { swipe: 'left' } }] });
    expect(reason).toBe('MALFORMED_SPEC');
    expect(issues.some((issue) => issue.startsWith('/rules/0/when'))).toBe(true);
  });

  it(`rejects more than RULES_MAX (${RULES_MAX}) rules`, () => {
    const rules = Array.from({ length: RULES_MAX + 1 }, (_, i) => ({ ...leave, id: `r${i}` }));
    const { reason, issues } = issuesOf({ ...base, rules });
    expect(reason).toBe('MALFORMED_SPEC');
    expect(issues.some((issue) => issue.startsWith('/rules:'))).toBe(true);
    expect(readGameSpec({ ...base, rules: rules.slice(0, RULES_MAX) }).ok).toBe(true);
  });

  it('rejects a rule without a verb, and a verb that is not one word', () => {
    const { verb: _verb, ...noVerb } = leave;
    expect(issuesOf({ ...base, rules: [noVerb] }).issues.some((issue) => issue.startsWith('/rules/0/verb'))).toBe(true);
    expect(issuesOf({ ...base, rules: [{ ...leave, verb: 'run away' }] }).issues.some((issue) => issue.startsWith('/rules/0/verb'))).toBe(true);
  });

  it('rejects integer-only violations: fractions and out-of-range amounts', () => {
    expect(issuesOf({ ...base, rules: [{ ...leave, do: [{ score: 1.5 }] }] }).reason).toBe('MALFORMED_SPEC');
    expect(issuesOf({ ...base, rules: [{ ...leave, when: { every: 0 } }] }).reason).toBe('MALFORMED_SPEC');
  });

  it('rejects rules on a grid game', () => {
    const { control: _control, controlParams: _params, ...grid } = base;
    const { issues } = issuesOf({ ...grid, rules: [leave] });
    expect(issues).toContain('/rules: only an arcade game (any control but tap_go) takes rules');
  });

  it('rejects "other" and "self" where the trigger has no such body', () => {
    const noOther = { id: 'x', verb: 'grab', when: { press: 'action' }, do: [{ grab: 'other' }] };
    const noSelf = { ...carry, do: [{ push: 'self' }] };
    const { issues } = issuesOf({ ...base, rules: [noOther, noSelf] });
    expect(issues).toEqual(['/rules/0/do/0: "other" needs a contact, a hit or a near condition', '/rules/1/do/0: "self" is the first role of a contact that is not the player']);
  });

  it('rejects a counter condition with both or neither bound, and duplicate ids', () => {
    const both = { ...leave, if: [{ counter: { name: 'items', atLeast: 1, below: 3 } }] };
    const { issues } = issuesOf({ ...base, rules: [both, both] });
    expect(issues).toContain('/rules/0/if/0/counter: give exactly one of atLeast or below');
    expect(issues).toContain('/rules/1/id: rule leave declared twice');
  });
});
