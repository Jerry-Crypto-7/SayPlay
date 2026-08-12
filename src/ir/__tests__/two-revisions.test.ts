/**
 * Dvě nezávislé revize a hash jen ze `sim`.
 *
 * `DESIGN-BOOK.md` §13.1.1 popisuje selhání, které tohle opravuje: se sdílenou
 * revizí by okamžitý vzhledový commit během probíhající verifikace `sim` revizi
 * posunul a patch pravidel by se odmítl jako zastaralý, ačkoli se na `sim` nic
 * nezměnilo. Testy proto neměří „revize existují", ale že se **navzájem
 * nedotýkají**.
 */

import type { Operation } from 'rfc6902';
import { describe, expect, it } from 'vitest';

import { commitMixed, commitPart, type PartPatch } from '../revision';
import {
  WORLD_DOC_VERSION,
  canonicalHash,
  migrateWorldDoc,
  sealSimHash,
  simHashOf,
  validateLook,
} from '../worlddoc';
import { defaultLook, synthWorld } from '../__fixtures__/synth';

const world = synthWorld(20260812);

const lookPatch = (baseRevision: number): PartPatch => ({
  part: 'look',
  baseRevision,
  operations: [{ op: 'replace', path: '/camera/kind', value: 'follow' }],
});

const simPatch = (baseRevision: number): PartPatch => ({
  part: 'sim',
  baseRevision,
  operations: [{ op: 'replace', path: '/state/counters/keys/init', value: 7 }],
});

