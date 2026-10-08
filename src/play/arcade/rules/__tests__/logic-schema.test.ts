/**
 * P45B T3: blok `logic` a kostky jazyka pravidel v2 – co se přečte a co se odmítne s cestou.
 *
 * Validace, která pustí fázi bez vstupu nebo neznámou proměnnou, vypadá v pořádku a vyrobí
 * hru, kterou robot nikdy nedohraje – proto test na každou odmítací cestu.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { draftForControl } from '@/play/draft';
import { genreSpecSchema } from '@/play/genre/contract';
import { readGameSpec } from '@/play/spec';

import { modelRulesSchema, ruleDoSchema, ruleIfSchema, ruleWhenSchema } from '../schema';
import { RULE_TEMPLATES, TEMPLATE_NAMES, expandTemplate } from '../templates';

const base = draftForControl('a cat collects fish in the garden', 'move_free')!;
const roles = [...base.roles, { id: 'bat', kind: 'chaser' as const, label: 'bat', count: 1 }, { id: 'gem', kind: 'collectible' as const, label: 'gem', count: 1 }];

/** Hra se vším: klid → vlna, odpočet, počet zásahů, poplach. */
const LOGIC = { vars: [{ id: 'hits', start: 0 }], timers: [{ id: 'clock' }], phases: [{ id: 'calm' }, { id: 'wave' }], events: ['alarm'] };
const RULES = [
  { id: 'go', verb: 'start', when: { phase: 'calm' }, do: [{ startTimer: { timer: 'clock', ticks: 300 } }] },
  { id: 'rush', verb: 'rush', when: { timer: 'clock' }, do: [{ goPhase: 'wave' }, { wave: { role: 'bat', count: 3, at: 'edge' } }] },
  { id: 'bang', verb: 'hit', when: { contact: ['player', 'bat'] }, if: [{ inPhase: 'wave' }], do: [{ add: { var: 'hits', amount: 1 } }, { emit: 'alarm' }, { despawn: 'other' }] },
  { id: 'ring', verb: 'ring', when: { event: 'alarm' }, if: [{ timerStopped: 'clock' }], do: [{ score: 1 }] },
  { id: 'won', verb: 'win', when: { var: { name: 'hits', atLeast: 3 } }, do: [{ win: true }] },
];

const specWith = (logic: unknown, rules: unknown) => readGameSpec({ ...base, roles, ...(logic === undefined ? {} : { logic }), ...(rules === undefined ? {} : { rules }) });
const issuesOf = (logic: unknown, rules: unknown): string[] => {
  const read = specWith(logic, rules);
  return read.ok ? [] : [...read.issues];
};

