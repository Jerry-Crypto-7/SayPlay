import { describe, expect, it } from 'vitest';

import { loadInputs, missingNouns, SETS } from '../missing-nouns.mjs';

/** Přihrádka slova nad skutečnými větami a katalogem repa. */
const result = missingNouns(loadInputs());
const binOf = (noun: string): string | undefined =>
  (['covered', 'undrawable', 'missing', 'settings', 'unclassified'] as const).find((bin) => result[bin].some((row) => row.noun === noun));

describe('missing-nouns (P37D T1)', () => {
  it('lists a noun the sentences use and the catalog cannot draw', () => {
    // Provaz pilot P37D zamítl (rovný provaz soudce vidí jako tyč); dvě věty ho chtějí.
    expect(binOf('rope')).toBe('missing');
    expect(result.missing.find((row) => row.noun === 'rope')?.sentences).toBeGreaterThanOrEqual(2);
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

  it('never reads the sealed test set', () => {
    expect(SETS.map((set) => set.file).filter((file) => file.includes('test-200'))).toEqual([]);
  });
});
