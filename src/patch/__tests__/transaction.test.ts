/**
 * Transakční patch — **commit, nebo ani bajt**.
 *
 * Oracle je dvojice pozorování, ne návratová hodnota: hash grafu před pokusem
 * a po něm, plus to, že **původní svědek dál dojde do výhry**. Kdyby se
 * kontroloval jen návratový kód, prošla by i implementace, která dokument
 * rozbije a pak řekne „odmítnuto" — což je přesně ten stav, ve kterém certifikát
 * začne lhát.
 *
 * Žádné dvojníky na patch cestě: interpret, verifikátor i hash běží reálné.
 */

import { readFileSync } from 'node:fs';

import type { Operation } from 'rfc6902';
import { describe, expect, it } from 'vitest';

import { applyWorldPatch, graphHash } from '../apply';
import { verifyWitness, type VerifiableWorld } from '../../verify/witness';
import type { TraceInput } from '../../sim/interpreter';

import vaultWorld from '../../sim/__fixtures__/vault.world.json';

const vault = vaultWorld as unknown as VerifiableWorld;
const WITNESS = vault.trace as TraceInput[];

/** Co musí platit po KAŽDÉM odmítnutí, bez ohledu na jeho důvod. */
function expectUntouched(before: string) {
  expect(graphHash(vault), 'hash starého grafu se změnil').toBe(before);
  expect(verifyWitness(vault, WITNESS).verdict, 'původní svědek přestal vyhrávat').toBe('CERTIFIED');
}

describe('validní patch se commitne atomicky', () => {
  it('změní hash a vrátí NOVÝ dokument, vstupní nechá být', () => {
    const before = graphHash(vault);
    const result = applyWorldPatch(vault, [{ op: 'replace', path: '/ir/rules/0/priority', value: 5 }]);

    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(result.hashBefore).toBe(before);
    expect(result.hashAfter).not.toBe(before);
    expect(result.doc).not.toBe(vault);
    // Vstupní dokument je pořád ten původní — kdyby se patch aplikoval na něj,
    // starý graf by se nedal replaynout a živá editace by byla reset.
    expect(graphHash(vault)).toBe(before);
    expect(vault.ir.rules[0].priority).toBe(0);
  });

  it('prázdný patch je no-op commit — `COMMITTED` samo o sobě změnu hashe neslibuje', () => {
    // Pinuje se to schválně: AC mluví o tom, že VALIDNÍ patch hash změní, a
    // prázdný seznam operací je hraniční případ, kde to neplatí a platit nemá.
    const result = applyWorldPatch(vault, []);
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(result.hashAfter).toBe(result.hashBefore);
  });

  it('a nový graf je pořád platný svět, ne jen jiný JSON', () => {
    const result = applyWorldPatch(vault, [{ op: 'replace', path: '/ir/rules/0/priority', value: 5 }]);
    if (result.verdict !== 'COMMITTED') throw new Error('patch se necommitl');
    expect(verifyWitness(result.doc, WITNESS).verdict).toBe('CERTIFIED');
  });

  it('přidání pravidla změní hash, i když počáteční stav zůstane stejný', () => {
    // Tohle je důvod, proč se hashuje DOKUMENT a ne počáteční stav: nové
    // pravidlo se do zabaleného stavu nepromítne vůbec, a přesto je to jiný svět.
    const result = applyWorldPatch(vault, [
      { op: 'add', path: '/ir/effects/-', value: { op: 'lose' } },
      {
        op: 'add',
        path: '/ir/rules/-',
        value: {
          ruleId: 'r.giveup',
          phase: 0,
          priority: 9,
          trigger: { kind: 'onEdge', predicate: 'p.onSignal.open', became: false },
          guard: null,
          effects: [4],
        },
      },
    ]);
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(result.hashAfter).not.toBe(result.hashBefore);
  });
});

