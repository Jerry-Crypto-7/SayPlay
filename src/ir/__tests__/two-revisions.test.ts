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
  canonical,
  canonicalHash,
  migrateWorldDoc,
  sealSimHash,
  simHashOf,
  unhashableValues,
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

  /**
   * **Patch, který se aplikuje naprázdno, se commitne a hash nechá být.**
   *
   * `sealPart` hash přepočítá z draftu, takže rovnost `simHash === simHashOf(doc)`
   * platí konstrukcí — ale to, že se hash **pohnul**, konstrukcí neplatí. Tenhle
   * test to pinuje, protože na tom stojí aserce `not.toBe(doc.simHash)`
   * v `create-edit-join.test.ts`: bez ní by za „editace funguje" prošel i patch,
   * který nezměnil nic. Bez tohohle testu je to jen tvrzení v komentáři.
   */
  it('a patch, který nic nezmění, se commitne s BITOVĚ stejným hashem', () => {
    const cell = (world.sim as { grid: { cell: number } }).grid.cell;
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/grid/cell', value: cell }],
    });
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    // Revize se zvedne — commit proběhl — ale obsah `sim` je týž, takže i hash.
    expect(result.doc.simRevision).toBe(world.simRevision + 1);
    expect(result.doc.simHash).toBe(world.simHash);
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

  /**
   * **A totéž musí platit pro POLE, protože tam se to hlídalo jinak.**
   *
   * `rfc6902` hlídá zápis do pole jedinou podmínkou `parseInt(key,10) >= length`.
   * Nečíselný token dá `NaN >= length === false`, takže propadne až na
   * `parent[key] = clone(value)` a zapíše **neindexovou vlastní vlastnost přímo
   * na pole**. `canonical` prochází pole přes `.map`, tedy jen pozice — ten klíč
   * nikdy neuvidí, hash zůstane bitově týž, `structuredClone` klíč zachová
   * a `JSON.stringify` ho zahodí. Commitnutý dokument tedy není ten, který se
   * znovu načte, a oba mají stejný `simHash`.
   *
   * Cíl je `witness.ops`, protože povrchové `sim.rules` je po přemrazení na
   * `evals-frozen-v2` **záznam klíčovaný `id`**, ne pole — nad ním by tyhle čtyři
   * testy poleovou větev rozboru cesty vůbec nepotkaly.
   */
  it('neindexový token do pole je odmítnut dřív, než se vůbec aplikuje', () => {
    // `rfc6902` by ho nezamítl: `replace` zapíše přímo `parent[key]`, `add` dělá
    // `splice(parseInt(key,10), …)` a `NaN` znamená **index 0**. Odmítnutí proto
    // musí přijít z kontroly tokenu, ne až z nálezu nad draftem.
    const before = world.simHash;
    for (const op of ['replace', 'add', 'copy', 'move'] as const) {
      const body = op === 'copy' || op === 'move' ? '"from":"/witness/ops/0"' : '"value":{"hidden":true}';
      const operations = JSON.parse(`[{"op":"${op}","path":"/witness/ops/smuggled",${body}}]`) as Operation[];
      const result = commitPart(world, { part: 'sim', baseRevision: 0, operations });

      expect(result, op).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
      if (result.verdict !== 'REJECTED') continue;
      expect(result.pointer, op).toBe('/witness/ops/smuggled');
      expect(result.detail, op).toContain('is not an index');
    }
    expect(world.simHash).toBe(before);
  });

  it('a přeskakovaný token v cestě ten zákaz neobejde', () => {
    // `rfc6902` `__proto__`/`constructor`/`prototype` v cestě PŘESKAKUJE, takže
    // mu rodičem zůstane pole. Kontrola, která do nich sestoupí, vidí něco jiného
    // než knihovna — a ten rozdíl je celá skulina.
    const before = world.simHash;
    for (const prefix of ['constructor', '__proto__', 'prototype']) {
      const operations = JSON.parse(
        `[{"op":"add","path":"/witness/ops/${prefix}/smuggled","value":{"id":"x"}}]`,
      ) as Operation[];
      const result = commitPart(world, { part: 'sim', baseRevision: 0, operations });

      expect(result, prefix).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
      if (result.verdict !== 'REJECTED') continue;
      expect(result.detail, prefix).toContain('is not addressable');
    }
    expect(world.simHash).toBe(before);
  });

  it('a `from` u `move` nesmí smazat nultou operaci svědka', () => {
    // `_remove` splicuje pole přes `parseInt(key,10)`, takže `from`
    // `/witness/ops/length` znamená `splice(NaN, 1)` — smazaná nultá operace,
    // tedy svědek, který dojde jinam než ten certifikovaný.
    const before = world.simHash;
    const operations = JSON.parse(
      '[{"op":"move","from":"/witness/ops/length","path":"/grid/cell"}]',
    ) as Operation[];
    const result = commitPart(world, { part: 'sim', baseRevision: 0, operations });

    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/witness/ops/length');
    expect(world.simHash).toBe(before);
  });

  it('ale `-` u `add` je legální „za poslední prvek"', () => {
    const step = JSON.parse('{"tick":1,"actionId":"moveTo","target":"spawn"}') as unknown;
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'add', path: '/witness/ops/-', value: step } as Operation],
    });
    expect(result.verdict).toBe('COMMITTED');
  });

  /**
   * **A vložení pravidla je po v2 zápis klíče, ne `splice`.**
   *
   * Tohle je celý důvod přemrazení: u pole posune vložení nebo smazání pravidla
   * indexy všem za ním, takže příští patch adresující `/rules/2` tiše trefí jiné
   * pravidlo. U záznamu klíčovaného `id` se ostatní klíče nehnou. §15 vede vložení
   * i smazání pravidla jako vlastní třídy editace, takže obojí musí jít provést
   * adresně.
   */
  it('a vložení pravidla adresuje `id`, takže ostatní pravidla nepřečísluje', () => {
    const rule = JSON.parse(
      '{"id":"lose","phase":0,"priority":1,"event":{"kind":"onEnterZone","entity":"player","zone":"spawn"},"condition":null,"actions":[{"kind":"lose"}]}',
    ) as unknown;
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'add', path: '/rules/lose', value: rule } as Operation],
    });
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;

    const rules = (result.doc.sim as { rules: Record<string, { id: string }> }).rules;
    expect(Object.keys(rules).sort()).toEqual(['lose', 'win']);
    // Původní pravidlo je pořád adresovatelné týmž jménem, jaké mělo předtím.
    expect(rules.win.id).toBe('win');
  });

  /**
   * **Charakterizace, ne schválení: `-` a číselný token nad `rules` DNES projdou.**
   *
   * Dokud bylo `rules` pole, `add /rules/-` byl legální append a měl tady vlastní
   * test. Po přechodu na záznam znamená ta samá operace něco jiného — vyrobí
   * pravidlo s **klíčem `"-"`** — a přesměrováním toho testu na `/witness/ops/-`
   * (což je tvar, kde `-` pořád znamená append) zůstala tahle cesta **bez jediné
   * aserce**. Tenhle test tu díru zavírá.
   *
   * **Pinuje se dnešní chování, ne kýžené.** `resolve` v `patch/reject.ts` vrací
   * u posledního tokenu na objektu `null` a je to v souladu s RFC 6901 (`-` je na
   * objektu obyčejné jméno členu) i s knihovnou. Vadné na tom je až to, co z toho
   * plyne o **adresování**: vzniklé pravidlo má `id: 'lose'`, ale klíč `"-"`, takže
   * následný patch na `/rules/lose` padne, **zatímco to pravidlo existuje** — přesně
   * to selhání, kvůli kterému se korpus mrazil na v2. Jestli se to má odmítnout
   * (`resolve`), dorovnat (`id == klíč` v `sealPart`), nebo nechat scoreru,
   * **rozhoduje T22** — má to u sebe zapsané i s variantami. Až rozhodne, tenhle
   * test se buď obrátí, nebo mu přibude protipól; do té doby aspoň nikdo nezmění
   * tohle chování omylem.
   */
  it('CHARAKTERIZACE: `-` a číselný token nad `rules` projdou a rozbijí `id == klíč`', () => {
    const rule = JSON.parse(
      '{"id":"lose","phase":0,"priority":1,"event":{"kind":"onStart"},"condition":null,"actions":[{"kind":"lose"}]}',
    ) as unknown;

    for (const token of ['-', '0']) {
      const result = commitPart(world, {
        part: 'sim',
        baseRevision: 0,
        operations: [{ op: 'add', path: `/rules/${token}`, value: rule } as Operation],
      });
      expect(result.verdict, token).toBe('COMMITTED');
      if (result.verdict !== 'COMMITTED') continue;

      const rules = (result.doc.sim as { rules: Record<string, { id: string }> }).rules;
      // Klíč je doslova ten token — ne append, ne index.
      expect(Object.keys(rules).sort(), token).toEqual([token, 'win'].sort());
      // A tady je ta vada: `id` a klíč se rozešly, takže pravidlo existuje pod
      // jménem, pod kterým ho žádný další patch nenajde.
      expect(rules[token].id, token).toBe('lose');
      expect(rules.lose, token).toBeUndefined();
    }

    // A totéž mimo `rules`, protože komentář u T22 se odvolává právě na tenhle
    // pointer: `-` nad OBJEKTEM je podle RFC 6901 obyčejné jméno členu, takže
    // `add` vyrobí člen `"-"` vedle `min`/`max`/`init`.
    const counter = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'add', path: '/state/counters/keys/-', value: 9 } as Operation],
    });
    expect(counter.verdict).toBe('COMMITTED');
    if (counter.verdict !== 'COMMITTED') return;
    const keys = (counter.doc.sim as { state: { counters: { keys: Record<string, number> } } }).state.counters.keys;
    expect(Object.keys(keys).sort()).toEqual(['-', 'init', 'max', 'min']);
  });

  it('a pole s propašovaným klíčem neprojde ani jako HODNOTA operace', () => {
    // Tudy se do draftu dostane i to, co kontrola tokenu nevidí — pole přijaté
    // celé, s neindexovou vlastností už na sobě.
    const smuggler: unknown[] = [1, 2];
    (smuggler as unknown as Record<string, unknown>).hidden = true;
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/slots', value: smuggler } as Operation],
    });
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('never serializes');
  });

  it('a pole s přepsaným prototypem taky ne', () => {
    // `Array.isArray` je pořád `true` — prototyp se kontroluje zvlášť, protože
    // bez něj by `.map` v `canonical` nebyla funkce.
    const rogue: unknown[] = [1, 2];
    Object.setPrototypeOf(rogue, null);
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/slots', value: rogue } as Operation],
    });
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('only plain objects and arrays');
  });

  /**
   * `-0` je táž vada jako přepsaný prototyp, jen ji model umí poslat přímo v JSON.
   *
   * `Number.isFinite(-0)` je `true` a `JSON.stringify(-0)` je `"0"`, takže hash
   * mluví o nule. `JSON.parse` i `structuredClone` ale `-0` **zachovají** — takže
   * commitnutý dokument nese `-0`, jeho kotva popisuje `0`, a po průchodu
   * uložištěm se z něj `0` doopravdy stane.
   */
  it('`-0` se do hashované části nedostane', () => {
    const operations = JSON.parse('[{"op":"replace","path":"/state/counters/keys/init","value":-0}]') as Operation[];
    const result = commitPart(world, { part: 'sim', baseRevision: 0, operations });
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('negative zero');

    // Doklad té kolize, ne hypotéza.
    expect(canonicalHash({ v: -0 })).toBe(canonicalHash({ v: 0 }));
    expect(Object.is(structuredClone({ v: -0 }).v, -0)).toBe(true);
    expect(Object.is(JSON.parse(JSON.stringify({ v: -0 })).v, -0)).toBe(false);
  });

  it('ale kladná nula projít MUSÍ — jinak by to byl zákaz nuly', () => {
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/counters/keys/init', value: 0 } as Operation],
    });
    expect(result.verdict).toBe('COMMITTED');
  });

  it('a kdyby prošla, dokument po uložení by byl jiný — se stejným hashem', () => {
    // Doklad té kolize, ne hypotéza.
    const rules: unknown[] = [{ id: 'win' }];
    (rules as unknown as Record<string, unknown>).smuggled = { hidden: true };
    expect(Object.keys(rules)).toEqual(['0', 'smuggled']);
    expect(canonicalHash({ rules })).toBe(canonicalHash({ rules: [{ id: 'win' }] }));
    expect(Object.keys(structuredClone(rules))).toEqual(['0', 'smuggled']);
    expect(Object.keys(JSON.parse(JSON.stringify(rules)) as object)).toEqual(['0']);
  });

  it('a díra v poli taky ne — `canonical` a `JSON` ji píšou jinak', () => {
    const holed: unknown[] = [1, 2, 3];
    delete holed[1];
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/slots', value: holed } as Operation],
    });
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('hole in an array');
    // Doklad rozdílu: `canonical` renderuje díru jako prázdno, `JSON` jako `null`.
    expect(canonical(holed)).toBe('[1,,3]');
    expect(JSON.stringify(holed)).toBe('[1,null,3]');
  });

  it('ale pole s prototypem a bez děr projít MUSÍ — jinak by to nebyl strop, ale zákaz polí', () => {
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/slots', value: [1, 2, 3] } as Operation],
    });
    expect(result.verdict).toBe('COMMITTED');
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

  /**
   * **Vada není v operaci, ale ve dvojici operace a dokumentu.**
   *
   * `{"op":"add","path":"/grid/cell/x"}` projde kontrolou tvaru i hodnoty — je to
   * platná RFC 6902 operace s platným pointerem. Teprve `grid.cell` je ve
   * zmrazeném korpusu **číslo**, takže `rfc6902` uvnitř vyhodí `TypeError: Cannot
   * create property 'x' on number '1'`. Dřív než při aplikaci to vidět nejde.
   *
   * Patchovat primitivum, jako by to byl objekt, je běžná chyba emise, ne útok.
   */
  it('`add` do primitivu je odmítnutí s pointerem, ne `TypeError`', () => {
    const operations = JSON.parse('[{"op":"add","path":"/grid/cell/x","value":1}]') as Operation[];
    let result: ReturnType<typeof commitPart> | undefined;
    expect(() => {
      result = commitPart(world, { part: 'sim', baseRevision: 0, operations });
    }).not.toThrow();
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
    // Pointer musí ukazovat na TU operaci, ne na část dokumentu — proto se
    // operace pouštějí po jedné.
    if (result?.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/grid/cell/x');
  });

  it('a u smíšeného požadavku ta výjimka nesmí sebrat už commitnutý `look`', () => {
    // Tohle je ta cena: výjimka přijde AŽ PO commitnutém `look`, takže volající
    // nedostane `{look: COMMITTED, sim: REJECTED}`, ale pád — a vzhledová úprava,
    // kterou hráč právě viděl, zmizí.
    const broken: PartPatch = {
      part: 'sim',
      baseRevision: 0,
      operations: JSON.parse('[{"op":"add","path":"/grid/cell/x","value":1}]') as Operation[],
    };
    let mixed: ReturnType<typeof commitMixed> | undefined;
    expect(() => {
      mixed = commitMixed(world, lookPatch(0), broken);
    }).not.toThrow();
    expect(mixed?.look.verdict).toBe('COMMITTED');
    expect(mixed?.sim.verdict).toBe('REJECTED');
    expect(mixed?.doc.lookRevision).toBe(1);
    expect((mixed?.doc.look as { camera: { kind: string } }).camera.kind).toBe('follow');
  });

  /**
   * **Kontrakt zní „nikdy nevyhodí", ne „nevyhodí na těchhle osmi vstupech".**
   *
   * Pět kol brány našlo pět různých dveří — vymyšlená hloubka schématu,
   * `Infinity`, `undefined` hlouběji ve stromu, `Date`/`Map`/`Set`, `__proto__`
   * v cestě. Zavírat je po jedné znamená zavřít tu, kterou zrovna někdo našel,
   * takže tenhle test nemíří na konkrétní vadu, ale na ten kontrakt: hodnota,
   * která **vyhodí uvnitř samotné kontroly**, musí skončit jako verdikt.
   *
   * `Proxy` je k tomu jen nástroj — vyhodí v `Object.keys`, tedy uvnitř
   * `unhashableValues`, což je **před** aplikací patche a mimo dosah jakéhokoli
   * záchytu kolem `applyPatch`. Sem se dá dojít jen záchytem kolem všeho.
   */
  it('i hodnota, která vyhodí uvnitř kontroly, skončí jako verdikt', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap');
        },
      },
    );
    let result: ReturnType<typeof commitPart> | undefined;
    expect(() => {
      result = commitPart(world, {
        part: 'sim',
        baseRevision: 0,
        operations: [{ op: 'replace', path: '/state/slots', value: hostile } as Operation],
      });
    }).not.toThrow();
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
    if (result?.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('ownKeys trap');
  });

  it('a smíšený požadavek si u toho udrží commitnutý `look`', () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('ownKeys trap'); } });
    let mixed: ReturnType<typeof commitMixed> | undefined;
    expect(() => {
      mixed = commitMixed(world, lookPatch(0), {
        part: 'sim',
        baseRevision: 0,
        operations: [{ op: 'replace', path: '/state/slots', value: hostile } as Operation],
      });
    }).not.toThrow();
    expect(mixed?.look.verdict).toBe('COMMITTED');
    expect(mixed?.sim.verdict).toBe('REJECTED');
    expect(mixed?.doc.lookRevision).toBe(1);
  });

  it('operace, která projde, se aplikuje na tentýž draft jako ta před ní', () => {
    // Pouštění po jedné nesmí změnit sémantiku: druhá operace musí vidět výsledek
    // první. Bez téhle aserce by shodou okolností prošla i implementace, která
    // každou operaci pouští na čerstvou kopii.
    const result = commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [
        { op: 'add', path: '/sockets/side', value: [2, 2] },
        { op: 'move', path: '/sockets/flank', from: '/sockets/side' },
      ],
    });
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    const sockets = (result.doc.sim as { sockets: Record<string, unknown> }).sockets;
    expect(sockets.flank).toEqual([2, 2]);
    expect(sockets.side).toBeUndefined();
  });
});

