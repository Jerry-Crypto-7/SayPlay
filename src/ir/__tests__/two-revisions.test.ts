/**
 * Hash jen ze `sim` a stráže dokumentu světa.
 *
 * Commit po revizích (`commitPart`, `commitMixed`) odešel se starým studiem
 * (P44D T7); zůstávají stráže samotného dokumentu – kanonický hash, migrace
 * a validátor `look` –, které čte `/play`.
 */

import { describe, expect, it } from 'vitest';

import {
  WORLD_DOC_VERSION,
  canonicalHash,
  migrateWorldDoc,
  sealSimHash,
  simHashOf,
  unhashableValues,
  validateLook,
} from '../worlddoc';
import { defaultLook, synthWorld } from '../__fixtures__/synth';

const world = synthWorld(20260812);

describe('hash je počítaný výhradně ze `sim`', () => {
  it('hash se počítá ze `sim` SAMOTNÉ, ne z obalu kolem ní', () => {
    // Porovnává se proti PRIMITIVU `canonicalHash`, ne proti `simHashOf` — ta by
    // se ptala sama sebe a prošla by i tehdy, kdyby hashovala obal, dokument bez
    // `look`, nebo cokoli jiného, co je konzistentní samo se sebou.
    expect(world.simHash).toBe(canonicalHash(world.sim));
    // A ne dokument bez `look`: kdyby se hashovalo odečítáním, každé nové pole
    // v kořeni by se do hashe dostalo samo.
    const { look: _look, ...withoutLook } = world;
    expect(world.simHash).not.toBe(canonicalHash(withoutLook));
  });
});

/**
 * Konečnost čísel je v `sim` **naléhavější** než v `look`, protože tam je hash.
 *
 * `JSON.stringify` převádí `NaN` i `Infinity` na `null`, takže tři sémanticky
 * různé dokumenty mají tentýž kanonický zápis a tentýž `simHash`. Dokument by
 * prošel migrací jako platný — hash by seděl na svou vlastní `sim` — a po
 * průchodu uložištěm nebo sítí by znamenal něco jiného, zatímco kotva
 * certifikátu by zůstala stejná. Není to narozeninová kolize; je to
 * deterministický kolaps dosažitelný jednou operací.
 */
describe('nekonečno se do hashované části nedostane', () => {
  it('a kdyby se commitly, měly by tentýž hash jako `null` — proto ta kontrola', () => {
    // Doklad té kolize, ne hypotéza: kanonický zápis všech tří je totožný.
    const withValue = (value: unknown) => canonicalHash({ counters: { keys: value } });
    expect(withValue(Number.NaN)).toBe(withValue(null));
    expect(withValue(Number.POSITIVE_INFINITY)).toBe(withValue(null));
  });

  it('migrace odmítne nekonečno i ve `look`, kde ho protokol žádá výslovně', () => {
    // Asymetrie by byla obrácená, než dává smysl: `look.failurePolicy` je jediné
    // místo, kde zmrazený protokol konečnost žádá doslova, a migrace je ten
    // atomický vstup, před kterým to má platit. Hash tu nepomůže — `look` v něm
    // není. A `structuredClone`/IndexedDB `Infinity` na rozdíl od JSON zachovají.
    const poisoned = { ...world, look: { ...world.look, camera: { kind: 'orbit', fov: Number.POSITIVE_INFINITY } } };
    expect(validateLook(poisoned.look).ok).toBe(false);
    const verdict = migrateWorldDoc(poisoned);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('not finite');
  });

  it('migrace dokument s nekonečnem ve `sim` odmítne, i když mu hash sedí', () => {
    // Hash SEDÍ — spočítal se z téže vadné `sim`. Kdyby migrace kontrolovala jen
    // hash, prošlo by to jako platný svět.
    const poisoned = sealSimHash({
      ...world,
      sim: { ...world.sim, state: { counters: { keys: { init: Number.POSITIVE_INFINITY } } } },
    });
    expect(poisoned.simHash).toBe(simHashOf(poisoned));
    const verdict = migrateWorldDoc(poisoned);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('not finite');
  });
});

describe('do `sim` se dostane jen JSON', () => {
  it('a kdyby prošla, dokument po uložení by byl jiný — se stejným hashem', () => {
    // Doklad té kolize, ne hypotéza.
    const rules: unknown[] = [{ id: 'win' }];
    (rules as unknown as Record<string, unknown>).smuggled = { hidden: true };
    expect(Object.keys(rules)).toEqual(['0', 'smuggled']);
    expect(canonicalHash({ rules })).toBe(canonicalHash({ rules: [{ id: 'win' }] }));
    expect(Object.keys(structuredClone(rules))).toEqual(['0', 'smuggled']);
    expect(Object.keys(JSON.parse(JSON.stringify(rules)) as object)).toEqual(['0']);
  });
});