describe('nevalidní patch je odmítnut s přesným pointerem', () => {
  it('špatný typ pole: pointer i očekávaný typ míří na to konkrétní místo', () => {
    const before = graphHash(vault);
    const result = applyWorldPatch(vault, [
      { op: 'replace', path: '/ir/rules/0/priority', value: 'brzy' },
    ]);

    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SCHEMA');
    expect(result.pointer).toBe('/ir/rules/0/priority');
    expect(result.expected).toBe('number');
    expectUntouched(before);
  });

  it('neznámé pole je odmítnuto, ne tiše propuštěno', () => {
    const before = graphHash(vault);
    const result = applyWorldPatch(vault, [{ op: 'add', path: '/ir/rules/0/haste', value: true }]);

    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SCHEMA');
    expect(result.pointer).toContain('/ir/rules/0');
    expectUntouched(before);
  });

  it('osiřelý odkaz projde tvarem a padne až na vazbách — s pointerem na kolekci', () => {
    const before = graphHash(vault);
    const result = applyWorldPatch(vault, [
      { op: 'replace', path: '/ir/rules/0/trigger/predicate', value: 'p.neexistuje' },
    ]);

    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('STRUCTURE');
    expect(result.pointer).toBe('/ir/rules');
    expect(result.detail).toContain('p.neexistuje');
    expectUntouched(before);
  });

  it('operace, kterou nelze provést, je odmítnuta na SVÉ cestě', () => {
    const before = graphHash(vault);
    const result = applyWorldPatch(vault, [
      { op: 'replace', path: '/ir/rules/99/priority', value: 1 },
    ]);

    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('MALFORMED_OPERATION');
    // Cesta operace, ne cesta jejího rodiče: odpověď musí mluvit v souřadnicích
    // dotazu, jinak na ni autorský nástroj neumí skočit.
    expect(result.pointer).toBe('/ir/rules/99/priority');
    expectUntouched(before);
  });

  it('každé odmítnutí nese neprázdný pointer i očekávání', () => {
    // Bez tohohle by šlo AC splnit prázdným řetězcem a odpověď by byla stejně
    // bezcenná jako „patch je neplatný".
    const attempts: readonly Operation[][] = [
      [{ op: 'replace', path: '/ir/rules/0/priority', value: 'brzy' }],
      [{ op: 'add', path: '/ir/rules/0/haste', value: true }],
      [{ op: 'replace', path: '/ir/rules/0/trigger/predicate', value: 'p.neexistuje' }],
      [{ op: 'replace', path: '/ir/rules/99/priority', value: 1 }],
      [{ op: 'remove', path: '/ir/nodes/0' }],
    ];
    for (const operations of attempts) {
      const result = applyWorldPatch(vault, operations);
      expect(result.verdict, JSON.stringify(operations)).toBe('REJECTED');
      if (result.verdict !== 'REJECTED') continue;
      expect(result.pointer.length, JSON.stringify(operations)).toBeGreaterThan(0);
      expect(result.expected.length, JSON.stringify(operations)).toBeGreaterThan(0);
    }
  });
});

/**
 * `worldIr` popisuje jen graf, takže bez stráže nad obálkou projde jako platný
 * patch, který rozbije všechno ostatní — a projde jako **commit**, ne jako pád.
 * To je horší než odmítnutí: gate na to dá razítko.
 */
