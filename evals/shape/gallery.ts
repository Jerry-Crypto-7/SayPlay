/**
 * Dvanáct tvarů psaných rukou — strop jazyka, ne schopnost modelu (P13 vlna 1 T7).
 *
 * ## Na co tenhle soubor odpovídá
 *
 * Brána K1 se ptá: *umí ten jazyk dělat různé věci?* Kdyby programy psal model,
 * měřila by se schopnost modelu a odpověď by nešla oddělit od promptu. Tohle
 * jsou proto **ruční programy**: když jazyk nedokáže říct dvanáct různých věcí
 * ani člověku, který jeho tabulku zná nazpaměť, nemá smysl ho učit model —
 * a to je rozhodnutí o šesti týdnech práce, ne o jednom souboru.
 *
 * Dvanáct jmen předepisuje úloha: kost, kořen, klenba, mušle, stroj, sloup,
 * mrak, schodiště, kotel, plod, vlna, síť. Nejsou to kategorie k vyplnění —
 * jsou vybrané tak, aby se **navzájem nedaly napsat toutéž kombinací uzlů**.
 * Kost je zakřivená a nesouměrná, stroj je hranatý a bez plynulého sčítání,
 * síť je skoro samá díra, mrak je skoro samý objem.
 *
 * ## Orientace je nesená vlastnost, ne kosmetika
 *
 * Tři tvary jsou nakloněné a **každý v jiné rovině**: mušle v `x–y`, kost
 * v `y–z`, a to opačným směrem, než stoupá schodiště. Naměřeno 29. 8. 2026:
 * dokud kost stála svisle, měřidlo ji od sloupu nerozeznalo (**0,1036** proti
 * prahu 0,15); nakloněná do téže roviny jako mušle dala **0,1297**; nakloněná
 * do `y–z` po směru schodiště **0,1658**; proti jeho směru **0,2142**.
 * Kdo tyhle rotace bude „uklízet", shodí bránu K1.
 *
 * ## Dvě věci, které tu schválně nejsou
 *
 * 1. **Žádná barva ani materiál kromě `materialIntent`.** Rozmanitost se soudí
 *    z geometrie — jinak by stačilo obarvit dvanáctkrát kouli. Měřidlo v
 *    `measure-diversity.ts` barvu nevidí a vidět nemá.
 * 2. **Žádný tvar nad ~45 vyhodnocení pole na buňku.** Dvanáct programů se
 *    meshuje v jedné testovací sadě; kdyby každý stál jako referenční tvar
 *    z T5, běžela by minutu a nikdo by ji nepouštěl.
 */

import type { Bounds3, ShapeNode, ShapeProgram } from '../../src/shape/types';

/** Jeden kus galerie. `label` je to, co má být na tvaru poznat. */
export interface GalleryEntry {
  readonly id: string;
  /** Anglicky — je to viditelná měď produktu, stránka `/gallery` to vypíše. */
  readonly label: string;
  readonly program: ShapeProgram;
}

function entry(
  id: string,
  label: string,
  materialIntent: string,
  bounds: Bounds3,
  nodes: readonly ShapeNode[],
  anchors: ShapeProgram['anchors'] = [],
): GalleryEntry {
  return {
    id,
    label,
    program: {
      shapeId: id,
      stableId: id,
      nodes,
      root: nodes.length - 1,
      targetBounds: bounds,
      anchors,
      materialIntent,
      priority: 5,
    },
  };
}

/**
 * Kvádr se rezervou kolem tvaru. **Nikdy těsný** — `paddedBounds` v
 * `surface-nets.ts` ukázal, že tvar přetékající svůj kvádr o 1e-6 zmizí celý
 * (0 trojúhelníků), ne že se v něm udělá díra.
 */
const box = (x: number, yMin: number, yMax: number, z: number): Bounds3 => ({
  min: [-x, yMin, -z],
  max: [x, yMax, z],
});