/**
 * Hloubka je vada HODNOTY, ne výjimka na konci.
 *
 * `canonical` je rekurzivní, takže dokument zanořený ~2000 úrovní přeteče
 * zásobník až uvnitř `simHashOf` — tedy za všemi kontrolami. Strop proto sedí
 * v `unhashableValues`, která běží **před** každým hashováním, a platí tím pádem
 * na všech vstupech naráz: migrace i validace `look`.
 */
describe('příliš hluboké zanoření se odmítne, ne přeteče', () => {
  const nest = (depth: number): unknown => {
    let node: unknown = 1;
    for (let i = 0; i < depth; i += 1) node = { n: node };
    return node;
  };

  it('migrace hlubokého dokumentu ho odmítne místo aby spadla', () => {
    // Migrace je JEDINÝ vstup pro čtení dokumentu (`parseWorldDoc` tu schválně
    // není), takže výjimka odsud je 500 místo verdiktu — přesně to, co §11.3
    // zakazuje větou „buď vyrobí ověřeného svědka, nebo svět explicitně odmítne".
    //
    // Hash je schválně **placeholder, ne spočítaný**: takový dokument přichází
    // z uložiště s tím hashem, který v něm je, a `sealSimHash` by na téhle hloubce
    // sama přetekla dřív, než by se test k migraci vůbec dostal. Kontrola hloubky
    // běží před porovnáním hashe, takže verdikt rozhoduje ona.
    const deep = { ...world, simHash: '00000000', sim: { ...world.sim, state: nest(2000) } };
    let verdict: ReturnType<typeof migrateWorldDoc> | undefined;
    expect(() => {
      verdict = migrateWorldDoc(deep);
    }).not.toThrow();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.reason).toContain('deeper than');
  });

  /**
   * **Smyčka po pozicích pole je řízená číslem, které může přijít z patche.**
   *
   * `length` je zapisovatelná, takže pole umí tvrdit, že má miliardu prvků,
   * zatímco vlastní klíče má dva. Bez zastavení na prvním nálezu by kontrola
   * vyrobila jeden objekt nálezu na díru a skončila jako `heap out of memory` —
   * což je **abort procesu, ne výjimka**, takže by ho nechytil ani záchyt, který
   * slibuje „nikdy nevyhodí".
   */
  it('kontrola je omezená i nad polem, které tvrdí, že má milion prvků', () => {
    const vast: unknown[] = [];
    vast.length = 1_000_000;
    const issues = unhashableValues(vast, '/sim');
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain('hole in an array');
  });

  it('a zastavení na prvním nálezu neobviní klíč, ke kterému se nedošlo', () => {
    // Po předčasném zastavení je množina neprošlých klíčů teprve zpola
    // vyprázdněná. Kdyby se hlásila jako „tohle kanonizace neserializuje",
    // dostal by `b` nález za vadu, kterou má `a` — a `validateLook` ty nálezy
    // vydává celé, ne jen ten první.
    const issues = unhashableValues({ a: Number.NaN, b: 1 }, '/sim');
    expect(issues).toHaveLength(1);
    expect(issues[0].pointer).toBe('/sim/a');
    expect(issues.some((found) => found.detail.includes('never serializes'))).toBe(false);
  });
});

describe('`look` má validátor, ne verifikátor', () => {
  it('nekonečné a NaN hodnoty jsou technická vada, ne sémantická', () => {
    // §7: „Sémanticky neodmítá, technicky ano." `NaN` projde typem `number` a
    // rozbije stavbu geometrie až tam, kde nezbude nic než prázdná obrazovka.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const verdict = validateLook({ ...defaultLook(), camera: { kind: 'orbit', fov: value } });
      expect(verdict.ok, String(value)).toBe(false);
      expect(verdict.issues[0], String(value)).toContain('camera/fov');
    }
  });

  it('ale ošklivý vzhled projde — validátor se nevyjadřuje k vkusu', () => {
    expect(validateLook({ ...defaultLook(), palette: 'ink' }).ok).toBe(true);
    expect(validateLook({ ...defaultLook(), camera: { kind: 'orbit', fov: 179 } }).ok).toBe(true);
  });
});

describe('verzování a migrace — mezera §11.3', () => {
  it('aktuální verze projde a hash se ověří proti obsahu', () => {
    const verdict = migrateWorldDoc(world);
    expect(verdict.ok).toBe(true);
    expect(verdict.doc?.irVersion).toBe(WORLD_DOC_VERSION);
  });

  it('neznámá verze je EXPLICITNĚ odmítnuta, ne mlčky přijata', () => {
    // Certifikát vydaný nad starou sémantikou o nové netvrdí nic. Svět, který se
    // tváří platně a nikdo ho neověřil, je horší než svět odmítnutý.
    const verdict = migrateWorldDoc({ ...world, irVersion: 'world-ir-v0' });
    expect(verdict.ok).toBe(false);
    expect(verdict.doc).toBeNull();
    expect(verdict.reason).toContain('freshly verified witness');
  });

  it('a podvržený `simHash` taky', () => {
    const verdict = migrateWorldDoc({ ...world, simHash: '00000000' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('simHash');
  });
});
