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

/** Pět deformací. Ohýbají prostor, ne tabulku. */
export const DEFORMATION_KINDS = ['twist', 'bend', 'taper', 'displace', 'revolve'] as const;

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
  maxDepth: 12,
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
 *
 * ## Čísla výš jsou z 29. 8. a měřila jinou mřížku — závěry drží, čísla ne
 *
 * `T13-meshpadding` (2. 9. 2026) přesunula rezervu jedné buňky do
 * `handleMeshJob()`, takže se vzorkuje v `paddedBounds(bounds, resolution)`.
 * Referenční program dnes dává **10 044** trojúhelníků v mřížce 32 (ne 12 016),
 * **45 020** v 64 (ne 47 680) a **103 128** v 96 (ne 106 696); zdroj je
 * `evals/shape/mesh-budget.json`. Přeměřený tvar stropů:
 *
 * - `rough.maxTriangles = 16 000` proti naměřeným **10 044** — rezerva 59 %,
 *   ne 33 %. Strop se **nezvedá ani nesnižuje**: byl postavený na nejhorším
 *   naměřeném běhu plus polovinu, a ten důvod se nezměnil.
 * - tři objekty při 64³ dají **135 060** trojúhelníků, pořád nad stropem scény
 *   120 000 — 64³ tedy vypadlo ze žebříku správně a i s rezervou by vypadlo.
 * - `high.maxTriangles = 32 000` proti nejtěžšímu ručnímu tvaru `vault`
 *   s **20 352** v mřížce 48 (`evals/shape/gallery-cost.json`).
 *
 * **Nepřepisuj čísla výš** — jsou to naměřené hodnoty, nad kterými se rozhodlo,
 * a rozhodnutí se čte z nich. Tenhle odstavec je ten převod na dnešek.
 */
export const MESH_DETAIL = {
  rough: { resolution: 32, maxMs: 350, maxTriangles: 16_000 },
  high: { resolution: 48, maxMs: 2_600, maxTriangles: 32_000 },
} as const;

/**
 * O kolik smí kvádr tvaru přerůst ten objednaný, měřeno **objemem**.
 *
 * Dvojnásobek: tvar se smí své krabice dotknout a marching cubes klade vrcholy
 * na hrany buněk, takže z ní o kus buňky vyleze. Osmnáctinásobek je naopak
 * program, který si krabici nevšímá.
 *
 * **Stojí to tady, a ne u jedné ze dvou bran, schválně** — soudí se tím dvakrát
 * a ta dvě čísla se nesmějí rozejít: `mesh-gate.ts` jím váží kvádr **naměřený
 * na hotovém meshi**, `schema.ts` kvádr **staticky odhadnutý z programu**
 * (`certainHulls`).
 *
 * ⚠ **Ten odhad NENÍ horní mez, ať název `certainHulls` říká cokoliv — změřeno
 * 9. 9. 2026 v `T14r-boundspad`.** `hullOf` umí třináct druhů uzlů a u všech
 * ostatních vrací `null`; `union` ale neznámé potomky **zahodí** a sloučí jen
 * ty známé. Obal takové unie je proto **dolní** mez skutečného rozsahu, ne
 * horní. Naměřený případ: `observatoryDomeSdf` z případu c04 archivu
 * `create-raw.json` má kořen `union`, jehož první potomek je `clip` (tedy
 * neznámý), obal proto hlásí přesah 0 % na všech osách — a skutečný povrch
 * vyleze pod dno krabice o **52 % její výšky**.
 *
 * Pro `boundsIssue` je to i tak správný nástroj, protože ta funkce dokazuje
 * **přesah**, ne vejití se: k důkazu přesahu stačí jedna část venku, a známé
 * potomky unie obsahuje. Nikdy z toho obalu ale nedokazuj opak — hlavně ne
 * rezervu, kterou má worker vzorkovat.
 *
 * Práh je na téhle straně přísnější a je to tak správně: schéma smí odmítnout
 * jen program, který si krabice nevšímá vůbec.
 *
 * Souvisí s ním ještě třetí číslo, které tu není: `RepresentationRegistry` se
 * ptá **po osách** a povoluje čtvrtinu. 1,25³ = 1,95, tedy skoro přesně 2 —
 * jedno tvrzení viděné ze dvou stran. Kdo hne jedním, má hnout druhým.
 */
export const MAX_BOUNDS_VOLUME_RATIO = 2;

/**
 * Kolikrát smí objednaná krabice přerůst to, co se v ní u kořene opakuje,
 * měřeno **nejdelší hranou** — ne objemem jako `MAX_BOUNDS_VOLUME_RATIO`.
 *
 * Hranou proto, že tady je předmětem sporu velikost buňky, a ta je podíl hrany
 * a `MESH_DETAIL.rough.resolution`; objem by tři kopie v řadě a kopie do tří
 * směrů soudil stejně, ačkoliv rozlišení platí jenom ta první.
 *
 * **Práh je naměřený, ne odhadnutý — 14. 9. 2026, 62 tvarů tří archivů.** Pole
 * u kořene mají tři a jejich poměry jsou 2,90×, 2,52× a 1,01×; nad 3,0× není
 * žádný. Dvojka leží v prázdném pásmu mezi 1,01 a 2,52, takže ji nelze minout
 * o vzorek. Důvod a naměřený případ jsou u `repeatedHeroIssue` ve `schema.ts`.
 */
