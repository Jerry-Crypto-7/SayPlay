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
      '../sim/hash',
      '../verify/witness',
      './reject',
      'rfc6902',
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
