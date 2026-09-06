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

  /**
   * ⚠ **`~1` je lomítko, ne dva znaky** (RFC 6901) — routovaný nález druhého
   * kola nezávislé revize. Klíče dokumentu píše model volně a `rfc6902`, který
   * patch při commitu doopravdy aplikuje, escape rozebírá; syrové `split('/')`
   * ne. Socket doslova pojmenovaný `north/south pad` se pak hledal pod jménem
   * `north~1south pad`, majitel se nenašel a panel by kupoli slíbil, že ji
   * změna nechá být, zatímco jí commit odstěhuje footing.
   */
  it('rozebírá `~1` v cestě jako lomítko, ne jako dva znaky', () => {
    const preserved = preservedBy(
      OBJECTS,
      {
        stableId: 'someoneElse',
        behavior: [{ op: 'move', path: '/sim/sockets/relocated/0' }],
        appearance: [],
        shape: null,
      },
      {
        sim: { sockets: { 'north/south pad': [4, 2] }, entities: { ironMast: { socket: 'north/south pad' } } },
      } as unknown as WorldDoc,
    );

    // Kontrola, že cesta sama nic nezkrátila: bez `from` je stěžeň netknutý.
    expect(preserved).toEqual(['the salt flat', 'the iron mast', 'the wind off the salt']);

    const moved = preservedBy(
      OBJECTS,
      {
        stableId: 'someoneElse',
        behavior: [{ op: 'move', from: '/sim/sockets/north~1south pad', path: '/sim/sockets/relocated' }] as never,
        appearance: [],
        shape: null,
      },
      {
        sim: { sockets: { 'north/south pad': [4, 2] }, entities: { ironMast: { socket: 'north/south pad' } } },
      } as unknown as WorldDoc,
    );

    expect(moved).toEqual(['the salt flat', 'the wind off the salt']);
  });
});

/**
 * **Světlo jmenuje objekt, který osvětluje** — routovaný nález druhého kola
 * nezávislé revize (6. 9. 2026).
 *
 * Vazba `lights[*].entity` se zavírala jako vyvrácená („pole `lights` nemá ani
 * jeden z jedenácti světů"), jenže to tvrzení bylo nepravdivé: `c20` ho má.
 * Adresu o jeden segment kratší nese `valueAt` sama; teprve `…/0/intensity`,
 * kterou uvařená změna `c20`/`r17` doopravdy emituje, vrací číslo bez jména.
 */
describe('preservedBy nad světlem, které patří objektu', () => {
  const OBJECTS = [
    { stableId: 'arrivingTrain', label: 'the arriving train' },
    { stableId: 'railwayTunnel', label: 'the railway tunnel' },
  ];

  const lit = {
    sim: { sockets: {}, entities: {} },
    look: {
      lightRig: {
        ambientIntensity: 0,
        lights: [{ kind: 'advancing headlight', entity: 'arrivingTrain', intensity: 18 }],
      },
    },
  } as unknown as WorldDoc;

  const dim = (path: string) =>
    preservedBy(OBJECTS, { stableId: 'someoneElse', behavior: [], appearance: [{ op: 'replace', path }], shape: null }, lit);

  it('hlubší adresa uvnitř světla jmenuje osvětlený objekt', () => {
    expect(dim('/look/lightRig/lights/0/intensity')).toEqual(['the railway tunnel']);
  });

  /**
   * Kontrola k předchozímu: čte se **záznam toho světla**, ne celý rig. Druhé
   * světlo patřící někomu jinému nesmí z prvního udělat dotčený objekt.
   */
  it('cizí světlo cizí objekt nedotýká', () => {
    const twoLights = {
      sim: { sockets: {}, entities: {} },
      look: {
        lightRig: {
          lights: [
            { kind: 'fill', entity: 'railwayTunnel', intensity: 2 },
            { kind: 'advancing headlight', entity: 'arrivingTrain', intensity: 18 },
          ],
        },
      },
    } as unknown as WorldDoc;

    const preserved = preservedBy(
      OBJECTS,
      { stableId: 'someoneElse', behavior: [], appearance: [{ op: 'replace', path: '/look/lightRig/lights/1/intensity' }], shape: null },
      twoLights,
    );

    expect(preserved).toEqual(['the railway tunnel']);
  });
});