export const MAX_REPEATED_HERO_RATIO = 2;

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

/**
 * Otočení profilu kolem osy — jediný způsob, jak jazyk řekne **oblouk**.
 *
 * **Proč to nešlo bez nového uzlu.** Přidáno 31. 8. 2026 po bráně K1, kde
 * `vault` jako jediný tvar galerie nesplnil své vlastní jméno: klenba se
 * skládala z `bend` nad kvádrem, a `bend` ohýbá pole jednou křivostí, takže
 * z rovného sloupu udělá **hák**, ne půlkruh. `torus` je celý prstenec bez
 * možnosti výseku. Klenba, kupole, oblouk mostu, akvadukt ani tunel proto
 * v jazyce neexistovaly, a architektura na obloucích stojí.
 *
 * - `axis` je osa otáčení.
 * - `radius` je vzdálenost profilu od osy. Profil leží v rovině, kterou osa
 *   svírá s **první** zbylou souřadnicí v pořadí `x, y, z` — pro `axis: 'y'`
 *   tedy v rovině `x–y`, na `x = radius`.
 * - `sweep` je **celý** úhel výseku v radiánech, symetrický kolem profilu.
 *   `2π` je uzavřený prstenec, `π` je klenba, `π/2` čtvrtoblouk.
 *
 * Otáčení je izometrie, takže se tu **nedělí Lipschitzem** — na rozdíl od
 * ostatních čtyř deformací pole nenatahuje.
 */
export interface RevolveNode {
  readonly kind: 'revolve';
  readonly child: number;
  readonly axis: Axis;
  readonly radius: number;
  readonly sweep: number;
}

export type DeformationNode = TwistNode | BendNode | TaperNode | DisplaceNode | RevolveNode;

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

/**
 * **Kvádr, který tvar zaručeně zaplní** — nebo `null`, když se to spočítat nedá.
 *
 * Slouží jedinému účelu: `structuralIssues` v `schema.ts` z něj pozná program,
 * který přetéká svůj vlastní `targetBounds`, ještě **před** meshingem. Dnes se
 * to pozná až v meshovači, a to tak, že tvar bez rezervy zmizí úplně (naměřeno
 * u `paddedBounds`: přesah o 1e-6 dal 0 trojúhelníků) — tedy po zaplaceném
 * volání modelu a bez čísla, ze kterého by model poznal, o kolik přestřelil.
 *
 * ## Proč `null` a ne odhad
 *
 * Hodnota se používá k **odmítnutí**, takže musí být `⊆` skutečného obalu:
 * jen pak z „můj kvádr přetéká" plyne „tvar přetéká". Nadhodnocený obal by
 * zahazoval tvary, které se ve skutečnosti vejdou, a to je horší vada než
 * neodhalený přesah — model by dostal opravnou větu k něčemu, co bylo správně.
 *
 * Proto se počítá jen tam, kde je výsledek **přesný**:
 *
 * | Uzel | Proč jde |
 * |---|---|
 * | primitiva | obal se čte přímo ze vzorce v `field.ts` |
 * | `translate`, `scale` | afinní po osách, obal se posune a natáhne s nimi |
 * | `mirror` | přeložení souřadnice, výsledný interval je `[2·about − max, max]` |
 * | `union` | obal sjednocení je sjednocení obalů |
 *
 * A `null` všude jinde, **včetně `rotate`**. U rotace to není lenost: ze
 * samotného obalu potomka skutečný obal otočeného tvaru spočítat **nejde**.
 * Obal je jen kvádr; tvar uvnitř může být od koule po tenkou úhlopříčku a každý
 * z nich dá po otočení jiný výsledek. Obal otočeného kvádru je horní odhad,
 * který by odmítal to, co se vejde. Totéž `intersect`, `subtract` a `clip`
 * (zmenšují, takže dolní odhad z potomků neplyne), všechny deformace (nejsou
 * afinní) a všechna pole (kopie se skládají otáčením a posunem po křivce).
 * `plane` je poloprostor, tedy nekonečný obal — počítat ho jako `null` je
 * schválně: jinak by každý program, který jím řeže, přetékal z definice.
 *
 * `union` s `k` (hladké sjednocení) se vyboulí **ven** z ostrého sjednocení,
 * takže spočtený obal je u něj dolní odhad. Pořád platí, co má: přetéká-li on,
 * přetéká i tvar.
 *
 * Průchod odspodu nahoru jako `instanceCounts` — potomek má nižší index.
 */
export function certainHulls(nodes: readonly ShapeNode[]): readonly (Bounds3 | null)[] {
  const hulls: (Bounds3 | null)[] = [];
  nodes.forEach((node, index) => {
    hulls[index] = hullOf(node, hulls);
  });
  return hulls;
}

