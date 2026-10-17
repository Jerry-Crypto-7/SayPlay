/**
 * Pokrytí podstatných jmen katalogem (P26A T7): commitnutý artefakt musí být
 * to, co dnes spočítá `modelOf` arkády, CC0 modely ho musí ostře zvednout a
 * každé nově pokryté jméno musí pocházet z výběru `selection.json`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import selection from '../../../scripts/assets/cc0/selection.json';
import { exactModel, measureCoverage, SETS, stateOf } from '../catalog-coverage';

const artefact = JSON.parse(readFileSync(fileURLToPath(new URL('../catalog-coverage.json', import.meta.url)), 'utf8'));
const coverage = measureCoverage();

describe('catalog coverage of sentence nouns', () => {
  it('matches the committed evals/play/catalog-coverage.json', () => {
    const { states, ...measured } = artefact;
    expect(measured).toEqual(JSON.parse(JSON.stringify(coverage)));
    expect(states.now).toEqual(JSON.parse(JSON.stringify(stateOf(coverage))));
  });

  // P26A T12: dnešní `modelOf` nad katalogem před CC0, po T7 a teď, po sadách vět zvlášť.
  it('covers strictly more nouns now than after T7, and after T7 no fewer than before CC0', () => {
    const { states } = artefact;
    const [before, afterT7, now] = [states['before-CC0 (7c411db)'], states['after-T7 (e0aa52c)'], states.now];
    expect(now.nouns.now).toBeGreaterThan(afterT7.nouns.now);
    expect(now.mentions.now).toBeGreaterThan(afterT7.mentions.now);
    expect(afterT7.nouns.now).toBeGreaterThanOrEqual(before.nouns.now);
    expect(now.models).toBeGreaterThan(afterT7.models);
  });

  it('reports the demand corpus, the fidelity set and its 10 hostile sentences apart', () => {
    expect(coverage.sentences).toEqual({ demand: 200, fidelity: 30 });
    for (const set of SETS) expect(coverage.bySet[set].mentions, set).toBeGreaterThan(0);
    expect(coverage.bySet.hostile.mentions).toBeLessThan(coverage.bySet.fidelity.mentions);
    expect(coverage.bySet.demand.mentions + coverage.bySet.fidelity.mentions).toBe(coverage.mentions.mentions);
  });

  it('covers strictly more role nouns with CC0 models than without', () => {
    expect(coverage.nouns.now).toBeGreaterThan(coverage.nouns.before);
    expect(coverage.mentions.now).toBeGreaterThan(coverage.mentions.before);
    expect(coverage.nouns.now - coverage.nouns.before).toBe(coverage.gained.length);
  });

  it('gains only nouns that selection.json picked a CC0 model for', () => {
    const picked = new Set(selection.selected.flatMap((entry) => [entry.noun, ...(entry.synonyms ?? []), ...(entry.tags ?? [])]));
    for (const { noun, model } of coverage.gained) {
      // Přesná shoda smí jít i přes hlavu fráze („spinning log“ → `log`), stejně jako v `exactModel`.
      expect(picked.has(noun) || picked.has(noun.split(' ').at(-1)!), noun).toBe(true);
      expect(model, noun).toMatch(/^cc0-/);
    }
  });

  it('does not count an alias or a missing model as exact', () => {
    // Vlkodlak má od 1909e75d vlastní model z gen3d, alias na goblina teď drží démon.
    expect(exactModel('demon')).toEqual({ model: 'goblin', exact: false });
    // Vzducholoď má od P46F model z gen3d (`gen3d-blimp`), chybějící věc je teď periskop.
    expect(exactModel('periscope')).toEqual({ model: undefined, exact: false });
    expect(exactModel('robot')).toEqual({ model: 'robot', exact: true });
  });
});
