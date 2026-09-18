/**
 * Znění rozsahu druhé věty (P15 T23).
 *
 * Panel má jediné rozhodování, které se dá udělat špatně, aniž by to bylo na
 * snímku vidět: **jak přeloží `scope` ze serveru do věty**. Nula, která se
 * vypíše, i jednotné číslo, které se nesklonilo, vypadají na obrázku jako
 * text — a e2e nad `/dev/refine` je neuvidí, protože harness vydává schválně
 * jen tvarovou změnu.
 */

import { describe, expect, it } from 'vitest';

import { scopeParts } from '../ChangePreview';

describe('scopeParts', () => {
  it('vynechá fasetu, která je nulová', () => {
    expect(scopeParts({ shape: true, behavior: 0, appearance: 0 })).toEqual(['a new shape']);
  });

  it('nevypíše tvar, který se nemění', () => {
    expect(scopeParts({ shape: false, behavior: 2, appearance: 0 })).toEqual([
      '2 behaviour changes',
    ]);
  });

  it('skloní jednotné číslo u obou početných faset', () => {
    expect(scopeParts({ shape: false, behavior: 1, appearance: 1 })).toEqual([
      '1 behaviour change',
      '1 appearance change',
    ]);
  });

  it('přidání se hlásí jako nový objekt, před operacemi, které ho zakládají', () => {
    expect(scopeParts({ shape: false, behavior: 3, appearance: 0, addition: true })).toEqual([
      'a new object',
      '3 behaviour changes',
    ]);
  });

  it('drží pořadí faset tvar → chování → vzhled', () => {
    expect(scopeParts({ shape: true, behavior: 3, appearance: 2 })).toEqual([
      'a new shape',
      '3 behaviour changes',
      '2 appearance changes',
    ]);
  });

  /**
   * Prázdný rozsah je **legitimní odpověď**, ne chyba: model smí vrátit plán,
   * který nakonec nic nemění, a panel to má říct větou, ne prázdným místem.
   * Text „Nothing would change." skládá komponenta z prázdného seznamu.
   */
  it('u plánu bez jediné změny vrátí prázdný seznam', () => {
    expect(scopeParts({ shape: false, behavior: 0, appearance: 0 })).toEqual([]);
  });
});