function box3(hx: number, hy: number, hz: number): Bounds3 {
  return { min: [-hx, -hy, -hz], max: [hx, hy, hz] };
}

function hullOf(node: ShapeNode, hulls: readonly (Bounds3 | null)[]): Bounds3 | null {
  switch (node.kind) {
    case 'sphere':
      return box3(node.radius, node.radius, node.radius);
    case 'box':
      return box3(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2);
    case 'roundBox':
      return box3(
        node.size[0] / 2 + node.radius,
        node.size[1] / 2 + node.radius,
        node.size[2] / 2 + node.radius,
      );
    // Podél `y`, `height` je celá výška — viz `sdCapsule` a spol. ve `field.ts`.
    case 'capsule':
      return box3(node.radius, node.height / 2 + node.radius, node.radius);
    case 'cylinder':
      return box3(node.radius, node.height / 2, node.radius);
    // Podstava dole má `radius`, špička nahoře nulový — obal je přesto celý válec.
    case 'cone':
      return box3(node.radius, node.height / 2, node.radius);
    case 'torus':
      return box3(
        node.majorRadius + node.minorRadius,
        node.minorRadius,
        node.majorRadius + node.minorRadius,
      );
    case 'ellipsoid':
      return box3(node.radii[0], node.radii[1], node.radii[2]);
    // Vrchol 0 leží na `+x`, takže obal v rovině čte přímo vrcholy. Opsaná
    // kružnice by byla horní odhad: u lichého počtu stran ho žádný vrchol
    // v ose `z` nedosáhne.
    case 'prism': {
      const segment = (2 * Math.PI) / node.sides;
      let maxX = -Infinity;
      let minX = Infinity;
      let maxZ = -Infinity;
      let minZ = Infinity;
      for (let vertex = 0; vertex < node.sides; vertex += 1) {
        const x = node.radius * Math.cos(vertex * segment);
        const z = node.radius * Math.sin(vertex * segment);
        maxX = Math.max(maxX, x);
        minX = Math.min(minX, x);
        maxZ = Math.max(maxZ, z);
        minZ = Math.min(minZ, z);
      }
      return { min: [minX, -node.height / 2, minZ], max: [maxX, node.height / 2, maxZ] };
    }

    /**
     * ⚠ **Neznámý potomek se zahazuje, takže obal unie je DOLNÍ mez.**
     * Vědomé, ne opomenutí: `boundsIssue` z něj dokazuje přesah, a k tomu stačí
     * jedna část venku. Kdo by z něj chtěl dokazovat opak — třeba rezervu, na
     * kterou se má vzorkovat — dostane číslo, které lže. Naměřený případ je
     * u `MAX_BOUNDS_VOLUME_RATIO` výš.
     */
    case 'union': {
      const known = node.children.map((child) => hulls[child]).filter((hull) => hull !== null);
      if (known.length === 0) return null;
      return known.reduce(mergeHulls);
    }

    case 'translate': {
      const child = hulls[node.child];
      if (child === null) return null;
      return {
        min: [
          child.min[0] + node.offset[0],
          child.min[1] + node.offset[1],
          child.min[2] + node.offset[2],
        ],
        max: [
          child.max[0] + node.offset[0],
          child.max[1] + node.offset[1],
          child.max[2] + node.offset[2],
        ],
      };
    }

    // Činitele jsou kladné (`scaleFactor` má minimum 0,05), takže se `min`
    // a `max` nemůžou prohodit.
    case 'scale': {
      const child = hulls[node.child];
      if (child === null) return null;
      return {
        min: [
          child.min[0] * node.factor[0],
          child.min[1] * node.factor[1],
          child.min[2] * node.factor[2],
        ],
        max: [
          child.max[0] * node.factor[0],
          child.max[1] * node.factor[1],
          child.max[2] * node.factor[2],
        ],
      };
    }

    /**
     * `fx = about + |x − about|` je přeložení: tvar je ta část potomka nad
     * `about` plus její zrcadlo. Interval je proto `[2·about − max, max]`.
     * Když potomek nad `about` nesahá vůbec, je výsledek prázdný a obal
     * neexistuje — `null`, ne kvádr o záporné šířce.
     */
    case 'mirror': {
      const child = hulls[node.child];
      if (child === null) return null;
      const axis = node.axis === 'x' ? 0 : node.axis === 'y' ? 1 : 2;
      const about = node.about ?? 0;
      const high = child.max[axis];
      if (high < about) return null;
      const min = [...child.min] as [number, number, number];
      const max = [...child.max] as [number, number, number];
      min[axis] = 2 * about - high;
      max[axis] = high;
      return { min, max };
    }

    default:
      return null;
  }
}

function mergeHulls(left: Bounds3, right: Bounds3): Bounds3 {
  return {
    min: [
      Math.min(left.min[0], right.min[0]),
      Math.min(left.min[1], right.min[1]),
      Math.min(left.min[2], right.min[2]),
    ],
    max: [
      Math.max(left.max[0], right.max[0]),
      Math.max(left.max[1], right.max[1]),
      Math.max(left.max[2], right.max[2]),
    ],
  };
}
