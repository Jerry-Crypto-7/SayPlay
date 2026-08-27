import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { recognize, seedEmission, shapeIdFor } from '@/model/local/shapes';
import { FAMILIES } from '../families';
import { chooseFamily, familyForSeed } from '../family-choice';

/**
 * Vlna 3, T3 — **rodinu vybírá věta, ne semínko světa**.
 *
 * Vada, na kterou test míří, se nedá vidět: když volba spadne vždy na tutéž
 * rodinu, vypadá to jako funkční systém s jedním výtvarným stylem. Pozná se to
 * jedině měřením napříč větami, a proto tenhle soubor bere věty ze **zmrazené
 * sady 200 vět**, ne vymyšlené řetězce.
 */

const FAMILY_IDS = FAMILIES.map((family) => family.id);

interface Prompt {
  readonly id: string;
  readonly bucket: string;
  readonly text: string;
}

const PROMPTS: readonly Prompt[] = JSON.parse(
  readFileSync('evals/corpus-v3/prompts.json', 'utf8'),
).prompts;

function promptById(id: string): Prompt {
  const found = PROMPTS.find((prompt) => prompt.id === id);
  if (found === undefined) throw new Error(`corpus-v3 nezná ${id}`);
  return found;
}

/**
 * Věta → `look`, přesně tou cestou, jakou jde produkt.
 *
 * Rozpoznaná věta má vlastní `look`; nerozpoznaná dostane náhradní místnost
 * (`seedEmission`) a čeká na model. Obojí je skutečný stav produktu, ne
 * testovací zkratka.
 */
function lookFor(sentence: string): unknown {
  const emission = (recognize(sentence) ?? seedEmission()) as { look?: unknown };
  return emission.look;
}

/** Semínko výzdoby je hash světa; tady stačí libovolné pevné, ale nenulové. */
const SEED = 20_260_826;

describe('chooseFamily – rodina jde z věty', () => {
  it('čtyři věty ze čtyř různých kbelíků dají aspoň tři různé rodiny', () => {
    // Po jedné větě ze čtyř kbelíků. `vague` je tu schválně: rozpoznávač ji
    // nezná (0 shod z 30), takže měří **záložní cestu** — náhradní místnost.
    const sample = ['P010', 'P098', 'P143', 'P111'].map(promptById);
    expect(new Set(sample.map((prompt) => prompt.bucket)).size, 'kbelíky se opakují').toBe(4);

    const chosen = sample.map((prompt) => chooseFamily(lookFor(prompt.text), SEED));
    for (const family of chosen) expect(FAMILY_IDS).toContain(family);

    expect(
      new Set(chosen).size,
      `čtyři různé věty daly rodiny ${chosen.join(', ')} — volba se řídí něčím jiným než větou`,
    ).toBeGreaterThanOrEqual(3);
  });

  it('rozpoznané věty zmrazené sady nespadnou všechny na jednu rodinu', () => {
    const recognised = PROMPTS.filter((prompt) => shapeIdFor(prompt.text) !== null);
    expect(recognised.length, 'zmrazená sada nemá jedinou rozpoznanou větu').toBeGreaterThan(10);

    const chosen = new Set(recognised.map((prompt) => chooseFamily(lookFor(prompt.text), SEED)));
    expect(
      chosen.size,
      `${recognised.length} rozpoznaných vět dalo jen rodiny ${[...chosen].join(', ')}`,
    ).toBe(FAMILIES.length);
  });

  it('táž věta dá vždy tutéž rodinu', () => {
    // Determinismus je podmínka, ne přání: kdyby se rodina hnula, rozešly by se
    // dva běhy téhož světa a padl by replay.
    for (const prompt of PROMPTS) {
      const look = lookFor(prompt.text);
      const first = chooseFamily(look, SEED);
      expect(chooseFamily(look, SEED), `${prompt.id} se hnula`).toBe(first);
      expect(chooseFamily(lookFor(prompt.text), SEED), `${prompt.id} se hnula`).toBe(first);
    }
  });
});

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
    for (const seed of [0, -1, -20_260_826, 2 ** 31, 1.5, -0.5]) {
      expect(FAMILY_IDS, `semínko ${seed} vydalo neznámou rodinu`).toContain(familyForSeed(seed));
    }
  });
});