describe('patch mimo `/ir` je pod stráží stejně jako graf', () => {
  const outside: readonly (readonly [string, Operation])[] = [
    ['smazaná tabulka soketů', { op: 'remove', path: '/space/sockets' }],
    ['geometrie nahrazená řetězcem', { op: 'replace', path: '/space/blocked', value: 'nope' }],
    ['soket s nečíselnou buňkou', { op: 'add', path: '/space/sockets/ghost', value: ['a', 'b'] }],
    ['certifikace, která není objekt', { op: 'add', path: '/certification', value: 42 }],
    ['neznámý tier', { op: 'add', path: '/certification', value: { tier: 'nope', horizonTicks: 10 } }],
    ['záporný horizont', { op: 'add', path: '/certification', value: { tier: 'short', horizonTicks: -1 } }],
    ['stopa bez aktéra', { op: 'add', path: '/trace/-', value: { tick: 1, actionId: 'pull' } }],
    ['záporný tik ve stopě', { op: 'replace', path: '/trace/0/tick', value: -3 }],
  ];

  it.each(outside)('%s je odmítnuto', (_label, operation) => {
    const before = graphHash(vault);
    const result = applyWorldPatch(vault, [operation]);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SCHEMA');
    expectUntouched(before);
  });

  it('soket mimo deklarovanou mřížku je odmítnut — commit by shodil `createRuntime`', () => {
    // Tuhle otázku nemá kdo jiný položit: `worldIr` vidí jen `ir`, obálka vidí
    // `space` bez `limits`, `validateIrDoc` `space` nevidí vůbec.
    const before = graphHash(vault);
    for (const value of [
      [-1, 0],
      [99, 99],
    ]) {
      const result = applyWorldPatch(vault, [
        { op: 'replace', path: '/space/sockets/s_start', value },
      ]);
      expect(result, JSON.stringify(value)).toMatchObject({
        verdict: 'REJECTED',
        reason: 'STRUCTURE',
        pointer: '/space/sockets/s_start',
      });
    }
    expectUntouched(before);
  });

  it('a zmenšená mřížka pod stávajícím soketem taky — patch se `/space` ani nedotkne', () => {
    const result = applyWorldPatch(vault, [{ op: 'replace', path: '/ir/limits/gridWidth', value: 2 }]);
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'STRUCTURE' });
    if (result.verdict !== 'REJECTED') return;
    // Ukazuje na soket, který se do zmenšené mřížky nevešel, ne na `limits`:
    // tam se dá skočit a opravit to.
    expect(result.pointer).toContain('/space/sockets/');
  });

  it('druhý paměťový slot na téže adrese je odmítnut — jeho identita není `id`', () => {
    // Paměťový slot se za běhu adresuje `agent#index`; `id` je u něj dekorace.
    // Hlídat jedinečnost podle `id` pouští dvojici, která se srazí až
    // v `defineLayout` — a to je výjimka, ne definovaný přechod.
    const roomy = applyWorldPatch(vault, [
      { op: 'replace', path: '/ir/limits/memorySlotsPerAgent', value: 1 },
      {
        op: 'add',
        path: '/ir/slots/-',
        value: { space: 'memory', id: 'm_one', agent: 'hero', index: 0, values: ['a'], initial: 'a' },
      },
    ]);
    expect(roomy.verdict).toBe('COMMITTED');
    if (roomy.verdict !== 'COMMITTED') return;

    const clash = applyWorldPatch(roomy.doc, [
      {
        op: 'add',
        path: '/ir/slots/-',
        value: { space: 'memory', id: 'm_two', agent: 'hero', index: 0, values: ['a'], initial: 'a' },
      },
    ]);
    expect(clash).toMatchObject({
      verdict: 'REJECTED',
      reason: 'STRUCTURE',
      pointer: '/ir/slots',
    });

    // A jiný index projde — kontrola musí odmítat srážku, ne paměť jako takovou.
    const roomier = applyWorldPatch(roomy.doc, [
      { op: 'replace', path: '/ir/limits/memorySlotsPerAgent', value: 2 },
      {
        op: 'add',
        path: '/ir/slots/-',
        value: { space: 'memory', id: 'm_two', agent: 'hero', index: 1, values: ['a'], initial: 'a' },
      },
    ]);
    expect(roomier.verdict).toBe('COMMITTED');
    if (roomier.verdict !== 'COMMITTED') return;
    // Oracle je SPUŠTĚNÍ: dokument, který projde, musí jít postavit a odkrokovat.
    expect(verifyWitness(roomier.doc, WITNESS).verdict).toBe('CERTIFIED');
  });

  it('ale mřížka, do které se soketa vejdou, projde — jinak by kontrola jen zakazovala', () => {
    const result = applyWorldPatch(vault, [{ op: 'replace', path: '/ir/limits/gridWidth', value: 16 }]);
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(verifyWitness(result.doc, WITNESS).verdict).toBe('CERTIFIED');
  });

  it('smazaná tabulka soketů by jinak runtime shodila výjimkou, ne faultem', () => {
    // Důvod, proč tohle patří sem a ne do „ať si to runtime ošetří": pád při
    // konstrukci není definovaný přechod, takže by ho nešlo replaynout.
    const result = applyWorldPatch(vault, [{ op: 'remove', path: '/space/sockets' }]);
    expect(result.verdict).toBe('REJECTED');
  });

  it('přidaný soket by jinak udělal z neproveditelného svědka proveditelného', () => {
    // `verifyWitness` rozpouští cíle kroků proti `space.sockets`, takže patch
    // do té tabulky je cesta, jak si vyrobit platný certifikát bez zásahu do grafu.
    const bogus: TraceInput[] = [
      { tick: 0, actor: 'hero', actionId: 'moveTo', target: 'ghost' },
      ...WITNESS,
    ];
    expect(verifyWitness(vault, bogus).verdict).toBe('REJECTED');

    // Buňka uvnitř deklarované mřížky 8×8 — mimo ni by ji odmítla kontrola layoutu.
    const result = applyWorldPatch(vault, [{ op: 'add', path: '/space/sockets/ghost', value: [4, 4] }]);
    // Dobře utvořený soket projít SMÍ — je to legitimní editace layoutu. Pointa
    // je, že projde jen dobře utvořený, a že se tím nic nepodstrčí za zády
    // schématu.
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(verifyWitness(result.doc, bogus).verdict).toBe('CERTIFIED');
    // A původní dokument to nezměnilo, takže starý certifikát platí dál.
    expect(verifyWitness(vault, bogus).verdict).toBe('REJECTED');
  });
});