export const GALLERY: readonly GalleryEntry[] = [
  // 1 — kost. Zakřivená a nesouměrná: jedna velká hlavice nahoře, dvě malé
  // dole, a `bend` ohýbá celý kus najednou, ne shodou náhod každý díl zvlášť.
  // Nejmenší mesh v galerii (3 872 trojúhelníků).
  entry('bone', 'Bone', 'bone', { min: [-0.65, -1.15, -1.35], max: [0.65, 1.85, 1.75] }, [
    { kind: 'capsule', height: 1.55, radius: 0.14 },
    { kind: 'ellipsoid', radii: [0.33, 0.28, 0.3] },
    { kind: 'translate', child: 1, offset: [0, 0.84, 0] },
    { kind: 'ellipsoid', radii: [0.19, 0.16, 0.17] },
    { kind: 'translate', child: 3, offset: [0.2, -0.8, 0] },
    { kind: 'mirror', child: 4, axis: 'x' },
    { kind: 'union', children: [0, 2, 5], k: 0.13 },
    { kind: 'bend', child: 6, axis: 'x', curvature: 0.6 },
    { kind: 'rotate', child: 7, yaw: 0, pitch: -0.9, roll: 0 },
  ]),

  // 2 — kořen. Jediný tvar, který používá `arrayAlongCurve`: bez křivky se
  // větvící kořen napsat nedá, a to je celý důvod, proč ten uzel v jazyce je.
  // **Kapsle je delší a tlustší, než na rozteč křivky stačí.** Uzel kopie
  // neotáčí do směru křivky, takže sousedi se míjeli o 0,2 v `x` a kořen se
  // vykreslil jako hromádka oddělených pilulek. Spravuje se to velikostí kusu,
  // ne počtem kopií — počet je zároveň cena na buňku.
  entry('root', 'Root', 'wood', box(1.45, -1.25, 1.65, 1.45), [
    { kind: 'capsule', height: 0.75, radius: 0.14 },
    { kind: 'taper', child: 0, axis: 'y', amount: 0.3 },
    {
      kind: 'arrayAlongCurve',
      child: 1,
      count: 6,
      points: [
        [0, 1.2, 0],
        [0.3, 0.5, 0.1],
        [0.6, -0.2, -0.2],
        [1.0, -0.9, 0.1],
      ],
    },
    { kind: 'radialArray', child: 2, count: 3, axis: 'y', radius: 0.15 },
    { kind: 'cylinder', height: 0.6, radius: 0.16 },
    { kind: 'translate', child: 4, offset: [0, 1.1, 0] },
    { kind: 'union', children: [3, 5], k: 0.15 },
  ]),

  // 3 — klenba. `bend` je tu jediná operace, která z rovného sloupu udělá
  // oblouk; bez ní by se klenba musela poskládat z dvaceti otočených kusů.
  entry('vault', 'Vault', 'stone', { min: [-1.65, -1.45, -0.65], max: [1.65, 1.45, 2.65] }, [
    { kind: 'box', size: [0.22, 2.2, 0.5] },
    { kind: 'bend', child: 0, axis: 'z', curvature: 1.15 },
    { kind: 'repeat', child: 1, count: 3, step: [0, 0, 0.9] },
    { kind: 'box', size: [3.0, 0.18, 2.6] },
    { kind: 'translate', child: 3, offset: [0, -1.15, 0.9] },
    { kind: 'union', children: [2, 4], k: 0.06 },
  ]),

  // 4 — mušle. Zkroucení kužele plus devět zkroucených žeber po obvodu, celé
  // nakloněné jako skutečná ulita. Jediný tvar, kde `twist` nese celou
  // identitu — bez něj je to kužel.
  entry('shell', 'Shell', 'shell', { min: [-1.25, -1.25, -0.85], max: [1.25, 1.25, 0.85] }, [
    { kind: 'cone', height: 2.0, radius: 0.62 },
    { kind: 'taper', child: 0, axis: 'y', amount: 0.7 },
    { kind: 'twist', child: 1, axis: 'y', radiansPerUnit: 2.6 },
    { kind: 'capsule', height: 1.8, radius: 0.055 },
    { kind: 'translate', child: 3, offset: [0.3, 0, 0] },
    { kind: 'twist', child: 4, axis: 'y', radiansPerUnit: 2.6 },
    { kind: 'radialArray', child: 5, count: 9, axis: 'y', radius: 0.02 },
    { kind: 'union', children: [2, 6], k: 0.05 },
    { kind: 'rotate', child: 7, yaw: 0, pitch: 0, roll: 0.75 },
  ]),

  // 5 — stroj. **Jediný program bez jediného `k`**, tedy bez plynulého sčítání.
  // Když se galerie tváří blobovitě, tenhle tvar je důkaz, že to dělá `k`
  // a ne jazyk — přesně na to se ptá druhá odrážka brány H1.
  entry('machine', 'Machine', 'metal', box(0.95, -0.65, 1.25, 0.75), [
    { kind: 'box', size: [1.4, 0.7, 0.9] },
    { kind: 'cylinder', height: 1.1, radius: 0.16 },
    { kind: 'translate', child: 1, offset: [0.42, 0.55, 0] },
    { kind: 'repeat', child: 2, count: 3, step: [-0.42, 0, 0] },
    { kind: 'box', size: [1.6, 0.14, 1.1] },
    { kind: 'translate', child: 4, offset: [0, -0.42, 0] },
    { kind: 'torus', majorRadius: 0.3, minorRadius: 0.07 },
    { kind: 'rotate', child: 6, yaw: 0, pitch: 1.5708, roll: 0 },
    { kind: 'translate', child: 7, offset: [0, 0, 0.55] },
    { kind: 'union', children: [0, 3, 5, 8] },
  ]),

  // 6 — sloup. Kanelura vzniká **odečtem pole**, ne přidáváním: dvanáct
  // odečtených válců kolem osy. Je to nejlevnější způsob, jak z válce udělat
  // něco, co vypadá stavěné.
  entry('column', 'Column', 'stone', box(0.65, -1.55, 1.55, 0.65), [
    { kind: 'cylinder', height: 2.4, radius: 0.42 },
    { kind: 'cylinder', height: 2.6, radius: 0.09 },
    { kind: 'radialArray', child: 1, count: 12, axis: 'y', radius: 0.42 },
    { kind: 'subtract', children: [0, 2] },
    { kind: 'box', size: [1.0, 0.16, 1.0] },
    { kind: 'translate', child: 4, offset: [0, -1.28, 0] },
    { kind: 'mirror', child: 5, axis: 'y' },
    { kind: 'union', children: [3, 6], k: 0.05 },
  ]),

  // 7 — mrak. Opak stroje: `k = 0,55` je největší plynulost v galerii a
  // `displace` na to položí šum. Nemá jedinou hranu.
  entry('cloud', 'Cloud', 'vapor', { min: [-1.45, -1.05, -1.05], max: [1.45, 1.15, 1.05] }, [
    { kind: 'sphere', radius: 0.55 },
    { kind: 'translate', child: 0, offset: [-0.6, 0.05, 0.1] },
    { kind: 'sphere', radius: 0.72 },
    { kind: 'sphere', radius: 0.48 },
    { kind: 'translate', child: 3, offset: [0.72, -0.1, -0.15] },
    { kind: 'sphere', radius: 0.4 },
    { kind: 'translate', child: 5, offset: [0.2, 0.4, 0.3] },
    { kind: 'union', children: [1, 2, 4, 6], k: 0.55 },
    { kind: 'displace', child: 7, amplitude: 0.09, frequency: 2.4, seed: 11 },
  ]),

  // 8 — schodiště. `repeat` s krokem **ve dvou osách naráz** — jediný tvar,
  // kde krok pole není rovnoběžný s osou. Proto ho nedrží svislé sloupky, ale
  // **schodnice**: trám nakloněný přesně o `atan(0,24 / 0,34)`, tedy o stoupání
  // toho pole. Se sloupky se stupně dotýkaly nosníku jen u třetího schodu
  // a zbylých sedm viselo ve vzduchu.
  entry('staircase', 'Staircase', 'stone', { min: [-0.75, -0.55, -0.45], max: [0.75, 2.25, 2.75] }, [
    { kind: 'box', size: [1.1, 0.16, 0.42] },
    { kind: 'repeat', child: 0, count: 8, step: [0, 0.24, 0.34] },
    { kind: 'box', size: [0.13, 0.34, 3.3] },
    { kind: 'rotate', child: 2, yaw: 0, pitch: -0.6145, roll: 0 },
    { kind: 'translate', child: 3, offset: [0.55, 0.7, 1.19] },
    { kind: 'mirror', child: 4, axis: 'x' },
    { kind: 'union', children: [1, 5], k: 0.04 },
  ]),

  // 9 — kotel. Jediný **dutý** tvar v galerii, a jediný, který používá
  // `intersect` s nekonečnou rovinou jako řez. Odečet dá stěnu, řez ji otevře.
  // **Normála roviny míří nahoru, ne dolů.** `sdPlane` je záporné na té straně,
  // kam normála **nemíří**, takže `[0, -1, 0]` nechalo `y > -0,3` — z kotle
  // zbyl límec a tři nohy pod ním visely ve vzduchu.
  entry('cauldron', 'Cauldron', 'iron', { min: [-1.05, -1.25, -1.05], max: [1.05, 0.55, 1.05] }, [
    { kind: 'sphere', radius: 0.85 },
    { kind: 'sphere', radius: 0.72 },
    { kind: 'subtract', children: [0, 1] },
    { kind: 'plane', normal: [0, 1, 0], offset: 0.3 },
    { kind: 'intersect', children: [2, 3] },
    { kind: 'torus', majorRadius: 0.83, minorRadius: 0.07 },
    { kind: 'translate', child: 5, offset: [0, 0.28, 0] },
    { kind: 'cylinder', height: 0.5, radius: 0.09 },
    { kind: 'radialArray', child: 7, count: 3, axis: 'y', radius: 0.55 },
    { kind: 'translate', child: 8, offset: [0, -0.8, 0] },
    { kind: 'union', children: [4, 6, 9], k: 0.05 },
  ]),

  // 10 — plod. Rýhy vznikají **odečtem otočeného pole**, takže nejsou svislé
  // jako kanelura sloupu, ale stáčejí se — týž uzel, jiný výsledek.
  entry('fruit', 'Fruit', 'wax', { min: [-1.05, -1.15, -1.05], max: [1.05, 1.45, 1.05] }, [
    { kind: 'ellipsoid', radii: [0.8, 0.9, 0.8] },
    { kind: 'capsule', height: 1.4, radius: 0.13 },
    { kind: 'rotate', child: 1, yaw: 0, pitch: 0, roll: 0.5 },
    { kind: 'radialArray', child: 2, count: 6, axis: 'y', radius: 0.85 },
    { kind: 'subtract', children: [0, 3], k: 0.1 },
    { kind: 'cylinder', height: 0.45, radius: 0.07 },
    { kind: 'translate', child: 5, offset: [0, 1.05, 0] },
    { kind: 'union', children: [4, 6], k: 0.08 },
  ]),

  // 11 — vlna. `bend` kolem `z` stočí dlouhou desku do hřebene, `displace` na
  // něj položí vlnky. **Ohyb musí být až nad sjednocením** — dokud ohýbal jen
  // desku, zůstaly lišty rovné a odpadly od ní. Amplituda je 0,14, ne 0,28:
  // nad ohnutou deskou nese šum dál a při 0,28 už jiné semínko měnilo tvar
  // (naměřeno 0,0403 proti stropu 0,0375).
  entry('wave', 'Wave', 'water', { min: [-1.55, -0.75, -0.95], max: [1.55, 1.35, 0.95] }, [
    { kind: 'box', size: [2.6, 0.16, 1.5] },
    { kind: 'displace', child: 0, amplitude: 0.14, frequency: 1.6, seed: 3 },
    { kind: 'box', size: [2.7, 0.1, 0.1] },
    { kind: 'translate', child: 2, offset: [0, -0.26, 0.6] },
    { kind: 'mirror', child: 3, axis: 'z' },
    { kind: 'union', children: [1, 4], k: 0.06 },
    { kind: 'bend', child: 5, axis: 'z', curvature: 0.45 },
  ]),

  // 12 — síť. Dvě pole napříč sebou. Je to nejvíc díry ze všech dvanácti a
  // proto nejtvrdší zkouška pro profil siluet: z odstupu to čte jako deska.
  entry('net', 'Net', 'rope', { min: [-1.45, -0.35, -1.45], max: [1.45, 0.35, 1.45] }, [
    { kind: 'box', size: [2.4, 0.06, 0.06] },
    { kind: 'repeat', child: 0, count: 7, step: [0, 0, 0.34] },
    { kind: 'translate', child: 1, offset: [0, 0, -1.02] },
    { kind: 'box', size: [0.06, 0.06, 2.4] },
    { kind: 'repeat', child: 3, count: 7, step: [0.34, 0, 0] },
    { kind: 'translate', child: 4, offset: [-1.02, 0, 0] },
    { kind: 'union', children: [2, 5] },
    { kind: 'torus', majorRadius: 1.22, minorRadius: 0.08 },
    { kind: 'union', children: [6, 7], k: 0.03 },
  ]),
];

