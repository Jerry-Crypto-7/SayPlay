/**
 * Měřidlo P47B (T2): ruční štítek přebije regex P46, past s akcí ve hře je
 * `spurious` a zahozená akce nese důvod. Měřidlo, které past počítá jako
 * splněnou akci, ukáže pokrok, který hráč neuvidí.
 */
import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';

import { wantedActions } from '../../p46/actions';
import { dropReason, verbRow, verbRowOf, verbSentences, verbSummary } from '../actions';

const RUNNER = 'A rabbit runs through a meadow and jumps over logs';

describe('P47B action gauge', () => {
  it('lets the hand label beat the P46 regex', async () => {
    const text = 'a builder stacks wooden blocks into a tall tower';
    expect(wantedActions(text)).toContain('shield');
    const row = await verbRow({ id: 't', text, wants: [] });
    expect(row.wanted).toEqual([]);
    expect(row.wantsAction).toBe(false);
    expect(row.trap).toBe(true);
  });

  it('counts an action the trap does not want as spurious', async () => {
    const meta = draftGameSpecWithMeta(RUNNER, 1);
    const row = await verbRowOf({ id: 't', text: RUNNER, wants: [] }, { ...meta, spec: { ...meta.spec, control: 'runner', abilities: ['shield'] } }, 5);
    expect(row.spurious).toEqual(['shield']);
    expect(verbSummary([row]).spuriousRate).toBe(1);
  });

  it('does not count the genre’s own mechanic as spurious', async () => {
    const meta = draftGameSpecWithMeta(RUNNER, 1);
    const { abilities: _a, ...spec } = meta.spec;
    const row = await verbRowOf({ id: 't', text: RUNNER, wants: [] }, { ...meta, spec: { ...spec, control: 'runner', addons: [] } }, 5);
    expect(row.spurious).toEqual([]);
  });

  it('gives a dropped action the reason the composition recorded', async () => {
    const text = 'A rabbit runs through a meadow and dodges falling acorns';
    const meta = draftGameSpecWithMeta(text, 1);
    const { abilities: _a, ...spec } = meta.spec;
    const composition = { ...meta.composition!, issues: ['runner.default: verbs_proved: VERB_UNPROVED:dash – no rule with the verb "dash" fired while the bot played'] };
    const row = await verbRowOf({ id: 't', text, wants: ['dash'] }, { ...meta, spec: { ...spec, control: 'runner' }, composition }, 5);
    expect(row.hasAction).toBe(false);
    expect(row.dropped).toEqual([{ action: 'dash', reason: 'VERB_UNPROVED:dash' }]);
  });

  it('names the lexicon, a control or a generator that drops the action', () => {
    const { spec } = draftGameSpecWithMeta(RUNNER, 1);
    const dodge = 'A rabbit runs and dodges logs';
    expect(dropReason('dash', RUNNER, { spec })).toBe('lexicon misses the verb');
    expect(dropReason('dash', dodge, { spec: { ...spec, control: 'shooter' } })).toBe('control shooter takes no dash');
    expect(dropReason('dash', dodge, { spec: { ...spec, control: 'move_free', controlParams: { generator: 'fight' } } as typeof spec })).toBe('generator fight takes no abilities');
  });

  it('summarises p95 draft time and keeps the holdout shut without the flag', () => {
    expect(() => verbSentences('holdout', { env: {} })).toThrow(/P47B_OPEN_HOLDOUT/);
    expect(verbSentences('dev').every((s) => s.wants !== undefined)).toBe(true);
    expect(verbSentences('p46a').every((s) => s.wants === undefined)).toBe(true);
    const rows = [1, 2, 3, 4, 100].map((draftMs, i) => ({ id: String(i), wanted: [], present: [], wantsAction: false, hasAction: false, botUsed: false, verbFired: false, playable: true, issues: [], control: 'runner', trap: false, dropped: [], spurious: [], draftMs }));
    expect(verbSummary(rows).draftMsP95).toBe(100);
  });
});