describe('vadná operace je odmítnutí, ne výjimka', () => {
  it('operace bez `path` neproletí do knihovny', () => {
    const before = graphHash(vault);
    let result: ReturnType<typeof applyWorldPatch> | undefined;
    expect(() => {
      result = applyWorldPatch(vault, [{ op: 'add', value: 1 } as unknown as Operation]);
    }).not.toThrow();
    expect(result?.verdict).toBe('REJECTED');
    if (result?.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('MALFORMED_OPERATION');
    expect(result.expected.length).toBeGreaterThan(0);
    expectUntouched(before);
  });

  it('cesta bez úvodního lomítka není JSON Pointer — a nesmí proletět jako výjimka', () => {
    // Nejběžnější chyba v ručně i modelem psaném patchi. `rfc6902` na ní vyhodí
    // `Invalid JSON Pointer`, takže kontrola chybějící cesty sama nestačí.
    const before = graphHash(vault);
    for (const operation of [
      { op: 'replace', path: 'ir/rules/0/priority', value: 5 },
      { op: 'move', from: 'ir/rules/0', path: '/ir/rules/1' },
    ] as unknown as Operation[]) {
      let result: ReturnType<typeof applyWorldPatch> | undefined;
      expect(() => {
        result = applyWorldPatch(vault, [operation]);
      }, JSON.stringify(operation)).not.toThrow();
      expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
    }
    expectUntouched(before);
  });

  it('rozbitý index se pozná přesně, ne podřetězcem', () => {
    // `/ir/nodes/1` je podřetězcem `/ir/nodes/12`, takže hádání porovnáváním
    // řetězců by obvinilo uzel, který je v pořádku. Chybu hlásí knihovna i
    // s cestou — ta se použije doslova.
    const result = applyWorldPatch(vault, [
      { op: 'copy', from: '/ir/nodes/1', path: '/ir/nodes/12/kind' },
    ]);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).not.toBe('/ir/nodes/1');
    expect(result.pointer).toContain('/ir/nodes/12');
  });

  it('neznámé `op` taky ne', () => {
    const result = applyWorldPatch(vault, [
      { op: 'obliterate', path: '/ir/rules/0' } as unknown as Operation,
    ]);
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
  });

  it('`move` s rozbitým `from` ukáže na `from`, ne na platný `path`', () => {
    // Ukázat `path` znamená poslat autorský nástroj na místo, které je
    // v pořádku — pointer nesprávný je horší než pointer hrubý.
    const result = applyWorldPatch(vault, [
      { op: 'move', from: '/ir/rules/99', path: '/ir/rules/0' },
    ]);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/ir/rules/99');
  });

  it('`test`, který neprošel, hlásí očekávanou HODNOTU, ne „použitelný cíl"', () => {
    const result = applyWorldPatch(vault, [{ op: 'test', path: '/ir/rules/0/priority', value: 999 }]);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.expected).toContain('999');
  });

  it('neznámý klíč ukáže přímo na sebe a řekne tvar, ne kód chyby', () => {
    const result = applyWorldPatch(vault, [{ op: 'add', path: '/ir/rules/0/haste', value: true }]);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/ir/rules/0/haste');
    expect(result.expected).not.toBe('unrecognized_keys');
    expect(result.expected).toContain('no property');
  });
});

