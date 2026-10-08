import { describe, expect, it } from 'vitest';

import { FAMILIES } from '../families';
import { chooseFamily, familyForSeed } from '../family-choice';

/** Vlna 3, T3 — **rodinu vybírá věta, ne semínko světa**. */

const FAMILY_IDS = FAMILIES.map((family) => family.id);

/** Semínko výzdoby je hash světa; tady stačí libovolné pevné, ale nenulové. */
const SEED = 20_260_826;

describe('chooseFamily – co rozhoduje', () => {
  it('počasí přebije materiál', () => {
    expect(chooseFamily({ palette: 'stone', atmosphere: 'clear' }, SEED)).toBe('terraces');
    // Týž materiál, jiné počasí — a rodina se musí hnout, jinak `atmosphere`
    // nerozhoduje vůbec a půlka pravidla je dekorace.
    expect(chooseFamily({ palette: 'stone', atmosphere: 'fog' }, SEED)).toBe('spires');
    expect(chooseFamily({ palette: 'stone', atmosphere: 'rain' }, SEED)).toBe('works');
  });

  it('jasno není síla — rozhoduje materiál', () => {
    for (const weather of ['clear', 'none', '']) {
      expect(chooseFamily({ palette: 'meadow', atmosphere: weather }, SEED)).toBe('grove');
    }
  });

  it('rozhoduje slovo uvnitř řetězce, ne celý řetězec', () => {
    // Naměřené odpovědi živého modelu (`evals/live/**`). Uzavřená tabulka klíčů
    // by na nich spadla na semínko, což je konstanta pro celou třídu vstupů.
    expect(chooseFamily({ palette: 'bright primary colors with natural wood' }, SEED)).toBe('grove');
    expect(chooseFamily({ palette: 'carnival-red-cream-blue' }, SEED)).toBe('terraces');
    expect(chooseFamily({ palette: 'slate', atmosphere: 'clear playful arena' }, SEED)).toBe(
      'terraces',
    );
  });
});

describe('chooseFamily – failure paths', () => {
  it('`look` bez známého slova spadne na semínko, ne na konstantu', () => {
    const unknown = { palette: 'neutral', atmosphere: 'festive indoor arcade' };
    for (let seed = 0; seed < FAMILIES.length; seed += 1) {
      expect(chooseFamily(unknown, seed)).toBe(familyForSeed(seed));
    }
    // Kdyby záloha vracela konstantu, tady by byla jedna rodina místo čtyř.
    const fallback = new Set(
      Array.from({ length: 40 }, (_unused, seed) => chooseFamily(unknown, seed)),
    );
    expect(fallback.size, 'záloha ze semínka nedrží rozmanitost').toBe(FAMILIES.length);
  });

  it('chybějící, prázdný i nesmyslný `look` vrátí známou rodinu', () => {
    for (const look of [undefined, null, {}, 'stone', 42, { palette: 7, atmosphere: [] }]) {
      expect(FAMILY_IDS, `look ${JSON.stringify(look)} vydal neznámou rodinu`).toContain(
        chooseFamily(look, SEED),
      );
    }
  });

  it('semínko mimo obor hodnot pořád vydá rodinu', () => {
    for (const seed of [0, -1, -20_260_826, 2 ** 31, 1.5, -0.5, NaN, Infinity, -Infinity]) {
      expect(FAMILY_IDS, `semínko ${seed} vydalo neznámou rodinu`).toContain(familyForSeed(seed));
    }
  });

  it('slovo z prototypu Objectu není rodina', () => {
    // Nález nezávislého review: vyhledávalo se `table[word]`, což prochází
    // prototyp — a `constructor` je přesně malými písmeny, takže věta s tím
    // slovem vrátila funkci `Object` místo rodiny. `familyById` na ni pak
    // vydal `undefined` a svět se vykreslil **bez kulisy**. Selhalo to tiše,
    // protože zálohu na semínko to obešlo: hodnota `!== undefined` byla.
    for (const word of ['constructor', 'valueOf', 'hasOwnProperty', 'toString', '__proto__']) {
      expect(
        FAMILY_IDS,
        `slovo ${word} v atmosphere vydalo neznámou rodinu`,
      ).toContain(chooseFamily({ palette: 'stone', atmosphere: `a ${word} yard in the fog` }, 7));
      expect(FAMILY_IDS, `slovo ${word} v palette vydalo neznámou rodinu`).toContain(
        chooseFamily({ palette: word, atmosphere: 'unremarkable' }, 7),
      );
    }
  });
});
