/**
 * Třetí větev mezijazyka: **program tvaru**.
 *
 * `src/ir` říká, co svět dělá. `src/geom` říká, z jakých kusů kitu je
 * postavený. Tenhle soubor říká, jak vypadá hrdinský objekt, pro který kit
 * kus nemá — kost, kořen, klenba, mušle. Model emituje pole vzdáleností
 * (signed distance field, zkráceně SDF: funkce, která pro každý bod prostoru
 * vrátí vzdálenost k nejbližšímu povrchu) a ručně psaný meshovač z něj
 * v prohlížeči vyrobí trojúhelníky.
 *
 * **Tvar tabulky je opsaný z `src/geom/program.ts` schválně** — ploché pole
 * uzlů, potomek je index, ne vnořený objekt, a index potomka je striktně nižší
 * než index rodiče. Model, který se naučil psát jednu větev, píše druhou
 * stejně, a rozpočtová brána je stejný průchod odspodu nahoru bez rekurze.
 *
 * **Primitiva stojí v počátku a nenesou umístění.** Kdo chce kouli o kus dál,
 * napíše nad ni `translate`. Je to o uzel dráž a je to jediný důvod, proč se
 * vyhodnocovač pole (`field.ts`, vlna 1 T4) skládá ze dvou případů — primitivum
 * je vzdálenostní funkce, transformace je změna souřadnic — místo ze tří.
 * `GeomProgram` to má obráceně (`at`/`yaw`/`scale` přímo na tvarovém uzlu),
 * protože tam se kusy kitu **umísťují**, ne skládají do jednoho tělesa.
 *
 * **Tenhle soubor neimportuje `zod` ani `three`.** Meshovací worker (vlna 1 T4)
 * čte právě tyhle typy a nemá důvod tahat s sebou validační knihovnu; kontrolu
 * dělá `schema.ts` jednou, na hranici, než program odejde do workeru.
 *
 * Co v programu **schválně není**: rozlišení mřížky, kvalita, cena ani pořadí
 * meshingu (design book §9.5). To jsou rozhodnutí potrubí, ne modelu — kdyby
 * si je model psal sám, nešlo by tentýž objekt přemeshovat v jiné přesnosti
 * bez toho, aby se změnil program, a hot-swap by přestal být poctivý.
 */

/** Bod nebo vektor v souřadnicích tvaru. Jednotka je metr. */
export type Vec3 = readonly [number, number, number];

/** Osa. Primitiva, která ji mají, stojí podél `y`. */
export type Axis = 'x' | 'y' | 'z';

