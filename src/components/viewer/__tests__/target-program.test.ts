import { Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import { GEOM_LIMITS, instanceCounts, parseGeomProgram, type GeomNode } from '@/geom/program';
import { compilePlacements } from '@/geom/placements';
import { PALETTES, SWATCHES, srgbHexToLinear } from '@/kit';

import { clayMaterial } from '../ClayMaterial';
import { buildProgramGroup } from '../scenery';
import { HERO_SLOT, TARGET_PROGRAM } from '../target-program';

/**
 * Cílový snímek je **program**, ne obrázek — a program se dá soudit strojem.
 *
 * Test level `pin` z úlohy T2: krásu tenhle soubor neposuzuje, to je brána K0
 * a dělá ji člověk okem. Pinuje dvě věci, které oko nechytí:
 *
 * 1. **Program je platný ve slovníku produktu.** Kdyby snímek přestal být
 *    vyslovitelný v jazyce, který emituje model, vrátila by se přesně ta vada,
 *    kvůli které se první verze zahodila — ručně malovaný obrázek, na který
 *    produkt nemá cestu.
 * 2. **Vejde se do rozpočtu kreslicích volání.** `GEOM_LIMITS.maxInstances` je
 *    táž hodnota jako `KIT_BUDGETS.maxDrawCallsPerWorld`, takže počet
 *    umístěných kusů je rovnou cena scény.
 */

/** Kolik kusů z programu vyleze po rozvinutí operací. */
function totalInstances(): number {
  const program = parseGeomProgram(TARGET_PROGRAM);
  return instanceCounts(program.nodes)[program.root];
}

describe('cílový snímek jako program geometrie', () => {
  it('je platný program ve slovníku, který emituje model', () => {
    expect(() => parseGeomProgram(TARGET_PROGRAM)).not.toThrow();
  });

  it('drží rozpočet uzlů i umístěných kusů', () => {
    const program = parseGeomProgram(TARGET_PROGRAM);
    expect(program.nodes.length).toBeLessThanOrEqual(GEOM_LIMITS.maxNodes);
    expect(totalInstances()).toBeLessThanOrEqual(GEOM_LIMITS.maxInstances);
  });

  /**
   * Číslo je připíchnuté schválně. Když se pohne, pohnul se i počet kreslicích
   * volání ve snímku — a to je věc, o které se má rozhodnout, ne která se má
   * stát. **Když se pohne, zapiš proč**, nikdy jen nepřepiš.
   *
   * **98 kusů, z toho 37 na most.** Most je nejdražší část scény, protože
   * mostovka, pilíře a obě zábradlí jsou tři opakování — a je zároveň tím, co
   * vede oko do obrazu, takže se na něm nešetří.
   *
   * Číslo spadlo ze 112, když pevnina přestala být skládaná z kvádrů a stala
   * se dvěma výškovými poli: devět kusů skály a útesu se smrsklo na dva.
   */
  it('má naměřený počet kusů, ne o jeden víc kvůli nepozornosti', () => {
    expect(totalInstances()).toBe(98);
  });

  it('se přeloží na plán rozmístění a ten sedí s rozpočtem', () => {
    const placements = compilePlacements(TARGET_PROGRAM);
    expect(placements).toHaveLength(totalInstances());
  });

  /**
   * Podstavec je jediný kus, který v obraze nic nedělá — drží místo hrdinskému
   * objektu z vlny 1 T4. Kdyby ho někdo odstranil jako „prázdný", zmizí
   * i vyhrazené místo v kompozici, a to je vada, kterou obraz sám neukáže.
   */
  it('drží vyhrazené místo pro hrdinský objekt nad podstavcem', () => {
    const program = parseGeomProgram(TARGET_PROGRAM);
    const plinth = program.nodes.find(
      (node): node is Extract<GeomNode, { kind: 'mass' }> =>
        node.kind === 'mass' && node.variant === 'plinth',
    );
    expect(plinth).toBeDefined();
    // Slot je nad podstavcem, ne v něm: hrdina na něm stojí.
    expect(HERO_SLOT[0]).toBe(plinth!.at![0]);
    expect(HERO_SLOT[2]).toBe(plinth!.at![2]);
    expect(HERO_SLOT[1]).toBeGreaterThan(plinth!.at![1]);
  });
});

/**
 * **Barvu nese geometrie, ne materiál** — a když se to rozbije, obraz to sice
 * ukáže, ale jako „nějak to nevypadá", ne jako pojmenovanou vadu.
 *
 * Naměřeno 28. 8. 2026: `clayMaterial` neměl `vertexColors`, takže se celý
 * cílový snímek vykreslil **jediným odstínem hlíny**. Skála splynula se zdmi a
 * obraz ztratil hodnotovou stavbu. Dvě hodiny se do té doby upravovala paleta,
 * která na to nemohla mít vliv, protože se vůbec nedostala na obrazovku.
 *
 * Tenhle popis proto pinuje **oba konce té cesty**:
 * 1. stavitel doopravdy volá `repaint`, tedy ve vrcholech jsou odstíny palety
 *    `worldstream`, ne základní odstíny kitu, se kterými kus ze skladu vyjde,
 * 2. materiál cílového snímku má `vertexColors` zapnuté, takže se ty odstíny
 *    dostanou i do snímku.
 *
 * Obojí je vada, kterou zelená sada bez tohohle testu nechá projít: program,
 * rozpočty i rozmístění zůstanou v pořádku, jen bude scéna béžová.
 */
describe('paleta se dostane do cílového snímku', () => {
  /** Atribut je `Float32Array`, takže se porovnává až po zaokrouhlení. */
  function key(rgb: readonly [number, number, number]): string {
    return rgb.map((channel) => Math.fround(channel)).join(',');
  }

  function hexKeys(swatches: Readonly<Record<string, string>>): Set<string> {
    return new Set(Object.values(swatches).map((hex) => key(srgbHexToLinear(hex))));
  }

  /** Postaví snímek toutéž cestou jako produkt a vybere odstíny z vrcholů. */
  function builtColors(): Set<string> {
    const material = clayMaterial({ vertexColors: true });
    const built = buildProgramGroup(TARGET_PROGRAM, PALETTES.worldstream, material, {
      shadows: true,
      name: 'target',
    });

    const seen = new Set<string>();
    built.object.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const color = node.geometry.getAttribute('color');
      if (color === undefined) return;
      for (let i = 0; i < color.count; i += 1) {
        seen.add(key([color.getX(i), color.getY(i), color.getZ(i)]));
      }
    });

    built.dispose();
    material.dispose();
    return seen;
  }

  it('má ve vrcholech odstíny palety, ne základní odstíny kitu', () => {
    const palette = hexKeys(PALETTES.worldstream);
    const seen = builtColors();

    expect(seen.size).toBeGreaterThan(0);
    expect([...seen].filter((color) => !palette.has(color))).toEqual([]);
  });

  /**
   * Druhá polovina téže vady, a ta ostřejší: kdyby stavitel `repaint` přestal
   * volat, kusy by ve vrcholech nesly `SWATCHES`. Ty se od palety `worldstream`
   * liší ve všech šesti slotech, takže tahle aserce zčervená okamžitě.
   */
  it('žádný vrchol nezůstal v základním odstínu skladu', () => {
    const base = hexKeys(SWATCHES);
    expect([...builtColors()].filter((color) => base.has(color))).toEqual([]);
  });

  it('materiál snímku barvu z geometrie vůbec čte', () => {
    const material = clayMaterial({ vertexColors: true });
    expect(material.vertexColors).toBe(true);
    material.dispose();
  });
});
