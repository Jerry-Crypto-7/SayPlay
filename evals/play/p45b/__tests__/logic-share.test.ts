import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import { DEV_SETS, logicUse, measureSentence, openSet, summarize } from '../logic-share';

/** Hra s logikou: proměnná, časovač, fáze, událost a vlna (tvar `rules/schema.ts` po P45B T3). */
const withLogic = {
  logic: { vars: [{ id: 'hits', start: 0 }], timers: [{ id: 'clock' }], phases: [{ id: 'calm' }, { id: 'wave' }], events: ['alarm'] },
  rules: [
    { id: 'go', verb: 'start', when: { every: 60 }, do: [{ startTimer: { timer: 'clock', ticks: 300 } }] },
    { id: 'rush', verb: 'rush', when: { timer: 'clock' }, do: [{ goPhase: 'wave' }, { wave: { role: 'bat', count: 3, at: 'edge' } }] },
    { id: 'bang', verb: 'hit', when: { contact: ['player', 'bat'] }, do: [{ add: { var: 'hits', amount: 1 } }, { emit: 'alarm' }] },
  ],
};

describe('P45B logic-share gauge', () => {
  it('counts a game with a logic block and a logic rule only when verification lets it play', () => {
    expect(logicUse(withLogic, true)).toEqual({ usesLogic: true, constructs: ['var', 'timer', 'phase', 'event', 'wave'] });
    // Robot hru nedohrál → podíl ji nepočítá, i když logiku deklaruje.
    expect(logicUse(withLogic, false).usesLogic).toBe(false);
  });

  it('needs both the declaration and a rule that touches it', () => {
    const declaredOnly = { logic: withLogic.logic, rules: [{ id: 'win', verb: 'touch', when: { contact: ['player', 'goal'] }, do: [{ win: true }] }] };
    expect(logicUse(declaredOnly, true).usesLogic).toBe(false);
    const { logic: _logic, ...rulesOnly } = withLogic;
    expect(logicUse(rulesOnly, true)).toEqual({ usesLogic: false, constructs: ['wave'] });
    expect(logicUse({ rules: [] }, true)).toEqual({ usesLogic: false, constructs: [] });
  });

  it('reads each logic key as a logic rule: a condition alone counts', () => {
    const conditionOnly = { logic: { phases: [{ id: 'a' }, { id: 'b' }] }, rules: [{ id: 'r', verb: 'go', when: { press: 'action' }, if: [{ inPhase: 'b' }], do: [{ win: true }] }] };
    expect(logicUse(conditionOnly, true)).toEqual({ usesLogic: true, constructs: ['phase'] });
  });

  it('refuses sealed and test sets and never names them in its sources', () => {
    expect(() => openSet('evals/play/p30/test-200.json')).toThrow(/sealed or test set/);
    expect(() => openSet('evals/play/p44c/sealed-110.json')).toThrow(/sealed or test set/);
    expect(() => openSet('evals/play/p30/test-opened.json')).toThrow(/sealed or test set/);
    for (const path of DEV_SETS) expect(openSet(path).length).toBeGreaterThan(0);
    for (const file of ['evals/play/p45b/logic-share.ts', 'evals/play/p45b/logic-share.measure.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/test-200|sealed-|round6\//);
    }
  });

  describe('on a real instant draft', () => {
    beforeAll(async () => { await loadRapier(); });

    it('measures a sentence: playable, timed, and today without logic', () => {
      const row = measureSentence('t', 'a cat collects fish in the garden');
      expect(row.playable).toBe(true);
      expect(row.ms).toBeGreaterThanOrEqual(0);
      expect(row.usesLogic).toBe(false);
      const summary = summarize([row]);
      expect(summary).toMatchObject({ sentences: 1, playable: 1, usesLogic: 0, logicSharePct: 0 });
    });
  });
});