/** Kvádr opsaný tvaru. `min` je po složkách menší nebo rovno `max`. */
export interface Bounds3 {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * Kde na hotovém tvaru sedí socket — místo, na které se dá něco pověsit nebo
 * do kterého se dá vstoupit. Souřadnice jsou **v souřadnicích tvaru**, ne
 * meshe: mesh se při změně rozlišení mění, kotva ne. To je celý důvod, proč
 * objekt přežije výměnu podoby beze změny identity (vlna 3, brána K3).
 */
export interface AnchorSpec {
  readonly name: string;
  readonly at: Vec3;
  /** Kam kotva míří. Chybí, když na orientaci nezáleží. */
  readonly normal?: Vec3;
}

/* ------------------------------------------------------------------ *
 * Slovník uzlů — design book §7.2. Pořadí je pořadí té sekce.
 * ------------------------------------------------------------------ */

/** Deset těles, ze kterých se skládá všechno ostatní. */
export const PRIMITIVE_KINDS = [
  'sphere',
  'box',
  'roundBox',
  'capsule',
  'cylinder',
  'cone',
  'torus',
  'plane',
  'prism',
  'ellipsoid',
] as const;

/** Tři kombinace, každá s plynulostí `k`. `k = 0` je ostrá hrana. */
export const COMBINATION_KINDS = ['union', 'subtract', 'intersect'] as const;

/** Čtyři transformace. `rotate` je volné, ve třech osách — konec kvadrantů. */
export const TRANSFORM_KINDS = ['translate', 'rotate', 'scale', 'mirror'] as const;

/** Čtyři deformace. Ohýbají prostor, ne tabulku. */
export const DEFORMATION_KINDS = ['twist', 'bend', 'taper', 'displace'] as const;

/** Tři pole. Tohle jsou uzly, které dělají žebra, kořeny, mosty i schodiště. */
export const ARRAY_KINDS = ['repeat', 'radialArray', 'arrayAlongCurve'] as const;

/** Jedno maskování — aby šlo pole omezit bez toho, aby model psal podmínky. */
export const MASK_KINDS = ['clip'] as const;

/** Celý slovník. Test drží připnuté, že se s ním schéma nerozejde. */
export const SHAPE_NODE_KINDS = [
  ...PRIMITIVE_KINDS,
  ...COMBINATION_KINDS,
  ...TRANSFORM_KINDS,
  ...DEFORMATION_KINDS,
  ...ARRAY_KINDS,
  ...MASK_KINDS,
] as const;

export type ShapeNodeKind = (typeof SHAPE_NODE_KINDS)[number];

/* ------------------------------------------------------------------ *
 * Rozpočty — design book §7.3.
 * ------------------------------------------------------------------ */

/**
 * Stropy jazyka.
 *
 * - `maxNodes` **48** — nad tím rostou náklady vyhodnocení lineárně a model
 *   přestává být přesný. Pole se vyhodnocuje v každé buňce mřížky, takže uzel
 *   navíc stojí při 64³ dalších 262 144 vyhodnocení, ne jedno.
 * - `maxDepth` **8** — nejdelší cesta stromem. Drží čitelnost a předvídatelnost.
 * - `maxInstances` **256** — kolik kopií vyleze **po rozvinutí** polí. Sám
 *   `maxNodes` nechrání nic: `repeat` 32 nad `radialArray` 32 je 1024 kopií
 *   ze dvou řádků.
 * - `maxCurvePoints` **8** — kontrolních bodů Catmull-Rom křivky.
 * - `maxEvaluations` **512** — kolikrát se **doopravdy zavolá vzdálenostní
 *   funkce** na jednu buňku mřížky. Přibylo 28. 8. 2026 po nezávislém review
 *   a je to jediný z pěti stropů, který měří cenu: `maxInstances` počítá
 *   listové kopie, takže **sdílený podstrom je v něm zdarma**. Naměřený
 *   protipříklad měl 8 řádků, hloubku 8 a `maxInstances` přesně 256 — a stál
 *   **1317 vyhodnocení na buňku, z toho 1024 šumů**, tedy při 96³ devět set
 *   milionů vzorků šumu za program, který brána ocenila jako „256 kopií koule".
 */
export const SHAPE_LIMITS = {
  maxNodes: 48,
  maxDepth: 8,
  maxInstances: 256,
  maxCurvePoints: 8,
  maxEvaluations: 512,
} as const;

/**
 * Žebřík detailu — v jaké mřížce se tvar meshuje a co to smí stát.
 *
 * **Rozhodnuto uživatelem 29. 8. 2026 po měření v P13 vlně 1 T5.** Design book
 * §11.2 měl `hrubá = 32³, vysoká = 64³`; naměřeno v produkčním buildu
 * a v prohlížeči **64³ nejde**, a to ze dvou nezávislých důvodů naráz:
 *
 * - **čas** — 1 254 až 1 456 ms na jeden hrdinský objekt, měřeno uvnitř workeru;
 * - **trojúhelníky** — 47 680 na objekt, takže **tři objekty samy o sobě
 *   přetečou strop celé scény** (120 000 z úlohy T2).
 *
 * Fronta v `mesh-client.ts` je navíc sériová schválně („Tvary chodí po jednom",
 * pořadí podle `priority` je vlastnost produktu), takže se tři objekty nedají
 * schovat za paralelní pracovníky.
 *
 * **Odkud jsou stropy.** `maxMs` je nejhorší naměřený běh plus rezerva na
 * porotcův notebook, o kterém nic nevíme — 228 → 350 a 2 285 → 2 600.
 *
 * ⚠ **`high.maxMs` se 31. 8. 2026 zvedlo z 900 na 2 600 a stojí za tím oprava
 * metody, ne posun laťky.** Původních 900 vzniklo z 607 ms naměřených na
 * `/dev/mesh-budget`, což je stránka, která **schválně nic nevykresluje** —
 * jenže v produktu meshing běží vedle živé renderovací smyčky, a to je jiná
 * cena. Přeměřeno na `/gallery` nad dvanácti ručními tvary:
 *
 * | Podmínka | Nejdražší tvar (`root`) |
 * |---|---:|
 * | bez plátna, hlavní vlákno, nejlepší ze tří | 927 ms |
 * | s běžící renderovací smyčkou, ve workeru | 1 273 – 2 285 ms |
 *
 * Starý strop tedy odmítal **tři až šest z dvanácti ručně napsaných tvarů**,
 * tedy legitimní obsah, a odmítal zrovna ty nejsložitější. Nová hodnota je
 * nejhorší naměřený běh (2 285 ms) plus ~14 %.
 *
 * **Co se tím ztratilo, ať to nikdo nemusí odvozovat:** wall-clock strop je na
 * hlídání ceny slabý nástroj — měří stroj a zátěž kolem, ne program. Monstra
 * drží `maxTriangles`, což je míra nezávislá na stroji (tři legální uzly daly
 * 190 442 trojúhelníků). Skutečná oprava je soudit cenu v **počtu vyhodnocení**,
 * a ta patří do vlny 3 T20 / vlny 5 T26 spolu s `T5-evalcap` — obojí je totéž
 * selhání: rozpočet naměřený v jiné podmínce, než v jaké se vynucuje.
 *
 * Stropy nejsou odvozené ze slibu „hratelné do tří sekund", ale obstojí proti
 * němu: **rozhoduje `rough`**, a ten se nehnul — hrubý svět o třech objektech
 * se vejde do 1,05 s. Zpevnění na `high` běží až nad světem, který je hratelný,
 * a smí proto trvat déle.
 *
 * `maxTriangles` u `high` drží tři objekty na 96 000 pod stropem scény; u
 * `rough` je to naměřených 12 016 se stejnou rezervou.
 *
 * ⚠ **96³ zůstává mimo žebřík**, jak §11.2 říkala — 3 593 až 4 033 ms a
 * 106 696 trojúhelníků je jen pro export, nikdy pro scénu.
 */
export const MESH_DETAIL = {
  rough: { resolution: 32, maxMs: 350, maxTriangles: 16_000 },
  high: { resolution: 48, maxMs: 2_600, maxTriangles: 32_000 },
} as const;

/* ------------------------------------------------------------------ *
 * Uzly.
 * ------------------------------------------------------------------ */

/** Koule o poloměru `radius` v počátku. */
export interface SphereNode {
  readonly kind: 'sphere';
  readonly radius: number;
}

/** Kvádr. `size` je **plný** rozměr, ne poloviční — vyhodnocovač si ho půlí sám. */
export interface BoxNode {
  readonly kind: 'box';
  readonly size: Vec3;
}

/** Kvádr se zaoblenými hranami. `radius` se od `size` neodečítá, přičítá se k němu. */
export interface RoundBoxNode {
  readonly kind: 'roundBox';
  readonly size: Vec3;
  readonly radius: number;
}

/** Válec s kulovými čepičkami podél `y`. `height` je vzdálenost středů čepiček. */
export interface CapsuleNode {
  readonly kind: 'capsule';
  readonly height: number;
  readonly radius: number;
}

/** Válec podél `y`, `height` je celá výška. */
export interface CylinderNode {
  readonly kind: 'cylinder';
  readonly height: number;
  readonly radius: number;
}

/** Kužel podél `y`, podstavou dolů, špičkou nahoru. */
export interface ConeNode {
  readonly kind: 'cone';
  readonly height: number;
  readonly radius: number;
}

/** Prstenec v rovině `xz`, osa `y`. */
export interface TorusNode {
  readonly kind: 'torus';
  readonly majorRadius: number;
  readonly minorRadius: number;
}

/**
 * Poloprostor. Není to plocha bez tloušťky — je to všechno pod rovinou, takže
 * se `intersect`em dá cokoliv uříznout. `normal` nemusí být jednotkový,
 * vyhodnocovač si ho normalizuje.
 */
export interface PlaneNode {
  readonly kind: 'plane';
  readonly normal: Vec3;
  readonly offset: number;
}

/** Pravidelný n-boký hranol podél `y`. `radius` je poloměr opsané kružnice. */
export interface PrismNode {
  readonly kind: 'prism';
  readonly sides: number;
  readonly radius: number;
  readonly height: number;
}

/** Elipsoid s poloosami `radii`. */
export interface EllipsoidNode {
  readonly kind: 'ellipsoid';
  readonly radii: Vec3;
}

export type PrimitiveNode =
  | SphereNode
  | BoxNode
  | RoundBoxNode
  | CapsuleNode
  | CylinderNode
  | ConeNode
  | TorusNode
  | PlaneNode
  | PrismNode
  | EllipsoidNode;

/**
 * Sjednocení. `k` je plynulé sčítání (smooth min) — přechod, který vypadá
 * modelovaně, ne slepeně. Je to ten uzel, kvůli kterému SDF umí organiku
 * a kit kusy ne.
 *
 * **Ostrá hrana se píše vynecháním `k`, ne nulou.** Polynomiální smooth-min
 * dělí `k`, takže `k = 0` je `0/0` = `NaN` na celé ploše, kde se dva potomci
 * potkají — a to je právě ta plocha, kvůli které se uzel píše. Schéma proto
 * nulu nepustí; `k` chybí = obyčejné minimum.
 */
export interface UnionNode {
  readonly kind: 'union';
  readonly children: readonly number[];
  readonly k?: number;
}

/**
 * Rozdíl. **První potomek je základ**, ostatní se od něj odečítají — pořadí
 * tady nese význam, na rozdíl od `union` a `intersect`.
 */
export interface SubtractNode {
  readonly kind: 'subtract';
  readonly children: readonly number[];
  readonly k?: number;
}

/** Průnik. S `plane` je z něj řez, s `box` ořez. */
export interface IntersectNode {
  readonly kind: 'intersect';
  readonly children: readonly number[];
  readonly k?: number;
}

export type CombinationNode = UnionNode | SubtractNode | IntersectNode;

/** Posun potomka. */
export interface TranslateNode {
  readonly kind: 'translate';
  readonly child: number;
  readonly offset: Vec3;
}

/**
 * Otočení potomka. Úhly v **radiánech**, libovolné — tohle je ten rozdíl proti
 * `GeomProgram`, kde se otáčelo po kvadrantech. Skládá se v pořadí `yaw`
 * (kolem `y`), pak `pitch` (kolem `x`), pak `roll` (kolem `z`).
 */
export interface RotateNode {
  readonly kind: 'rotate';
  readonly child: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
}

/**
 * Změna měřítka, po osách různá.
 *
 * **Nerovnoměrné měřítko dělá z pole vzdáleností odhad, ne vzdálenost** — po
 * dělení souřadnic různými čísly už funkce nevrací nejkratší vzdálenost
 * k povrchu. Vyhodnocovač proto výsledek **násobí nejmenší** složkou `factor`:
 * to je jediný činitel, který vzdálenost zaručeně nenadstřelí, a nadstřelená
 * vzdálenost je ta nebezpečná — přeskočila by povrch a udělala do tvaru díru.
 *
 * **Do 28. 8. 2026 tu stálo „dělí největší složkou" a bylo to obráceně.**
 * Nezávislé review to spočítalo na spodní mezi schématu: pro
 * `factor [0,05, 0,05, 0,05]` vrátí dělení maximem **čtyřistanásobek**
 * skutečné vzdálenosti, tedy přesně ten směr, který si tenhle odstavec
 * zakazuje. Zápis, který zní jako opatrnost a je to opak, je horší než žádný.
 */
export interface ScaleNode {
  readonly kind: 'scale';
  readonly child: number;
  readonly factor: Vec3;
}

/**
 * Zrcadlo. Není to kopie — je to přeložení souřadnice (`abs`), takže stojí
 * jedno vyhodnocení, ne dvě. Proto se do stropu instancí nezapočítává.
 */
export interface MirrorNode {
  readonly kind: 'mirror';
  readonly child: number;
  readonly axis: Axis;
  readonly about?: number;
}

export type TransformNode = TranslateNode | RotateNode | ScaleNode | MirrorNode;

/** Zkroucení kolem osy. `radiansPerUnit` je úhel na metr podél té osy. */
export interface TwistNode {
  readonly kind: 'twist';
  readonly child: number;
  readonly axis: Axis;
  readonly radiansPerUnit: number;
}

/** Ohnutí. `curvature` je úhel na metr — z rovného sloupu udělá oblouk. */
export interface BendNode {
  readonly kind: 'bend';
  readonly child: number;
  readonly axis: Axis;
  readonly curvature: number;
}

/**
 * Zúžení podél osy. Průřez se násobí `clamp(1 + amount * t, 0,05, 20)`, kde
 * `t` je souřadnice na ose v metrech. Kladné `amount` rozšiřuje ve směru osy,
 * záporné zužuje.
 *
 * **To sevření není opatrnost navíc, je součást kontraktu.** Původní zápis
 * `1 / (1 + amount * t)` má pól v `t = -1/amount` a nezávislé review ukázalo,
 * že rozsah `amount` ten pól nevyloučí: při `amount = 4` nad válcem vysokým
 * 2 m leží pól na `y = -0,25`, tedy **uprostřed tělesa**, a vyhodnocení tam
 * dělí nulou. Mimo souřadnicový rozsah ±64 by se pól dostal až pro
 * `|amount| < 0,0156`, což už není zúžení. Řeší to tedy tvar vzorce, ne mez.
 */
export interface TaperNode {
  readonly kind: 'taper';
  readonly child: number;
  readonly axis: Axis;
  readonly amount: number;
}

/**
 * Rozvlnění povrchu šumem.
 *
 * `seed` je celé číslo, ze kterého si vyhodnocovač odvodí stream `pure-rand`
 * (jediná povolená PRNG projektu, `CLAUDE.md`). **Nikdy `Math.random()`** —
 * dvakrát tentýž program musí dát bitově tentýž tvar, jinak přestane platit
 * cache, hash i přetáčení času.
 */
export interface DisplaceNode {
  readonly kind: 'displace';
  readonly child: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly seed: number;
}

export type DeformationNode = TwistNode | BendNode | TaperNode | DisplaceNode;

/** Řada kopií po pravidelném kroku. `count` počítá **včetně** originálu. */
export interface RepeatNode {
  readonly kind: 'repeat';
  readonly child: number;
  readonly count: number;
  readonly step: Vec3;
}

/** `count` kopií rovnoměrně kolem osy, ve vzdálenosti `radius` od ní. */
export interface RadialArrayNode {
  readonly kind: 'radialArray';
  readonly child: number;
  readonly count: number;
  readonly axis: Axis;
  readonly radius: number;
}

/**
 * `count` kopií rozmístěných podél Catmull-Rom křivky danou `points`. Nejvýš
 * `SHAPE_LIMITS.maxCurvePoints` kontrolních bodů.
 */
export interface ArrayAlongCurveNode {
  readonly kind: 'arrayAlongCurve';
  readonly child: number;
  readonly count: number;
  readonly points: readonly Vec3[];
}

export type ArrayNode = RepeatNode | RadialArrayNode | ArrayAlongCurveNode;

/** Oblast, na kterou `clip` potomka omezí. */
export type ClipRegion =
  | { readonly kind: 'halfSpace'; readonly normal: Vec3; readonly offset: number }
  | { readonly kind: 'box'; readonly center: Vec3; readonly size: Vec3 };

/** Ořez oblastí. Průnik bez toho, aby model musel psát druhé těleso. */
export interface ClipNode {
  readonly kind: 'clip';
  readonly child: number;
  readonly region: ClipRegion;
}

export type ShapeNode =
  | PrimitiveNode
  | CombinationNode
  | TransformNode
  | DeformationNode
  | ArrayNode
  | ClipNode;

/**
 * Program jednoho hrdinského tvaru — design book §9.5.
 *
 * Verze tu schválně není: nese ji obálka `WorldstreamBlueprint`
 * (`version: 'worldstream-v1'`, §9.2), a dvě verze na dvou úrovních jsou dvě
 * místa, kde se dá rozejít.
 */
export interface ShapeProgram {
  /** Identita tvaru uvnitř relace. Klíč, pod kterým dorazí mesh. */
  readonly shapeId: string;
  /** Identita **objektu**, na kterou míří druhá věta. Přežívá výměnu podoby. */
  readonly stableId: string;
  readonly nodes: readonly ShapeNode[];
  readonly root: number;
  /** Kvádr, do kterého se hotový tvar má vejít. Potrubí podle něj normalizuje. */
  readonly targetBounds: Bounds3;
  readonly anchors: readonly AnchorSpec[];
  /** Jméno materiálu z `MaterialSpec`, ne barva. Barvu píše výtvarný systém. */
  readonly materialIntent: string;
  /** Pořadí meshingu. Vyšší jde dřív. */
  readonly priority: number;
}

/* ------------------------------------------------------------------ *
 * Průchody nad tabulkou. Bez zod, aby je uměl i worker.
 * ------------------------------------------------------------------ */

/** Kolik potomků má který uzel. Kombinace několik, primitiva žádné, zbytek jeden. */
export function childIndicesOf(node: ShapeNode): readonly number[] {
  if (node.kind === 'union' || node.kind === 'subtract' || node.kind === 'intersect') {
    return node.children;
  }
  return 'child' in node ? [node.child] : [];
}

/**
 * Kolik kopií vyleze z každého uzlu po rozvinutí polí.
 *
 * Průchod odspodu nahoru — potomek má vždy nižší index než rodič, což vynucuje
 * `structuralIssues` v `schema.ts`, takže hodnota potomka je hotová dřív, než
 * ji někdo čte.
 *
 * **`mirror` násobí jedničkou, na rozdíl od `GeomProgram`.** Tam je zrcadlo
 * druhý umístěný kus a druhý draw call; tady je to `abs()` nad souřadnicí, tedy
 * jedno vyhodnocení. Rozpočet měří cenu vyhodnocení, takže mirror do něj
 * nepatří. Kdyby se počítal jako dva, jazyk by odmítal tvary, které nic nestojí.
 */
export function instanceCounts(nodes: readonly ShapeNode[]): readonly number[] {
  const counts: number[] = [];
  nodes.forEach((node, index) => {
    switch (node.kind) {
      case 'union':
      case 'subtract':
      case 'intersect':
        counts[index] = node.children.reduce((sum, child) => sum + counts[child], 0);
        break;
      case 'repeat':
      case 'radialArray':
      case 'arrayAlongCurve':
        counts[index] = node.count * counts[node.child];
        break;
      default:
        counts[index] = 'child' in node ? counts[node.child] : 1;
    }
  });
  return counts;
}

/**
 * Nejdelší cesta od uzlu dolů, v uzlech. Primitivum je 1.
 *
 * Stejný průchod odspodu nahoru. Hodnota se počítá pro každý řádek, ale
 * rozpočet čte jen `[root]` — a to je poctivé jenom proto, že brána odmítá
 * program s řádkem, na který se z kořene nedá dostat (`structuralIssues`).
 * Dokud to neodmítala, tvrdil tenhle komentář, že se mrtvé řádky „řeší jinde",
 * a nikde se neřešily.
 */
export function depths(nodes: readonly ShapeNode[]): readonly number[] {
  const result: number[] = [];
  nodes.forEach((node, index) => {
    const children = childIndicesOf(node);
    result[index] =
      children.length === 0 ? 1 : 1 + Math.max(...children.map((child) => result[child]));
  });
  return result;
}

/**
 * Kolikrát se vyhodnotí vzdálenostní funkce, když se program spočítá **v jedné
 * buňce mřížky**.
 *
 * Tohle je jediný z pěti stropů, který měří cenu. `instanceCounts` počítá
 * listové kopie a **sdílený podstrom v něm nestojí nic**: uzel, na který
 * ukazují tři rodiče, se vyhodnotí třikrát, ale do kopií se započítá jednou.
 * `displace` je v kopiích za tutéž cenu jako `sphere`, přestože jedno je šum
 * a druhé odmocnina.
 *
 * Průchod je opačný než u kopií: hodnota uzlu je **jeho vlastní vyhodnocení
 * plus všechno, co si k němu vyžádají potomci**, u polí vynásobené počtem
 * kopií. Součet pro `root` je tedy počet volání na buňku, tedy přesně to
 * číslo, kterým se násobí 32³ až 96³.
 */
export function evaluationCounts(nodes: readonly ShapeNode[]): readonly number[] {
  const counts: number[] = [];
  nodes.forEach((node, index) => {
    switch (node.kind) {
      case 'union':
      case 'subtract':
      case 'intersect':
        counts[index] = 1 + node.children.reduce((sum, child) => sum + counts[child], 0);
        break;
      case 'repeat':
      case 'radialArray':
      case 'arrayAlongCurve':
        counts[index] = 1 + node.count * counts[node.child];
        break;
      default:
        counts[index] = 1 + ('child' in node ? counts[node.child] : 0);
    }
  });
  return counts;
}

/**
 * Indexy řádků, na které se z `root` dá dojít.
 *
 * Průchod odshora dolů, protože dosažitelnost se šíří opačně než rozpočty.
 * Bez rekurze: potomek má vždy nižší index, takže stačí jeden sestup polem.
 */
export function reachableFrom(nodes: readonly ShapeNode[], root: number): ReadonlySet<number> {
  const reached = new Set<number>([root]);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (!reached.has(index)) continue;
    for (const child of childIndicesOf(nodes[index])) reached.add(child);
  }
  return reached;
}
