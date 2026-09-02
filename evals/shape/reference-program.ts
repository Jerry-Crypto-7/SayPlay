/**
 * Referenční tvar, na kterém se měří cena meshingu (P13 vlna 1 T5).
 *
 * ## Proč tenhle soubor vůbec vzniká
 *
 * `WORLDSTREAM-DESIGN-BOOK.md` §11.2 cituje čtyři naměřené dvojice
 * (32³ = 30 ms / 6 786 tri … 96³ = 491 ms / 67 658 tri) a program, na kterém
 * vznikly, popisuje slovy: „realistický strom o ~20 uzlech se `smooth union`,
 * opakováním v prostoru, zkroucením i odečtem". **Ten program se nikdy
 * necommitnul** — měřilo se 27. 8. 2026 mimo repo a nad prototypem, protože
 * `src/shape/surface-nets.ts` vznikl až 29. 8. v úloze T4. Bez commitnutého
 * programu by browserové číslo nemělo s čím porovnávat: rozdíl by mohl být
 * prohlížeč, jiný tvar nebo jiný meshovač, a nešlo by je od sebe odlišit.
 *
 * Tenhle soubor je proto **nová referenční základna**, ne rekonstrukce staré.
 * Node i prohlížeč měří odteď týž řádek kódu nad týmž tvarem, takže rozdíl mezi
 * nimi je vlastnost běhového prostředí a ničeho jiného.
 *
 * ## Co ten tvar je a proč zrovna takový
 *
 * Zkroucený zúžený sloup s korunou, kolem něj tři žebra po obvodu, tři obruče
 * nad sebou, podstavec — a z toho se odečte dutina v koruně a svislá drážka.
 *
 * Vybraly ho **čtyři vlastnosti, o kterých design book §11.2 tvrdí, že cenu
 * tvoří**, a bez kterých by reference měřila práci, kterou produkt nemá:
 *
 * | Vlastnost | Uzel |
 * |---|---|
 * | plynulé sjednocení (`k > 0`) | 5, 15 |
 * | opakování v prostoru | 9 (`radialArray`), 12 (`repeat`) |
 * | zkroucení | 2 (`twist`) |
 * | odečet | 19 (`subtract`) |
 *
 * **Prostý tvar by tu byl nepoctivý.** Celý smysl `ShapeProgram` je, že model
 * píše žebrované, zkroucené a polem opakované objekty — proto ten jazyk
 * `repeat`, `radialArray` a `twist` vůbec má. Reference bez nich měří rozpočet
 * pro objekt, který produkt nikdy nepostaví. Naměřený rozdíl mezi oběma třídami
 * není malý a je v `COST_CLASSES` níž: 10 vyhodnocení na buňku stojí 233 ms,
 * 30 jich stojí 612 ms a 55 už 1 087 ms.
 *
 * ## Připnutá čísla nejsou dekorace
 *
 * `mesh-budget.json` je časová řada a **řada dává smysl jen tehdy, když každý
 * řádek měří tutéž práci**. `REFERENCE_SHAPE_FACTS` proto pinuje 20 uzlů,
 * hloubku 6, 11 rozvinutých kopií a **30 vyhodnocení pole na buňku**. Poslední
 * číslo je jediné, které měří cenu: při 64³ je to 30 × 274 625, tedy 8,2 milionu
 * vyhodnocení. Kdyby se tvar přepsal a evaluace se změnily, každý další řádek
 * reportu by mluvil o jiné práci než ten předchozí a časová řada by byla tiše
 * nesrovnatelná.
 */

import type { Bounds3, ShapeNode, ShapeProgram } from '../../src/shape/types';

/**
 * Kvádr, ve kterém se povrch hledá. **Stejný pro všechny čtyři mřížky**, jinak
 * by hrubší mřížka měřila menší objem a trojúhelníky by se nedaly porovnat.
 * Sedí na tvar s rezervou ~0,1 m, takže se do něj vejde i po zkroucení.
 */
export const REFERENCE_BOUNDS: Bounds3 = {
  min: [-1.35, -1.65, -1.35],
  max: [1.35, 2.25, 1.35],
};

/** Semínko relace. Meshing je deterministický, takže na hodnotě záleží. */
export const REFERENCE_SEED = 20260827;

/**
 * Čtyři mřížky z design booku §11.2. Pořadí je pořadí měření i pořadí řádků
 * v reportu.
 */