describe('logic block and rule constructs v2', () => {
  it('reads a spec with every new construct', () => {
    const read = specWith(LOGIC, RULES);
    expect(read.ok ? null : read.issues).toBeNull();
    if (read.ok) expect(read.value.logic).toEqual(LOGIC);
  });

  it('parses all 5 triggers, 4 conditions and 7 effects', () => {
    const whens = [{ timer: 't' }, { phase: 'p' }, { phaseExit: 'p' }, { var: { name: 'v', atLeast: 2 } }, { event: 'e' }];
    const ifs = [{ var: { name: 'v', below: 1 } }, { inPhase: 'p' }, { timerRunning: 't' }, { timerStopped: 't' }];
    const dos = [{ set: { var: 'v', value: -5 } }, { add: { var: 'v', amount: 2 } }, { goPhase: 'p' }, { startTimer: { timer: 't', ticks: 60 } }, { stopTimer: 't' }, { emit: 'e' }, { wave: { role: 'bat', count: 8, at: 'player' } }];
    for (const when of whens) expect(ruleWhenSchema.safeParse(when).success, JSON.stringify(when)).toBe(true);
    for (const cond of ifs) expect(ruleIfSchema.safeParse(cond).success, JSON.stringify(cond)).toBe(true);
    for (const effect of dos) expect(ruleDoSchema.safeParse(effect).success, JSON.stringify(effect)).toBe(true);
    // Jen celá čísla v mezích, žádné výrazy.
    expect(ruleDoSchema.safeParse({ add: { var: 'v', amount: 1.5 } }).success).toBe(false);
    expect(ruleDoSchema.safeParse({ set: { var: 'v', value: 'hits+1' } }).success).toBe(false);
    expect(ruleDoSchema.safeParse({ wave: { role: 'bat', count: 9, at: 'edge' } }).success).toBe(false);
    expect(ruleDoSchema.safeParse({ startTimer: { timer: 't', ticks: 0 } }).success).toBe(false);
  });

  it('bounds the block: ≤ 8 vars, ≤ 4 timers, 2–4 phases, ≤ 8 events', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}` }));
    expect(issuesOf({ ...LOGIC, vars: many(9) }, RULES).some((issue) => issue.startsWith('/logic/vars'))).toBe(true);
    expect(issuesOf({ ...LOGIC, timers: many(5) }, RULES).some((issue) => issue.startsWith('/logic/timers'))).toBe(true);
    expect(issuesOf({ ...LOGIC, phases: [{ id: 'calm' }] }, RULES).some((issue) => issue.startsWith('/logic/phases'))).toBe(true);
    expect(issuesOf({ ...LOGIC, phases: many(5) }, RULES).some((issue) => issue.startsWith('/logic/phases'))).toBe(true);
    expect(issuesOf({ ...LOGIC, events: many(9).map(({ id }) => id) }, RULES).some((issue) => issue.startsWith('/logic/events'))).toBe(true);
  });

  describe('rejects with a path', () => {
    const swap = (index: number, rule: object) => RULES.map((old, i) => (i === index ? rule : old));

    it('an unknown var, timer, phase or event name', () => {
      expect(issuesOf(LOGIC, swap(1, { ...RULES[1], when: { timer: 't9' } }))).toContain('/rules/1/when/timer: unknown timer t9');
      expect(issuesOf(LOGIC, swap(4, { ...RULES[4], when: { var: { name: 'lives', atLeast: 1 } } }))).toContain('/rules/4/when/var/name: unknown var lives');
      expect(issuesOf(LOGIC, swap(2, { ...RULES[2], if: [{ inPhase: 'boss' }] }))).toContain('/rules/2/if/0/inPhase: unknown phase boss');
      expect(issuesOf(LOGIC, swap(3, { ...RULES[3], when: { event: 'siren' } }))).toContain('/rules/3/when/event: unknown event siren');
    });

    it('logic in a rule when the game declares no logic', () => {
      const plain = [{ id: 'won', verb: 'win', when: { contact: ['player', 'gem'] }, do: [{ add: { var: 'hits', amount: 1 } }, { win: true }] }];
      expect(issuesOf(undefined, plain)).toContain('/rules/0/do/0/add/var: var hits used, but the game declares no logic block');
    });

    it('a phase no rule leads into (the first one is the start)', () => {
      const issues = issuesOf({ ...LOGIC, phases: [...LOGIC.phases, { id: 'boss' }] }, RULES);
      expect(issues).toContain('/logic/phases/2: no rule enters phase boss – add a rule with {"goPhase":"boss"}');
      expect(issues.some((issue) => issue.includes('phase calm'))).toBe(false);
    });

    it('an event nobody emits or nobody listens to', () => {
      expect(issuesOf({ ...LOGIC, events: ['alarm', 'quiet'] }, RULES)).toEqual(expect.arrayContaining(['/logic/events/1: no rule emits event quiet', '/logic/events/1: no rule listens to event quiet – add a rule with {"when":{"event":"quiet"}}']));
      const unheard = swap(3, { id: 'ring', verb: 'ring', when: { press: 'action' }, do: [{ score: 1 }] });
      expect(issuesOf(LOGIC, unheard)).toContain('/logic/events/0: no rule listens to event alarm – add a rule with {"when":{"event":"alarm"}}');
    });

    it('a timer nobody starts (stopping and reading it is not starting)', () => {
      const unstarted = swap(0, { id: 'go', verb: 'stop', when: { phase: 'calm' }, do: [{ stopTimer: 'clock' }] });
      expect(issuesOf(LOGIC, unstarted)).toContain('/logic/timers/0: no rule starts timer clock – add a rule with {"startTimer":{"timer":"clock","ticks":…}}');
    });

    it('a wave of the player, and a wave "at other" without a body', () => {
      expect(issuesOf(LOGIC, swap(1, { ...RULES[1], do: [{ goPhase: 'wave' }, { wave: { role: 'player', count: 2, at: 'edge' } }] }))).toContain('/rules/1/do/1/wave/role: the player cannot come in a wave');
      expect(issuesOf(LOGIC, swap(1, { ...RULES[1], do: [{ goPhase: 'wave' }, { wave: { role: 'bat', count: 2, at: 'other' } }] }))).toContain('/rules/1/do/1/wave/at: "other" needs a contact, a hit or a near condition');
      expect(issuesOf(LOGIC, swap(1, { ...RULES[1], do: [{ goPhase: 'wave' }, { wave: { role: 'ghost', count: 2, at: 'edge' } }] }))).toContain('/rules/1/do/1/wave/role: unknown role ghost');
    });

    it('a var bound with both or neither of atLeast and below', () => {
      expect(issuesOf(LOGIC, swap(4, { ...RULES[4], when: { var: { name: 'hits' } } }))).toContain('/rules/4/when/var: give exactly one of atLeast or below');
      expect(issuesOf(LOGIC, swap(3, { ...RULES[3], if: [{ var: { name: 'hits', atLeast: 1, below: 5 } }] }))).toContain('/rules/3/if/0/var: give exactly one of atLeast or below');
    });

    it('a name declared twice', () => {
      expect(issuesOf({ ...LOGIC, vars: [{ id: 'hits' }, { id: 'hits' }] }, RULES)).toContain('/logic/vars/1: var hits declared twice');
    });

    it('a logic block without rules', () => {
      expect(issuesOf(LOGIC, undefined)).toEqual(['/logic: a logic block needs rules that read and change it']);
      expect(issuesOf(LOGIC, [])).toEqual(['/logic: a logic block needs rules that read and change it']);
    });
  });

  it('GenreSpec carries logic for the director', () => {
    const genre = { genre: 'quest', mode: 'spatial', hero: 'cat', setting: 'garden', rules: RULES, logic: LOGIC };
    const parsed = genreSpecSchema.safeParse(genre);
    expect(parsed.success ? parsed.data.logic : parsed.error.issues).toEqual(LOGIC);
  });

  it('reads the 6 recorded rule answers and the 6 templates unchanged', () => {
    const dir = 'src/play/director/__fixtures__/rules-answers';
    const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(6);
    for (const file of files) {
      const answer = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { answer: { rules: { if: unknown }[] } }).answer;
      const rules = answer.rules.map(({ if: cond, ...rule }) => (cond === null ? rule : { ...rule, if: cond }));
      const parsed = modelRulesSchema.safeParse(rules);
      expect(parsed.success ? parsed.data : parsed.error.issues, file).toEqual(rules);
    }
    // Šest šablon P29A je první v tabulce; ty s logikou (T8) hlídá `templates.test.ts`.
    expect(TEMPLATE_NAMES.slice(0, 6)).toEqual(['carry', 'throw', 'push', 'open', 'give', 'stack']);
    for (const name of TEMPLATE_NAMES.slice(0, 6)) {
      const rules = expandTemplate(name, { item: 'gem', goal: 'bat', target: 'bat', lever: 'gem', door: 'bat' })!;
      const parsed = modelRulesSchema.safeParse(rules);
      expect(parsed.success ? parsed.data : parsed.error.issues, name).toEqual(rules);
      expect(RULE_TEMPLATES[name].rules.length).toBeGreaterThan(0);
    }
  });
});