describe('částečná aplikace není možná', () => {
  it('platná operace před neplatnou se nepropíše', () => {
    const before = graphHash(vault);
    const result = applyWorldPatch(vault, [
      { op: 'replace', path: '/ir/rules/0/priority', value: 5 },
      { op: 'replace', path: '/ir/rules/1/priority', value: 'pozdě' },
    ]);

    expect(result.verdict).toBe('REJECTED');
    // Kdyby se aplikovalo na vstup a při chybě se „vracelo zpátky", tenhle
    // hash by se lišil právě o tu první operaci.
    expectUntouched(before);
  });

  it('a platná operace ZA neplatnou taky ne', () => {
    const before = graphHash(vault);
    const result = applyWorldPatch(vault, [
      { op: 'replace', path: '/ir/rules/0/priority', value: 'brzy' },
      { op: 'replace', path: '/ir/rules/1/priority', value: 5 },
    ]);

    expect(result.verdict).toBe('REJECTED');
    expectUntouched(before);
  });

  it('odmítnutý pokus nezmění hash ani po opakování', () => {
    // Idempotence odmítnutí: opakovaný špatný patch nesmí graf posouvat.
    // Smazání UZLU je nevalidní, protože posune indexy pod všemi odkazy na něj;
    // smazání pravidla by naopak platné bylo a test by pak měřil commit.
    const before = graphHash(vault);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(applyWorldPatch(vault, [{ op: 'remove', path: '/ir/nodes/0' }]).verdict).toBe('REJECTED');
    }
    expectUntouched(before);
  });

  it('a smazání pravidla naopak PROJDE — jinak by odmítání nic neznamenalo', () => {
    // Kdyby patch cesta odmítala všechno, každý test výš by prošel z nesprávného
    // důvodu. `r.pull` je odstranitelný: nikdo se na něj neodkazuje.
    const result = applyWorldPatch(vault, [{ op: 'remove', path: '/ir/rules/0' }]);
    expect(result.verdict).toBe('COMMITTED');
    // A výsledek je jiný svět: bez příčinného pravidla už svědek nevyhraje.
    if (result.verdict !== 'COMMITTED') return;
    expect(verifyWitness(result.doc, WITNESS).verdict).toBe('REJECTED');
  });
});

describe('hash grafu je kanonický', () => {
  it('nezávisí na pořadí klíčů, jen na obsahu', () => {
    const shuffled = JSON.parse(
      JSON.stringify({ space: vault.space, trace: vault.trace, ir: vault.ir, _note: undefined }),
    ) as unknown;
    const straight = JSON.parse(
      JSON.stringify({ ir: vault.ir, trace: vault.trace, space: vault.space }),
    ) as unknown;
    expect(graphHash(shuffled)).toBe(graphHash(straight));
  });

  it('ale na obsahu ano — jinak by neuměl poznat commit', () => {
    const changed = structuredClone(vault) as unknown as {
      ir: { rules: { priority: number }[] };
    };
    changed.ir.rules[0].priority = 7;
    expect(graphHash(changed)).not.toBe(graphHash(vault));
  });
});

