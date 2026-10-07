import { describe, expect, it } from 'vitest';

import { loadInputs, missingNouns, SETS, sentencesOf } from '../missing-nouns.mjs';

/** Přihrádka slova nad skutečnými větami a katalogem repa. */
const result = missingNouns(loadInputs());
const binOf = (noun: string): string | undefined =>
  (['covered', 'undrawable', 'missing', 'settings', 'unclassified'] as const).find((bin) => result[bin].some((row) => row.noun === noun));

describe('missing-nouns (P37D T1)', () => {
  it('lists a noun the sentences use and the catalog cannot draw', () => {
    // Lupiče P43 T12 vygeneroval, ale soudce model odmítl jako rozbitý; dvě věty ho chtějí.
    // (Dřív tu byl provaz – ten P43 T12 do knihovny dostal.)
    expect(binOf('robber')).toBe('missing');
    expect(result.missing.find((row) => row.noun === 'robber')?.sentences).toBeGreaterThanOrEqual(2);
  });

  it('treats a catalog tag as covered, plural included', () => {
    // „acorn“ z příkladu v plánu knihovna už má (`gen3d-acorn`), proto drak a zombie;
    // žábu přidal pilot P37D (`gen3d-frog`, T3).
    expect(binOf('frog')).toBe('covered');
    expect(binOf('dragon')).toBe('covered');
    expect(binOf('zombie')).toBe('covered');
    expect(binOf('zombies')).toBeUndefined();
  });

  it('covers a checklist item through a match word the jury accepts', () => {
    // „space marine“ katalog nemá, ale `match` uzná „soldier“ a ten rigovaný rytíř nese.
    expect(binOf('space marine')).toBe('covered');
    expect(binOf('marine')).toBeUndefined();
  });

  it('reports an abstract noun as undrawable, never as missing', () => {
    expect(binOf('tax')).toBe('undrawable');
    expect(binOf('quantum physics')).toBe('undrawable');
  });

  it('never reads a sealed set', () => {
    expect(SETS.map((set) => set.file).filter((file) => /test-200|sealed/.test(file))).toEqual([]);
  });

  it('reads the P41 set through its hero and triples, held-out included (P43 T9)', () => {
    const p41 = loadInputs().sets.find((set) => set.name === 'p41');
    expect(p41?.sentences.length).toBeGreaterThanOrEqual(239);
    // ho-004 „a seal swimming under the ice, catching fish and avoiding orcas“
    const seal = p41?.sentences.find((sentence) => sentence.id === 'ho-004');
    expect(seal?.checklist?.map((item) => `${item.slot}:${item.item}`).sort()).toEqual(['any:fish', 'any:orca', 'hero:seal']);
    expect(sentencesOf({ groups: { single: [{ id: 'x', sentence: 'run', hero: null, essential: [{ actor: 'hero', verb: 'run', object: null }] }] } })[0].checklist).toEqual([]);
  });

  it('names a category for a missing noun when the word reveals one', () => {
    expect(result.missing.some((row) => row.category !== null)).toBe(true);
    expect(result.missing.every((row) => 'category' in row)).toBe(true);
  });
});