export const REFERENCE_GRIDS = [32, 48, 64, 96] as const;

/**
 * Mřížka, která je mimo žebřík a měří se jen pro doklad. AC úlohy T5 původně
 * žádalo strop **400 ms / 32 000 trojúhelníků při 64³**; naměřeno 1 254–1 456 ms
 * a 47 680 trojúhelníků, tedy trojnásobek času a půldruhého násobku
 * trojúhelníků. Uživatel proto 29. 8. 2026 snížil žebřík na 32³/48³ a strop
 * bydlí v `MESH_DETAIL` v `src/shape/types.ts`, protože je to rozhodnutí
 * produktu, ne evaluační sady.
 *
 * Číslo tu zůstává v reportu schválně: bez něj by se za rok nedalo poznat,
 * jestli se žebřík snížil kvůli měření, nebo kvůli náladě.
 */
export const OUT_OF_LADDER_GRIDS = [64, 96] as const;

/**
 * Kolik smí browserové číslo utéct od Node, než se to musí vysvětlit. Spec na
 * tom **nepadá** — jen to zapíše do reportu i do konzole, protože důvod umí
 * napsat člověk, ne aserce.
 */
export const NODE_DRIFT_TOLERANCE = 0.3;

/** Jeden řádek naměřené ceny. Stejný tvar pro Node i pro prohlížeč. */
export interface MeshCostRow {
  readonly ms: number;
  readonly vertices: number;
  readonly triangles: number;
}

/**
 * Základna naměřená v Node/V8 nad tímhle programem, jedno vlákno, nejlepší ze
 * tří běhů po zahřátí JIT — tedy stejnou metodikou jako §11.2, jen nad
 * commitnutým meshovačem.
 *
 * ⚠ **Není to řada z design booku a není s ní srovnatelná.** Ta měřila
 * necommitnutý prototyp nad neznámým tvarem.
 *
 * ## Přeměřeno 2. 9. 2026 — a nebyla to volba, byla to podmínka smyslu
 *
 * `T13-meshpadding` přesunula rezervu jedné buňky do `handleMeshJob()`, takže
 * prohlížeč od té chvíle vzorkuje v `paddedBounds(bounds, resolution)`.
 * Základna z 29. 8. měřila **syrový kvádr**, tedy jinou mřížku a jinou práci.
 * `driftFromNode` v `mesh-budget.json` by pak nesrovnával worker s hlavním
 * vláknem, ale rezervu s jejím vlastním chybějícím obrazem — číslo, které tři
 * dokumenty čtou jako „o kolik je prohlížeč pomalejší".
 *
 * | Mřížka | Trojúhelníky 29. 8. (syrový kvádr) | 2. 9. (s rezervou) |
 * |---|---|---|
 * | 32³ | 12 016 | **10 044** |
 * | 48³ | 26 992 | **24 616** |
 * | 64³ | 47 680 | **45 020** |
 * | 96³ | 106 696 | **103 128** |
 *
 * Časy z téhož běhu: 185,0 → 180,0 · 264,6 → 283,5 · 611,6 → 817,2 ·
 * 2 593,5 → 2 358,7 ms. **Časy se pohnuly oběma směry a rozptyl jednoho
 * stroje je v nich větší než efekt rezervy** — čti z nich řád, ne trend.
 * Počty trojúhelníků jsou naopak deterministické a **sedí na browserový
 * sloupec `mesh-budget.json` na kus přesně**; to je zároveň důkaz, že obě
 * cesty melou tutéž mřížku.
 */
export const NODE_BASELINE: Readonly<Record<number, MeshCostRow>> = {
  32: { ms: 180.0, vertices: 5_003, triangles: 10_044 },
  48: { ms: 283.5, vertices: 12_244, triangles: 24_616 },
  64: { ms: 817.2, vertices: 22_500, triangles: 45_020 },
  96: { ms: 2_358.7, vertices: 51_556, triangles: 103_128 },
};