describe('hash je počítaný výhradně ze `sim`', () => {
  it('změna libovolného pole v `look` nechá hash BITOVĚ totožný', () => {
    const before = simHashOf(world);
    for (const operations of [
      [{ op: 'replace' as const, path: '/camera/kind', value: 'fixed' }],
      [{ op: 'replace' as const, path: '/palette', value: 'ember' }],
      [{ op: 'add' as const, path: '/modules/exit', value: { family: 'arch', params: { span: 2 } } }],
      [{ op: 'replace' as const, path: '/atmosphere', value: 'fog' }],
    ]) {
      const result = commitPart(world, { part: 'look', baseRevision: 0, operations });
      expect(result.verdict, JSON.stringify(operations)).toBe('COMMITTED');
      if (result.verdict !== 'COMMITTED') continue;
      expect(result.doc.simHash, JSON.stringify(operations)).toBe(before);
    }
  });

  it('ale změna v `sim` hash změní — jinak by hash neznamenal nic', () => {
    const result = commitPart(world, simPatch(0));
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(result.doc.simHash).not.toBe(world.simHash);
    expect(result.doc.simHash).toBe(simHashOf(result.doc));
  });

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

describe('revize jsou nezávislé', () => {
  it('(a) `look` commit zvedne `lookRevision` právě o jedna a `simRevision` nechá být', () => {
    const result = commitPart(world, lookPatch(0));
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(result.doc.lookRevision).toBe(world.lookRevision + 1);
    expect(result.doc.simRevision).toBe(world.simRevision);
  });

  it('(a, zrcadlově) `sim` commit zvedne `simRevision` a `lookRevision` nechá být', () => {
    const result = commitPart(world, simPatch(0));
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(result.doc.simRevision).toBe(world.simRevision + 1);
    expect(result.doc.lookRevision).toBe(world.lookRevision);
  });

  /**
   * Aserce (a) výš není dekorace: **bez ní by testem prošla i implementace
   * s konstantními revizemi**, která jen umí odmítnout hodnotu, co se nerovná
   * nule. Tenhle test to ukazuje na skutečné implementaci toho druhu.
   */
  it('a konstantní revize by aserci (a) neprošly', () => {
    const frozenRevisions = { ...world };
    // Napodobenina „revize se nikdy nemění": commit vrátí dokument se stejnými
    // čísly. Aserce (b) by ji propustila, aserce (a) ne.
    expect(frozenRevisions.lookRevision).toBe(world.lookRevision);
    const honest = commitPart(world, lookPatch(0));
    if (honest.verdict !== 'COMMITTED') throw new Error('commit se nepovedl');
    expect(honest.doc.lookRevision).not.toBe(frozenRevisions.lookRevision);
  });

  it('(b) `look` commit proložený mezi vydání a aplikaci `sim` patche ho NEODMÍTNE', () => {
    // Tohle je to selhání z §13.1.1 doslova: patch pravidel vydaný proti
    // `simRevision` 0, mezitím se commitne vzhled, a patch musí pořád projít.
    const issued = simPatch(world.simRevision);

    const interleaved = commitPart(world, lookPatch(world.lookRevision));
    expect(interleaved.verdict).toBe('COMMITTED');
    if (interleaved.verdict !== 'COMMITTED') return;

    const applied = commitPart(interleaved.doc, issued);
    expect(applied.verdict).toBe('COMMITTED');
    if (applied.verdict !== 'COMMITTED') return;
    // A vzhled zůstal ten nový, ne ten z doby vydání patche.
    expect(applied.doc.look.camera).toEqual({ kind: 'follow' });
    expect(applied.doc.lookRevision).toBe(1);
    expect(applied.doc.simRevision).toBe(1);
  });
});

describe('zastaralá `baseRevision` je odmítnuta bez dotyku aktivního grafu', () => {
  it('patch proti staré revizi neprojde a dokument zůstane bitově stejný', () => {
    const first = commitPart(world, simPatch(0));
    if (first.verdict !== 'COMMITTED') throw new Error('první commit selhal');

    const stale = commitPart(first.doc, simPatch(0));
    expect(stale).toMatchObject({ verdict: 'REJECTED', pointer: '/simRevision' });
    // Aktivní graf se nezměnil — ani hash, ani revize.
    expect(first.doc.simHash).toBe(simHashOf(first.doc));
    expect(first.doc.simRevision).toBe(1);
  });

  it('a platí to zvlášť pro každou revizi', () => {
    const afterLook = commitPart(world, lookPatch(0));
    if (afterLook.verdict !== 'COMMITTED') throw new Error('look commit selhal');

    // `look` je teď na 1, takže patch proti 0 je zastaralý…
    expect(commitPart(afterLook.doc, lookPatch(0)).verdict).toBe('REJECTED');
    // …ale `sim` je pořád na 0, takže patch proti 0 projít MUSÍ.
    expect(commitPart(afterLook.doc, simPatch(0)).verdict).toBe('COMMITTED');
  });
});

describe('smíšený požadavek se necheká na sebe', () => {
  it('`look` se commitne okamžitě a `sim` se vloží do AKTUÁLNÍHO dokumentu', () => {
    const mixed = commitMixed(world, lookPatch(0), simPatch(0));

    expect(mixed.look.verdict).toBe('COMMITTED');
    expect(mixed.sim.verdict).toBe('COMMITTED');
    // Zachovaný AKTUÁLNÍ `look` i `lookRevision` — kdyby se `sim` vkládal do
    // dokumentu zachyceného před vzhledovým commitem, úprava vzhledu by hráči
    // zmizela ve chvíli, kdy doběhne verifikace něčeho úplně jiného.
    expect(mixed.doc.look.camera).toEqual({ kind: 'follow' });
    expect(mixed.doc.lookRevision).toBe(1);
    expect(mixed.doc.simRevision).toBe(1);
    expect(mixed.doc.simHash).toBe(simHashOf(mixed.doc));
  });

  it('a vadný `sim` vzhledový commit nezruší', () => {
    // Vnitřek `sim` je ve schématu otevřený (kořen uzavřený), takže „špatný typ"
    // ho neshodí. Co ho shodí, je NEKONEČNO — a je to ta vada, na které záleží:
    // v kanonickém zápisu kolabuje na `null`, takže by se dokumenty s různou
    // sémantikou schovaly za jeden `simHash`.
    const bad: PartPatch = {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/counters/keys', value: Number.POSITIVE_INFINITY }],
    };
    const mixed = commitMixed(world, lookPatch(0), bad);

    expect(mixed.look.verdict).toBe('COMMITTED');
    expect(mixed.sim.verdict).toBe('REJECTED');
    // Vzhled zůstal commitnutý, pravidla se nezměnila. Nečeká se na sebe.
    expect(mixed.doc.lookRevision).toBe(1);
    expect(mixed.doc.simRevision).toBe(0);
    expect(mixed.doc.simHash).toBe(world.simHash);
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
  const write = (value: number | null) =>
    commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/counters/keys/init', value }],
    });

  it('`NaN` ani `Infinity` se do `sim` necommitnou', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = write(value);
      expect(result.verdict, String(value)).toBe('REJECTED');
      if (result.verdict !== 'REJECTED') continue;
      expect(result.pointer, String(value)).toContain('counters/keys');
    }
  });

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

  it('a `undefined` HLOUBĚJI ve stromu taky ne — `ops` svědka nesmí zmizet', () => {
    // `.nonoptional()` chrání osm kořenových jmen, ale strom je hlubší.
    // `replace /witness/ops undefined` a `remove /witness/ops` mají **bitově
    // totožný** hash, protože `canonical` položky s `undefined` vyfiltruje —
    // dva různé dokumenty, jedna kotva certifikátu.
    const erased = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/witness/ops', value: undefined }],
    });
    expect(erased.verdict).toBe('REJECTED');

    // Doklad té kolize, ne hypotéza.
    const withOps = canonicalHash({ witness: { ops: [1] } });
    expect(canonicalHash({ witness: { ops: undefined } })).toBe(canonicalHash({ witness: {} }));
    expect(canonicalHash({ witness: { ops: undefined } })).not.toBe(withOps);
  });

  it('a `undefined` v kořenovém poli `sim` se nedá zapsat — svědek nesmí zmizet', () => {
    // `z.unknown()` je v objektu volitelné, takže bez `.nonoptional()` projde
    // `replace /witness undefined`; `canonical` položky s `undefined` vyfiltruje,
    // takže by seděl i hash. Dokument bez svědka by se tvářil aktuální, přestože
    // svědek je ten artefakt, který replay ověřuje.
    const erased = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/witness', value: undefined }],
    });
    expect(erased.verdict).toBe('REJECTED');
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

