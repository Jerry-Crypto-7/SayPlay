/**
 * Fakta panelu „How this game works“: věty čtené člověkem, ne JSON. Panel
 * vypadá hotově i s „Winnable“ u hry, kterou nikdo nedohrál – tohle drží,
 * že nedoložená výhra je „Not proven“ a zpráva dvojníka se hlásí jako stub.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { QualityReport } from '@/play/contracts';
import { readGameSpec } from '@/play/spec';

import { labFacts } from '../lab';

const spec = (() => {
  const read = readGameSpec(JSON.parse(readFileSync('src/play/__fixtures__/collect_exit.json', 'utf8')));
  if (!read.ok) throw new Error(read.reason);
  return read.value;
})();

const REPORT: QualityReport = {
  specHash: 'a',
  worldHash: 'b',
  keypoints: [
    { assertionId: 'k1', mechanicId: 'collectible', passed: true, hashBefore: '', hashAfter: '', ticks: 3, failures: [] },
    { assertionId: 'k2', mechanicId: 'zone_trigger', passed: false, hashBefore: '', hashAfter: '', ticks: 3, failures: ['x'] },
  ],
  witness: { certified: true, winsAtTick: 42 },
  replayEqual: true,
  budgets: { entities: 3, rules: 2, triangles: null },
  publishEligible: true,
};

describe('labFacts', () => {
  it('every mechanic of the spec with its registry sentence and readable params', () => {
    const facts = labFacts(spec, REPORT);
    expect(facts.mechanics.map((mechanic) => mechanic.id)).toEqual(spec.mechanics.map((mechanic) => mechanic.id));
    for (const mechanic of facts.mechanics) {
      expect(mechanic.explanation.length).toBeGreaterThan(10);
      for (const [, value] of mechanic.params) expect(value).not.toMatch(/[{}[\]"]/);
    }
  });

  it('counts passed keypoints, names the winning tick, reports replay', () => {
    expect(labFacts(spec, REPORT)).toMatchObject({ rulesChecked: 'Rules checked: 1/2', winnable: 'Winnable at tick 42', replay: 'Replay: identical' });
  });

  it('an uncertified witness is Not proven and a stub report says stub', () => {
    const facts = labFacts(spec, { ...REPORT, witness: { certified: false, winsAtTick: 42 }, stub: true } as QualityReport & { stub: true });
    expect(facts.winnable).toBe('Not proven');
    expect(facts.replay).toBe('Replay: stub');
  });
});