/**
 * Jak cena roste se složitostí programu. Naměřeno v Node 29. 8. 2026 při 64³
 * nad týmiž mezemi, aby se vědělo, **kterou třídu tvarů rozpočet 400 ms unese**.
 *
 * Není to lineární a fixní podlaha je velká: vzorkování mřížky, surface nets
 * a normály stojí přes 200 ms samy o sobě, ať je program jakkoli prostý.
 *
 * ⚠ **Naměřeno nad syrovým kvádrem, tedy před rezervou z `T13-meshpadding`
 * (2. 9. 2026), a nepřeměřilo se to.** Řádek `reference` je tentýž program
 * jako `NODE_BASELINE[64]`, a ten se s rezervou posunul na 817,2 ms /
 * 45 020 trojúhelníků. Programy pro `light` a `heavy` ale nikde uložené
 * nejsou, takže přeměřit jde jedna třetina tabulky — a tabulka, ve které jeden
 * řádek měří jinou mřížku než dva zbylé, je horší než tabulka o jedno kolo
 * starší. **Čti z ní tvar křivky, ne absolutní čísla**, a než na ni někdo
 * začne pinovat rozpočty, musí se přeměřit celá i s těmi dvěma programy.
 */
export const COST_CLASSES = [
  { name: 'light', evaluationsPerCell: 10, ms: 232.7, triangles: 30_652 },
  { name: 'reference', evaluationsPerCell: 30, ms: 611.6, triangles: 47_680 },
  { name: 'heavy', evaluationsPerCell: 55, ms: 1_086.6, triangles: 44_452 },
] as const;

/** Invarianty tvaru. Pin v `__tests__/reference-program.test.ts`. */
export const REFERENCE_SHAPE_FACTS = {
  nodeCount: 20,
  depth: 6,
  instances: 11,
  evaluationsPerCell: 30,
} as const;

const NODES: readonly ShapeNode[] = [
  // Sloup: válec zúžený nahoru a pak zkroucený kolem své osy.
  { kind: 'cylinder', height: 3, radius: 0.35 }, //                        0
  { kind: 'taper', child: 0, axis: 'y', amount: 0.35 }, //                 1
  { kind: 'twist', child: 1, axis: 'y', radiansPerUnit: 0.6 }, //          2

  // Koruna nad ním, přilepená plynule.
  { kind: 'ellipsoid', radii: [0.8, 0.55, 0.8] }, //                       3
  { kind: 'translate', child: 3, offset: [0, 1.55, 0] }, //                4
  { kind: 'union', children: [2, 4], k: 0.35 }, //                         5

  // Jedno žebro, odkloněné a odsazené → tři kolem osy.
  { kind: 'capsule', height: 1.05, radius: 0.1 }, //                       6
  { kind: 'rotate', child: 6, yaw: 0.4, pitch: 0, roll: 0.85 }, //         7
  { kind: 'translate', child: 7, offset: [0.62, 0.1, 0] }, //              8
  { kind: 'radialArray', child: 8, count: 3, axis: 'y', radius: 0.55 }, // 9

  // Obruč v úrovni ramen → tři nad sebou, shora dolů.
  { kind: 'torus', majorRadius: 0.95, minorRadius: 0.09 }, //             10
  { kind: 'translate', child: 10, offset: [0, 0.85, 0] }, //              11
  { kind: 'repeat', child: 11, count: 3, step: [0, -0.55, 0] }, //        12

  // Podstavec.
  { kind: 'box', size: [2.4, 0.16, 2.4] }, //                             13
  { kind: 'translate', child: 13, offset: [0, -1.45, 0] }, //             14

  // Všechno naráz jedním sjednocením, ne řetězem po dvou: řetěz by přidal tři
  // úrovně hloubky a `SHAPE_LIMITS.maxDepth` je 8.
  { kind: 'union', children: [5, 9, 12, 14], k: 0.14 }, //                15

  // Dutina v koruně a svislá drážka — kvůli odečtu není tvar konvexní.
  { kind: 'sphere', radius: 0.44 }, //                                    16
  { kind: 'translate', child: 16, offset: [0, 1.6, 0] }, //               17
  { kind: 'box', size: [0.5, 2.2, 0.5] }, //                              18
  { kind: 'subtract', children: [15, 17, 18], k: 0.15 }, //               19
];

/**
 * Program, který se měří. Vrací se novou obálkou, aby si ho jeden test nemohl
 * porouchat druhému; tabulku uzlů drží `readonly` typ, ne kopie.
 */
export function referenceProgram(): ShapeProgram {
  return {
    shapeId: 'mesh-budget-reference',
    stableId: 'mesh-budget-reference',
    nodes: NODES,
    root: 19,
    targetBounds: REFERENCE_BOUNDS,
    anchors: [{ name: 'crown', at: [0, 2.1, 0], normal: [0, 1, 0] }],
    materialIntent: 'stone',
    priority: 5,
  };
}