/**
 * **Obě patch cesty musí být hlídané stejně.**
 *
 * `ir/revision.ts` a `patch/apply.ts` sdílely `operationSchema`, ale ne hodnotovou
 * stráž — takže se stejná vada dala odmítnout jednou cestou a commitnout druhou.
 * Sdílená kontrola to zavírá; tyhle testy hlídají, že se zase nerozejdou.
 */
describe('sousední patch cesta má tytéž stráže jako `ir/revision.ts`', () => {
  it('`__proto__` v cestě neprojde, i když by hash zůstal bitově stejný', () => {
    const before = graphHash(vault);
    // Z čistého JSON, tedy z té cesty, kvůli které tahle vrstva existuje.
    const operations = JSON.parse(
      '[{"op":"add","path":"/space/sockets/__proto__","value":{"phantom":[99,99]}}]',
    ) as Operation[];
    const result = applyWorldPatch(vault, operations);

    expect(result.verdict).toBe('REJECTED');
    expectUntouched(before);
  });

  it('a kdyby prošlo, runtime by přes `sockets[name]` viděl soket navíc', () => {
    // Doklad té vady, ne hypotéza. `rfc6902` dělá `add` **přiřazením**, a to na
    // klíči `__proto__` spustí setter prototypu místo aby přidalo vlastní klíč —
    // proto se tady pollutuje stejným způsobem, ne přes `JSON.parse` (ten
    // `__proto__` naopak založí jako vlastní klíč, tedy jinou věc).
    const polluted = structuredClone(vault) as unknown as { space: { sockets: Record<string, unknown> } };
    (polluted.space.sockets as { __proto__?: unknown }).__proto__ = { phantom: [99, 99] };

    // `Object.entries` ho nevidí, takže `worldEnvelope`, `layoutFits` i `graphHash`
    // projdou beze změny…
    expect(Object.keys(polluted.space.sockets)).toEqual(Object.keys(vault.space.sockets));
    expect(graphHash(polluted)).toBe(graphHash(vault));
    // …zatímco čtení klíčem ten fantomový soket najde. Certifikát ho nepokrývá a
    // kontrola mřížky ho neviděla.
    expect((polluted.space.sockets as { phantom?: unknown }).phantom).toEqual([99, 99]);
  });

  it('`add` do primitivu je odmítnutí s pointerem, ne `TypeError`', () => {
    const before = graphHash(vault);
    const operations = JSON.parse('[{"op":"add","path":"/ir/limits/gridWidth/x","value":1}]') as Operation[];
    let result: ReturnType<typeof applyWorldPatch> | undefined;
    expect(() => {
      result = applyWorldPatch(vault, operations);
    }).not.toThrow();
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
    if (result?.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/ir/limits/gridWidth/x');
    expectUntouched(before);
  });

  /**
   * **Na místě, kde zod NEPOMŮŽE.**
   *
   * `/ir/rules/0/priority` je `z.int()`, takže tam `Map` shodí schéma i bez téhle
   * stráže — test by prošel s vypnutou kontrolou a měřil by zod. `worldEnvelope`
   * je ale v kořeni `.loose()`, takže `/_evil` je místo, kde neplatí žádné jiné
   * omezení a rozhoduje výhradně tahle kontrola.
   *
   * Že to musí být kontrola nad OPERACÍ, plyne z `rfc6902`: jeho `clone` přestaví
   * každý objekt mimo pole a `Date` na prostý `{}` přes `for…in`, takže `Map`
   * i `Set` dorazí do draftu už zploštěné a kontrola nad draftem je od `{}`
   * nerozezná.
   */
  it('hodnota bez JSON tvaru se odmítne i tam, kde ji schéma propustí', () => {
    for (const value of [new Map([['k', 1]]), new Set([1, 2]), new Date(0), Number.NaN]) {
      const before = graphHash(vault);
      const result = applyWorldPatch(vault, [{ op: 'add', path: '/_evil', value } as Operation]);
      expect(result.verdict, String(value)).toBe('REJECTED');
      expectUntouched(before);
    }
  });

  it('neindexová vlastnost propašovaná na pole neprojde ani tudy', () => {
    // `rfc6902` hlídá zápis do pole jen podmínkou `parseInt(key,10) >= length`,
    // takže nečíselný token propadne na `parent[key] = value`. `canonical` pole
    // prochází přes `.map`, tedy jen pozice — hash by zůstal bitově týž.
    const before = graphHash(vault);
    const operations = JSON.parse('[{"op":"replace","path":"/ir/rules/smuggled","value":{"a":1}}]') as Operation[];
    const result = applyWorldPatch(vault, operations);

    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/ir/rules/smuggled');
    expectUntouched(before);
  });

  /**
   * A tenhle případ dřív procházel jako `MALFORMED_OPERATION` s textem
   * `value.map is not a function`.
   *
   * Operace je přitom bezvadná RFC 6902 a projde každou hodnotovou kontrolou —
   * vada je ve **výsledném dokumentu** a dřív se objevila teprve tím, že
   * `canonical` zavolal `.map` na něčem, co už pole nebylo. Volající klíčovaný na
   * `MALFORMED_OPERATION` by týž patch přeemitoval donekonečna.
   */
  it('přepsaný prototyp pole je vada struktury, ne vadná operace', () => {
    const before = graphHash(vault);
    const operations = JSON.parse('[{"op":"replace","path":"/ir/rules/__proto__","value":{}}]') as Operation[];
    const result = applyWorldPatch(vault, operations);

    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'STRUCTURE' });
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/ir/rules');
    expectUntouched(before);
  });

  it('`__proto__` s hodnotou `null` taky neprojde', () => {
    // Užší varianta téhož: `Object.entries` nad objektem s `null` prototypem
    // funguje a hash sedí, ale `structuredClone` mu `Object.prototype` mlčky
    // vrátí — commitnutý dokument by po uložení nebyl týž objekt.
    const before = graphHash(vault);
    const operations = JSON.parse('[{"op":"add","path":"/space/sockets/__proto__","value":null}]') as Operation[];
    expect(applyWorldPatch(vault, operations).verdict).toBe('REJECTED');
    expectUntouched(before);
  });

  it('a pointer odmítnutí je RFC 6901, i když klíč obsahuje lomítko', () => {
    // `pointer` je podle `reject.ts` strojové pole, ne popisná cesta: neescapovaný
    // klíč `a/b` by ukázal na `/space/tags/a/b`, tedy na jiné a neexistující místo
    // dokumentu. `space.tags` je `z.record(z.string(), …)`, takže `/` v klíči je
    // reprezentovatelný.
    //
    // Cesta sem vede přes kontrolu VSTUPU: kdyby vada přišla v `value` operace,
    // pointer by byl prostě cesta té operace a o escapování by nic nedokazoval.
    const tainted = structuredClone(vault) as unknown as {
      space: { tags: Record<string, unknown> };
    };
    tainted.space.tags['a/b'] = Number.NaN;

    const result = applyWorldPatch(tainted as unknown as VerifiableWorld, []);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/space/tags/a~1b');
  });

  /**
   * **Kontrakt zní „nikdy nevyhodí", ne „nevyhodí na těchhle osmi vstupech".**
   *
   * `Proxy` vyhodí v `Object.keys`, tedy uvnitř samotné kontroly hodnot — dřív,
   * než se aplikuje jediná operace, a mimo dosah jakéhokoli záchytu kolem
   * `applyPatch`. Sem se dá dojít jen záchytem kolem celého průchodu, a proto
   * odmítnutí nemá pointer: v tu chvíli není co zaměřit.
   */
  it('i hodnota, která vyhodí uvnitř kontroly, skončí jako verdikt', () => {
    const before = graphHash(vault);
    const hostile = new Proxy({}, { ownKeys() { throw new Error('ownKeys trap'); } });
    let result: ReturnType<typeof applyWorldPatch> | undefined;
    expect(() => {
      result = applyWorldPatch(vault, [
        { op: 'replace', path: '/ir/rules/0/priority', value: hostile } as Operation,
      ]);
    }).not.toThrow();
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'MALFORMED_OPERATION' });
    if (result?.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('ownKeys trap');
    expectUntouched(before);
  });

  /**
   * **Vada ve VSTUPNÍM světě se nesmí vykázat jako vadný patch.**
   *
   * `graphHash(doc)` je první výpočet celé funkce, dřív než existuje jakákoli
   * operace — takže neuchopitelný svět by shodil hashování a odpověď by vinila
   * patch. Prázdný seznam operací hlášený jako `MALFORMED_OPERATION` je nesmysl,
   * na který se nedá reagovat: volající by patch přeemitoval donekonečna.
   */
  it('hluboký VSTUPNÍ dokument je vada světa, ne patche', () => {
    let node: unknown = 1;
    for (let i = 0; i < 5000; i += 1) node = { n: node };
    const deep = { ...structuredClone(vault), ir: { ...vault.ir, deep: node } } as unknown as VerifiableWorld;

    let result: ReturnType<typeof applyWorldPatch> | undefined;
    expect(() => {
      result = applyWorldPatch(deep, []);
    }).not.toThrow();
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'STRUCTURE' });
    if (result?.verdict !== 'REJECTED') return;
    expect(result.detail).toContain('the world this patch targets');
  });

  it('a `undefined` v nepovinném poli světa nevydává za vinu nesouvisející patch', () => {
    // `certification` je `.optional()`, takže `{certification: undefined}` je
    // legální TS i legální schéma — a `canonical` ho zahladí, takže identita
    // dokumentu je nejednoznačná. Odmítnout je správně; vinit patch, který na to
    // pole nesáhl, není.
    const withUndefined = { ...structuredClone(vault), certification: undefined } as unknown as VerifiableWorld;
    const result = applyWorldPatch(withUndefined, [{ op: 'replace', path: '/ir/rules/0/priority', value: 5 }]);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/certification');
    expect(result.detail).toContain('the world this patch targets');
  });

  it('operace, která projde, se aplikuje na tentýž draft jako ta před ní', () => {
    // Pouštění po jedné nesmí změnit sémantiku: druhá operace vidí výsledek první.
    const result = applyWorldPatch(vault, [
      { op: 'replace', path: '/ir/rules/0/priority', value: 5 },
      { op: 'test', path: '/ir/rules/0/priority', value: 5 },
    ]);
    expect(result.verdict).toBe('COMMITTED');
  });
});