/**
 * Hloubka je vada HODNOTY, ne výjimka na konci.
 *
 * `canonical` je rekurzivní, takže dokument zanořený ~2000 úrovní přeteče
 * zásobník až uvnitř `simHashOf` — tedy za všemi kontrolami. Strop proto sedí
 * v `unhashableValues`, která běží **před** každým hashováním, a platí tím pádem
 * na všech vstupech naráz: patch, migrace i validace `look`.
 */
describe('příliš hluboké zanoření se odmítne, ne přeteče', () => {
  const nest = (depth: number): unknown => {
    let node: unknown = 1;
    for (let i = 0; i < depth; i += 1) node = { n: node };
    return node;
  };

  it('commit hlubokého patche je odmítnutí s důvodem', () => {
    let result: ReturnType<typeof commitPart> | undefined;
    expect(() => {
      result = commitPart(world, {
        part: 'sim',
        baseRevision: 0,
        operations: [{ op: 'replace', path: '/state/slots', value: nest(2000) }],
      });
    }).not.toThrow();
    expect(result?.verdict).toBe('REJECTED');
    if (result?.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('deeper than');
  });

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

  it('a uložená vada se nevykazuje jako vada patche', () => {
    // `sealSimHash` dokument zapečetí bez kontroly, takže `WorldDoc` sem umí
    // přijít i mimo `migrateWorldDoc`. Nález nad draftem by pak vypadal, jako by
    // ho přinesl tenhle patch — a volající by ho přeemitoval donekonečna.
    const stored = sealSimHash({
      ...world,
      sim: { ...world.sim, state: { counters: { keys: { min: 0, max: 3, init: -0 } } } },
    });
    const result = commitPart(stored, simPatch(0));

    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'STRUCTURE' });
    if (result.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('the sim part this patch targets');
    expect(result.pointer).toBe('/sim/state/counters/keys/init');
  });

  it('ale běžná hloubka projít MUSÍ — jinak by strop byl jen jiná vada', () => {
    // Nejhlubší cesta ve zmrazeném korpusu má jednotky úrovní. Kdyby strop
    // odmítal i legitimní dokument, zavřel by branku i pro správné světy.
    expect(commitPart(world, {
      part: 'sim',
      baseRevision: 0,
      operations: [{ op: 'replace', path: '/state/slots', value: nest(32) }],
    }).verdict).toBe('COMMITTED');
    expect(migrateWorldDoc(world).ok).toBe(true);
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
