/**
 * **Jedna odpověď na otázku „co změna nechá být", ne dvě.**
 *
 * Chování `preservedBy()` soudí sada nad routou
 * (`src/app/api/worldstream/__tests__/changes.test.ts`), kde projde skutečnými
 * dveřmi i skutečným dokumentem. Tenhle soubor hlídá to druhé, co se testem
 * přes dveře chytit nedá: že **druhá** obrazovka, na které se ta věta ukazuje,
 * počítá touž funkcí, a ne vlastním odhadem.
 *
 * ⚠ **Je to lexikální brána a je to schválně** (`T35-preservedattr`). Do
 * 6. 9. 2026 `/dev/refine` seznam počítalo jako „všechno kromě cíle", tedy
 * přesně tu nepravdu, kterou blokující nález nezávislé revize v routě zavřel —
 * a nevšiml si toho nikdo, protože scénář té stránky vyrábí seznam, který
 * **náhodou vychází stejně**. E2e sada nad ní je proto zelená nad oběma
 * výpočty a rozdíl neuvidí; jediné, co ho vidí, je zdroj.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WorldDoc } from '@/ir/worlddoc';
import { preservedBy } from '@/worldstream/preserved';

const REFINE_PAGE = join(process.cwd(), 'src/app/dev/refine/page.tsx');

describe('/dev/refine počítá „co změna nechá být" sdílenou funkcí', () => {
  const source = readFileSync(REFINE_PAGE, 'utf8');

  /**
   * ⚠ **Argumenty, ne jen jméno volání — routovaný nález prvního kola nezávislé
   * revize (6. 9. 2026), potvrzený mutací.** Brána se ptala jen na `preserved:
   * preservedBy(`, takže záměna `shape: SHARPENED_HERO` za `shape: null`
   * **zůstala zelená** — a přitom je tvar u téhle stránky jediný vstup, který
   * něco jmenuje: scénář `/dev/refine` nepíše ani jednu operaci. Pod tou mutací
   * by stránka počítala „všechno kromě cíle" znovu, tedy přesně tu nepravdu,
   * kvůli které sdílená funkce vznikla, a brána nad ní by mlčela.
   */
  it('volá preservedBy z @/worldstream/preserved, a předá mu scénář té stránky', () => {
    expect(source).toContain("from '@/worldstream/preserved'");

    const call = /preserved: preservedBy\(([\s\S]{0,800}?)\n {8}\),/.exec(source);
    expect(call).not.toBeNull();

    const argumentList = call![1];
    expect(argumentList).toContain('DEMO_BLUEPRINT.objects');
    expect(argumentList).toContain('shape: SHARPENED_HERO');
    expect(argumentList).toContain('DEMO_BLUEPRINT.world');
  });

  /**
   * Kontrola k předchozímu: import sám nestačí, protože vedle něj může
   * doopravdy stát i druhý výpočet. Zakázaný je **tvar** té staré nepravdy —
   * filtr objektů podle nerovnosti s cílem.
   */
  it('nepočítá seznam sám filtrem „všechno kromě cíle"', () => {
    expect(source).not.toMatch(/objects[\s\S]{0,80}\.filter\([\s\S]{0,80}stableId !==/);
  });
});

/**
 * **Tvar dokumentu, který fixtura routy vyjádřit nemůže.**
 *
 * Sada nad routou (`changes.test.ts`) jde skutečným compilerem, takže její svět
 * je vždycky svět, který compiler vydá. Dva objekty nárokující týž socket takový
 * svět dnes není — všech jedenáct v `authored-worlds.json` má nároky
 * jednoznačné — ale nic ho nezakazuje: `sim.entities` je ve schématu `unknown`
 * a `src/ir/build.ts` jednoznačnost nekontroluje. Proto se tahle třída soudí
 * přímo nad funkcí, ne přes dveře.
 */
describe('preservedBy nad socketem, který si nárokuje víc objektů', () => {
  const OBJECTS = [
    { stableId: 'saltFlat', label: 'the salt flat' },
    { stableId: 'ironMast', label: 'the iron mast' },
    { stableId: 'saltWind', label: 'the wind off the salt' },
  ];

  const docWith = (entities: unknown): WorldDoc =>
    ({ sim: { sockets: { sharedPad: [4, 2] }, entities } }) as unknown as WorldDoc;

  const moveSharedPad = (doc: WorldDoc) =>
    preservedBy(OBJECTS, {
      stableId: 'someoneElse',
      behavior: [{ op: 'replace', path: '/sim/sockets/sharedPad/0' }],
      appearance: [],
      shape: null,
    }, doc);

  /**
   * ⚠ **Druhý nárok se počítá stejně jako první.** „První nárok vyhrává" bylo
   * pro toho druhého falešné „nedotčen": zápis na socket ho posouvá úplně
   * stejně, jen se o něm dozvěděla mapa později.
   */
  it('jmenuje každého, kdo na tom socketu stojí, ne jen prvního', () => {
    const preserved = moveSharedPad(
      docWith({
        saltFlat: { role: 'terrain', socket: 'sharedPad' },
        ironMast: { role: 'hero', socket: 'sharedPad' },
        saltWind: { role: 'effect', socket: 'elsewhere' },
      }),
    );

    expect(preserved).toEqual(['the wind off the salt']);
  });

  /**
   * Kontrola k předchozímu: bez ní projde i mapa, která po zápisu na socket
   * označí za dotčené všechno. Jediný nárok krátí seznam právě o jeden objekt.
   */
  it('jediný nárok odebere jediný objekt', () => {
    const preserved = moveSharedPad(
      docWith({
        saltFlat: { role: 'terrain', socket: 'sharedPad' },
        ironMast: { role: 'hero', socket: 'elsewhere' },
        saltWind: { role: 'effect', socket: null },
      }),
    );

    expect(preserved).toEqual(['the iron mast', 'the wind off the salt']);
  });
});