describe('patch cesta stojí na RFC 6902, ne na náhražce', () => {
  /**
   * Kontroluje se **množina importů**, ne text souboru.
   *
   * Doslovný sken by shodila i zmínka zakázané knihovny v komentáři — což je
   * táž past, kterou u sebe popisuje `rng.ts`. Tady navíc dává strukturální
   * kontrola silnější odpověď: seznam se musí shodovat přesně, takže nová
   * závislost na patch cestě spadne, i kdyby se jmenovala jakkoli.
   */
  it('`apply.ts` importuje právě ty moduly, na kterých má stát', () => {
    const text = readFileSync(new URL('../apply.ts', import.meta.url), 'utf8');
    const specifiers = [...text.matchAll(/from '([^']+)'/g)].map((hit) => hit[1]).sort();
    expect(specifiers).toEqual([
      '../ir/schema',
      // `unhashableValues` je SDÍLENÁ stráž, ne kopie: druhá implementace téhož
      // by se rozešla po prvním nálezu, který se opraví jen na jedné cestě —
      // a přesně tak vznikl rozdíl, kvůli kterému `__proto__` prošlo tudy,
      // zatímco `ir/revision.ts` ho odmítal.
      '../ir/worlddoc',
      '../sim/hash',
      '../verify/tiers',
      '../verify/witness',
      './reject',
      'rfc6902',
      'zod',
    ]);
  });

  it('a `package.json` nenese žádnou konkurenční implementaci patche', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const installed = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)];
    expect(installed).toContain('rfc6902');
    // Obě náhražky, které `CLAUDE.md` jmenuje: jedna tvarem sedí a je pomalejší,
    // druhá se tváří kompatibilně a přitom RFC 6902 nedodržuje.
    expect(installed).not.toContain('fast-json-patch');
    expect(installed).not.toContain('immer');
  });
});
