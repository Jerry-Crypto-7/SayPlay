import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { confusedOf, FLAT, MAX_NOUNS, panelHeroesWithoutModel, parseList, pickNouns, pickFromRepo } from '../pick-nouns.mjs';

const ROOT = path.resolve(__dirname, '../../..');
const row = (noun: string, sentences: number) => ({ noun, category: null, sentences, sources: ['dev'], examples: [] });

describe('pick-nouns (P45D T16)', () => {
  it('orders panel heroes first, then sentence count, then the nouns the P43 judge confused', () => {
    const missing = [row('robber', 2), row('lizard', 1), row('mole', 1), row('wolf', 0), row('orca', 0), row('statue', 0)];
    const picked = pickNouns({ missing, heroes: ['mole'], confused: ['statue', 'orca'], notModels: new Set() });
    expect(picked.map((entry) => entry.noun)).toEqual(['mole', 'robber', 'lizard', 'statue', 'orca']);
    expect(picked.map((entry) => entry.why)).toEqual(['hero', 'demand', 'demand', 'confused', 'confused']);
  });

  it('never picks a hero the catalog already draws – a missing hero model there is a choice bug, not a generator job', () => {
    const picked = pickNouns({ missing: [row('mole', 1)], heroes: ['unicorn', 'mole'], confused: [], notModels: new Set() });
    expect(picked.map((entry) => entry.noun)).toEqual(['mole']);
  });

  it('drops phenomena, scenery and noise listed in not-models.txt', () => {
    const notModels = parseList(readFileSync(path.join(ROOT, 'scripts/p45d/not-models.txt'), 'utf8'));
    for (const noun of ['fire', 'rain', 'puddle', 'mar', 'wind']) expect(notModels.has(noun)).toBe(true);
    const picked = pickNouns({ missing: [row('fire', 4), row('mar', 3), row('rain', 2), row('puddle', 1), row('hippo', 1)], heroes: ['fire'], confused: ['puddle'], notModels });
    expect(picked.map((entry) => entry.noun)).toEqual(['hippo']);
  });

  it('caps the pick and carries a body class and a flat flag per noun', () => {
    const missing = Array.from({ length: 90 }, (_, index) => row(`thing ${index}`, 1));
    expect(pickNouns({ missing, heroes: [], confused: [], notModels: new Set() })).toHaveLength(MAX_NOUNS);
    const [orca, receipt, mole, crossbow] = pickNouns({ missing: [row('orca', 1), row('receipt', 1), row('mole', 1), row('crossbow', 1)], heroes: [], confused: [], notModels: new Set() });
    expect(orca).toMatchObject({ noun: 'orca', class: 'swimmer', flat: false });
    expect(receipt).toMatchObject({ noun: 'receipt', class: 'prop', flat: true });
    expect(mole.class).toBe('quadruped');
    expect(crossbow).toMatchObject({ class: 'prop', flat: false });
    expect(FLAT.has('playing card')).toBe(true);
  });

  it('reads the 37 nouns the P43 judge mistook for something else', () => {
    const confused = confusedOf(readFileSync(path.join(ROOT, 'evals/play/p43/gen3d.md'), 'utf8'));
    expect(confused).toHaveLength(37);
    expect(confused.slice(0, 2)).toEqual(['paper ball', 'spy']);
    expect(confused).toContain('orca');
    expect(confused).toContain('jetpack');
  });

  it('takes the panel heroes without a model from the baseline', () => {
    const panel = { sentences: [{ id: 'a', text: '', checklist: [{ item: 'mole', slot: 'hero' }] }, { id: 'b', text: '', checklist: [{ item: 'cat', slot: 'hero' }] }] };
    const baseline = { rows: [{ id: 'a', heroModel: false }, { id: 'b', heroModel: true }] };
    expect(panelHeroesWithoutModel(baseline, panel)).toEqual(['mole']);
  });

  it('picks from the real repo nothing the catalog already covers', () => {
    // Pokrytí ze snímku, ze kterého se vybíralo – živý katalog už vybraná jména
    // kreslí, protože je P45E vygeneroval a povýšil.
    const snapshot = JSON.parse(readFileSync(path.join(ROOT, 'evals/play/p45d/missing.json'), 'utf8'));
    const covered = new Set(snapshot.covered.map((entry: { noun: string }) => entry.noun));
    const picked = pickFromRepo();
    expect(picked.length).toBeGreaterThan(20);
    expect(picked.length).toBeLessThanOrEqual(MAX_NOUNS);
    expect(picked.filter((entry) => covered.has(entry.noun))).toEqual([]);
    expect(picked.slice(0, 2).map((entry) => `${entry.noun}=${entry.class}`).sort()).toEqual(['cyclops=biped', 'mole=quadruped']);
    expect(new Set(picked.map((entry) => entry.noun)).size).toBe(picked.length);
  });
});