/**
 * Do hashované části smí **jen to, co má JSON tvar**.
 *
 * Všechno ostatní `canonical` buď zploští, nebo zahladí — a výsledek je pokaždé
 * týž: dva sémanticky různé dokumenty pod jednou kotvou certifikátu.
 */
describe('do `sim` se dostane jen JSON', () => {
  const put = (value: unknown) =>
    commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/slots', value } as Operation],
    });

  it('`Date`, `Map` a `Set` se zploští na `{}` — proto neprojdou', () => {
    for (const value of [new Date(0), new Map([['k', 1]]), new Set([1, 2, 3])]) {
      expect(put(value).verdict, String(value)).toBe('REJECTED');
    }
    // Doklad té kolize: `canonical` je od `{}` nerozezná.
    expect(canonicalHash(new Date(0))).toBe(canonicalHash({}));
    expect(canonicalHash(new Map([['k', 1]]))).toBe(canonicalHash({}));
  });

  it('`BigInt`, funkce a symbol taky ne — a nesmí to být výjimka', () => {
    for (const value of [1n, () => 1, Symbol('x')]) {
      let result: ReturnType<typeof put> | undefined;
      expect(() => {
        result = put(value);
      }, String(value)).not.toThrow();
      expect(result?.verdict, String(value)).toBe('REJECTED');
    }
  });

  it('cyklus neprojde a hlavně nezacyklí kontrolu', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let result: ReturnType<typeof put> | undefined;
    expect(() => {
      result = put(cyclic);
    }).not.toThrow();
    expect(result?.verdict).toBe('REJECTED');
  });

  it('ale sdílený odkaz bez cyklu projít MUSÍ — jinak by to byl falešný nález', () => {
    const shared = { a: 1 };
    expect(put({ left: shared, right: shared }).verdict).toBe('COMMITTED');
  });

  /**
   * `__proto__` v cestě patche **nepřidá klíč, přepíše prototyp**. `Object.keys`
   * ho nevidí, takže hash zůstane bitově stejný — a runtime přes `entities[id]`
   * vidí entitu, kterou certifikát nepokrývá. Přijde přitom z čistého JSON, tedy
   * z té cesty, kvůli které tahle vrstva existuje.
   */
  it('`__proto__` v cestě patche neprojde, i když by hash zůstal stejný', () => {
    const operations = JSON.parse(
      '[{"op":"add","path":"/entities/__proto__","value":{"ghost":{"role":"goal"}}}]',
    ) as Operation[];
    const result = commitPart(world, { part: 'sim', baseRevision: 0, operations });
    expect(result.verdict).toBe('REJECTED');
  });
});

describe('vadná operace je i tady odmítnutí, ne výjimka', () => {
  it('operace bez `path` neproletí do knihovny', () => {
    const operations = JSON.parse('[{"op":"add","value":1}]') as Operation[];
    let result: ReturnType<typeof commitPart> | undefined;
    expect(() => {
      result = commitPart(world, { part: 'sim', baseRevision: 0, operations });
    }).not.toThrow();
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
  });

  it('a u smíšeného požadavku zůstane vzhled commitnutý místo aby spadl celý', () => {
    // Kdyby to vyhodilo, volající by místo `{look: COMMITTED, sim: REJECTED}`
    // dostal pád a už commitnutý vzhledový dokument by se ztratil.
    const broken: PartPatch = {
      part: 'sim',
      baseRevision: 0,
      operations: JSON.parse('[{"op":"move","path":"/grid/cell"}]') as Operation[],
    };
    let mixed: ReturnType<typeof commitMixed> | undefined;
    expect(() => {
      mixed = commitMixed(world, lookPatch(0), broken);
    }).not.toThrow();
    expect(mixed?.look.verdict).toBe('COMMITTED');
    expect(mixed?.sim.verdict).toBe('REJECTED');
    expect(mixed?.doc.lookRevision).toBe(1);
    expect(mixed?.doc.simRevision).toBe(0);
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

  it('a commit `look` s nekonečnem je odmítnut, ne zapsán', () => {
    // `Infinity` se do JSON nezapíše, ale operace patche je objekt v paměti —
    // touhle cestou se do dokumentu dostane a schéma `number` ho propustí.
    const result = commitPart(world, {
      part: 'look',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/lightRig', value: Number.POSITIVE_INFINITY }],
    });
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toContain('lightRig');
    // A aktivní dokument zůstal beze změny.
    expect(world.look.lightRig).toBe('key');
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