/** Jména, která úloha T7 předepisuje. Pin, aby se galerie nescvrkla. */
export const GALLERY_IDS = [
  'bone',
  'root',
  'vault',
  'shell',
  'machine',
  'column',
  'cloud',
  'staircase',
  'cauldron',
  'fruit',
  'wave',
  'net',
] as const;

/** Semínko relace pro galerii. Meshing je deterministický. */
export const GALLERY_SEED = 20260829;

/**
 * Kolikátá buňka mřížky tomu tvaru patří.
 *
 * **Buňku určuje jméno, ne pořadí v dodaném poli.** Stránka `/gallery` skládá
 * popisky z celé galerie, ale kusy přidává po jednom, jak dojdou z fronty —
 * a když se některý nezmešuje, zbytek se v mřížce posune o buňku doleva, pod
 * cizí popisek. Naměřeno 31. 8. 2026: při třech selháních (`root`, `shell`,
 * `column`) stál kotel pod popiskem `Column` a síť pod `Cauldron`. Brána K1
 * by pak soudila tvary pod cizími jmény.
 */
export function galleryIndex(id: string): number {
  const at = GALLERY.findIndex((item) => item.id === id);
  if (at === -1) throw new Error(`gallery has no shape ${id}`);
  return at;
}

export function galleryEntry(id: string): GalleryEntry {
  const found = GALLERY.find((item) => item.id === id);
  if (found === undefined) throw new Error(`gallery has no shape ${id}`);
  return found;
}
