import { z } from 'zod';

/**
 * Druhá větev mezijazyka: **program geometrie**.
 *
 * První větev (`src/ir`) říká, co svět dělá. Tahle říká, jak vypadá. Model
 * nepíše kód ani volání `three` — emituje tenhle dokument a ručně psaný
 * kompilátor (`src/geom/compile.ts`) z něj postaví `BufferGeometry`.
 *
 * **Tvar je opsaný z `world-ir-v1` schválně.** Plochá tabulka uzlů, potomek je
 * index, ne vnořený objekt. Tím pádem tu není jediné rekurzivní odkázání,
 * `cycles: "throw"` nemá na co narazit a kompilátor je průchod odspodu nahoru
 * bez rekurze. Model, který se naučil psát jednu větev, píše druhou stejně.
 *
 * **Slovník tvarů je slovník kitu, ne druhý systém.** `mass`, `column`, `arch`,
 * `panel` a `organic` jsou kategorie z `src/kit/pieces/**` a jejich `variant`
 * je přesně ta část `Piece.id` za tečkou. `program.test.ts` to drží připnuté
 * ke `KIT`, takže přidaný kus se buď objeví tady, nebo spadne test. Jediná
 * kategorie navíc je `terrain` — zem, pro kterou kit kus nemá.
 *
 * **`fixture` a `actor` program od P14 T4 umí a je to oprava, ne rozšíření.**
 * Do 28. 8. 2026 tu obě kategorie chyběly s odůvodněním, že rekvizity a postavy
 * vkládá simulace přes `src/ir`. Jenže `src/ir` je jazyk **běžícího** světa —
 * kulisa, kterou staví `family.compose(seed)`, přes něj neprochází. Dvanáct ze
 * čtyřiceti dvou kusů kitu tedy nebylo dosažitelných z ničeho, co svět staví,
 * a v žádné vygenerované scéně nemohla stát postava. **S postavou zmizelo
 * i měřítko**: bez figury se z obrazu nedá odhadnout, jestli je věž tři metry
 * vysoká nebo třicet.
 *
 * Vlastnictví zůstává jednoznačné a dělí se podle role, ne podle kategorie:
 * program staví **kulisu** (postava jako měřítko, bedna jako drobnost),
 * `src/ir` staví **entity, které se hýbou a mají stav**. Táž kategorie kitu
 * může posloužit oběma, stejně jako `mass` slouží zdi i překážce.
 *
 * Tenhle soubor **neimportuje `three`** — stejná kázeň jako `src/kit/layouts`.
 * Schéma se musí dát ověřit i tam, kde renderer není: v Node, ve fallbacku a
 * v ověřovači.
 */

export const GEOM_VERSION = 'geom-program-v1';

/**
 * Stropy programu.
 *
 * - `maxNodes` **96** — kolik řádků tabulky model napíše. Zvednuto z 64
 *   v P13 vlně 1: `arrayAlongCurve` a `anchorTo` znamenají, že se kompozice
 *   skládá z vazeb mezi uzly, ne z opsaných souřadnic, a na to je 64 řádků
 *   málo. Strop chrání pořád tentýž rozpočet, protože skutečnou cenu drží
 *   `maxInstances` — ten se nezvedl.
 * - `maxInstances` **200** (do 13. 9. 2026 120) — kolik umístěných kusů z programu **vyleze po
 *   rozvinutí** operací. Není to nový rozpočet: je to `maxDrawCallsPerWorld`
 *   z `src/kit/budgets.ts`, kde jeden umístěný kus = jeden draw call. Test tu
 *   rovnost hlídá, aby se obě čísla nerozešla. `maxNodes` sám o sobě nic
 *   nechrání — `repeat` 16 nad `scatter` 24 je 384 kusů ze dvou řádků.
 */
export const GEOM_LIMITS = {
  maxNodes: 96,
  maxInstances: 200,
} as const;

/**
 * Kontrolních bodů Catmull-Rom křivky. Táž mez jako u `ShapeProgram`
 * (`src/shape/types.ts`), protože je to týž uzel v druhé větvi jazyka.
 */
export const MAX_CURVE_POINTS = 8;

/**
 * Kolik dílků `sweep` po dráze vygeneruje. Prstenců je o jeden víc.
 *
 * Strop je rozpočet, ne vkus. Nejdražší možný sweep je osmibodový profil na
 * 64 dílcích: plášť `64 × 8 × 2 = 1 024` trojúhelníků a obě víka
 * `2 × (8 − 2) = 12`, dohromady **1 036** proti
 * `KIT_BUDGETS.maxTrianglesPerPiece` = 1 200. `program.test.ts` ten součin
 * počítá, takže zvednutí kteréhokoli z těch tří čísel spadne tam, a ne až
 * v rozpočtu celého světa, kde by se ztratilo mezi sto dvaceti kusy.
 */
export const MAX_SWEEP_SEGMENTS = 64;

/**
 * Odstíny, kterými smí `sweep` barvit vrcholy — uzavřená množina kitu.
 *
 * **Opsaná, ne importovaná**, ze stejného důvodu jako `PIECE_VARIANTS`: tenhle
 * soubor neimportuje `three` ani nic, co ho táhne, aby se program dal ověřit
 * v Node, ve fallbacku i v ověřovači. `program.test.ts` seznam drží připnutý
 * ke `SWATCHES`, takže odstín přidaný do kitu se ohlásí červeným testem místo
 * aby ze `sweep` tiše zmizel.
 *
 * **Uzavřenost je záměr, ne omezení.** `repaint()` přebarvuje kusy podle
 * přesné shody barvy vrcholu s odstínem kitu a na cizí barvě vyhodí výjimku.
 * Vlastní barva ve `sweep` by tedy nebyla svoboda — byl by to pád při první
 * změně palety.
 */
export const SWATCH_NAMES = ['shell', 'deep', 'accent', 'warm', 'sand', 'moss'] as const;

export type GeomSwatch = (typeof SWATCH_NAMES)[number];

/**
 * Kam na cílovém uzlu `anchorTo` míří.
 *
 * Kotva je bod na **kvádru opsaném** hotovému podstromu cíle, ne kus geometrie:
 * kusy kitu žádné kotvy nemají a dopisovat je do všech třiceti by byl druhý
 * slovník. `top` je střed horní stěny, `center` střed kvádru a tak dál.
 */
export const ANCHOR_SITES = [
  'top',
  'bottom',
  'north',
  'south',
  'east',
  'west',
  'center',
] as const;

export type AnchorSite = (typeof ANCHOR_SITES)[number];

/** Kategorie kitu, které program umí postavit. Pořadí = pořadí v `KIT`. */
export const MASS_VARIANTS = ['block', 'wedge', 'step', 'plinth', 'stack', 'bevel'] as const;
export const COLUMN_VARIANTS = ['pillar', 'capital', 'fluted', 'post', 'twisted', 'broken'] as const;
export const ARCH_VARIANTS = ['round', 'flat', 'doorway', 'portal', 'buttress'] as const;
export const PANEL_VARIANTS = ['wall', 'half', 'floor', 'ramp', 'railing', 'window', 'roof'] as const;
export const ORGANIC_VARIANTS = ['pebble', 'boulder', 'cluster', 'shrub', 'tree', 'reed'] as const;
export const FIXTURE_VARIANTS = [
  'crate',
  'barrel',
  'lamp',
  'sign',
  'terminal',
  'hatch',
  'pipe',
  'bench',
  'aquarium',
  'fireplace',
  'checkout',
  'couch',
  'reception',
] as const;
export const ACTOR_VARIANTS = ['tall', 'squat', 'drone', 'quadruped', 'seated'] as const;

/** Zem. Jeden ze dvou tvarů bez kusu v kitu — generuje se výškovým polem. */
export const TERRAIN_VARIANTS = ['flat', 'ridge', 'basin', 'plateau'] as const;

/**
 * Kategorie → varianty, **jen pro ty, které mají kus v kitu**. `terrain` tu
 * schválně chybí; test podle téhle mapy porovnává slovník s `KIT`.
 */
export const PIECE_VARIANTS = {
  mass: MASS_VARIANTS,
  column: COLUMN_VARIANTS,
  arch: ARCH_VARIANTS,
  panel: PANEL_VARIANTS,
  organic: ORGANIC_VARIANTS,
  fixture: FIXTURE_VARIANTS,
  actor: ACTOR_VARIANTS,
} as const;

export type PieceKind = keyof typeof PIECE_VARIANTS;

export const SHAPE_KINDS = [
  'mass',
  'column',
  'arch',
  'panel',
  'organic',
  'fixture',
  'actor',
  'terrain',
  'sweep',
] as const;

/**
 * Operace nad tvary.
 *
 * **`group` v zadání P11 T8 není a je tu dopsaný vědomě.** Zbylé čtyři operace
 * berou právě jednoho potomka, takže bez sjednocení má program jedinou větev
 * a nedá se z něj postavit svět, kde vedle sebe stojí zem, budova a stromy —
 * což je přesně to, co po kompilátoru chce T9 i výtvarné rodiny v T10. Je to
 * sjednocení scény, ne nový slovník tvarů.
 */
export const OPERATION_KINDS = [
  'group',
  'repeat',
  'mirror',
  'carve',
  'scatter',
  'arrayAlongCurve',
  'anchorTo',
] as const;

/** Z uzlu kitu na `Piece.id`. Kompilátor si tím sahá do `pieceById`. */
export function pieceIdOf(kind: PieceKind, variant: string): string {
  return `${kind}.${variant}`;
}

// Souřadnice světa v jednotkách mřížky kitu (1 = jedno pole). Ohraničené na
// obě strany, aby žádný parametr nemohl přijít jako nekonečno ani jako číslo,
// které kompilátor ještě přijme a kamera už neuvidí.
const coordinate = z.number().min(-64).max(64);
const vector3 = z.tuple([coordinate, coordinate, coordinate]);

const scaleFactor = z.number().min(0.1).max(8);
const scale3 = z.tuple([scaleFactor, scaleFactor, scaleFactor]);

const span = z.number().min(0.1).max(64);

/**
 * Otočení ve **čtvrtinách otáčky** — táž jednotka jako `Placement.yaw`.
 *
 * **P13 vlna 1 T6 uvolnila typ z celého čísla na reálné, ne jednotku.** Byla to
 * jediná cesta, jak splnit obojí: „volné otáčení ve třech osách" a „staré
 * programy dají bitově stejný výsledek". Kdyby se přešlo na radiány, znamenal
 * by zápis `yaw: 1` v každém dosavadním programu i v každém zmrazeném měření
 * najednou 57°, ne 90° — a nikde by to nebylo vidět, protože obojí je platné
 * číslo. Čtvrtiny otáčky zůstávají, jen se do nich vejde `0,37`.
 *
 * **Meze jsou otevřené, takže celá otáčka `4` je pořád mimo.** Plná otáčka je
 * identita, takže canonický rozsah ji neobsahuje, a `program.test.ts` na tom
 * má připnuté očekávání od P11. Uvolnění, které by ho tiše otočilo na zelenou,
 * by z toho testu udělalo dekoraci.
 */
const turns = z.number().gt(-4).lt(4);

const nodeIndex = z.int().min(0).max(GEOM_LIMITS.maxNodes - 1);

// Jediná PRNG projektu je `pure-rand` a bere celočíselné semínko. Rozsah je
// kladný 32bitový, aby se nedalo emitovat semínko, které se v Node a
// v prohlížeči zaokrouhlí jinak.
const seedValue = z.int().min(0).max(2_147_483_647);

/**
 * Umístění, které nese každý tvarový uzel. Vše volitelné = model nemusí psát nuly.
 *
 * `pitch` a `roll` přibyly v P13 vlně 1. Skládají se v pořadí `XYZ`, tedy
 * `pitch` kolem `x`, `yaw` kolem `y`, `roll` kolem `z`; program, který je
 * nenapíše, projde přesně týmž výpočtem jako dřív, protože nula je v `Euler`
 * neutrální prvek a jde o tutéž funkci.
 */
const placement = {
  at: vector3.optional(),
  yaw: turns.optional(),
  pitch: turns.optional(),
  roll: turns.optional(),
  scale: scale3.optional(),
};

const massNode = z
  .object({ kind: z.literal('mass'), variant: z.enum(MASS_VARIANTS), ...placement })
  .strict();
const columnNode = z
  .object({ kind: z.literal('column'), variant: z.enum(COLUMN_VARIANTS), ...placement })
  .strict();
const archNode = z
  .object({ kind: z.literal('arch'), variant: z.enum(ARCH_VARIANTS), ...placement })
  .strict();
const panelNode = z
  .object({ kind: z.literal('panel'), variant: z.enum(PANEL_VARIANTS), ...placement })
  .strict();
const organicNode = z
  .object({ kind: z.literal('organic'), variant: z.enum(ORGANIC_VARIANTS), ...placement })
  .strict();

/**
 * Drobnosti a postavy. Tvarem se od ostatních kusů neliší ničím — je to týž
 * uzel s jiným slovníkem variant, takže pro ně kompilátor nemá vlastní větev
 * a nemůže se rozejít s tím, jak staví zeď.
 */
const fixtureNode = z
  .object({ kind: z.literal('fixture'), variant: z.enum(FIXTURE_VARIANTS), ...placement })
  .strict();
const actorNode = z
  .object({ kind: z.literal('actor'), variant: z.enum(ACTOR_VARIANTS), ...placement })
  .strict();

/**
 * Zem. `extent` je její rozměr v polích, takže `scale` nemá — dvě cesty ke
 * stejné velikosti jsou dvě místa, kde se dá udělat chyba.
 */
const terrainNode = z
  .object({
    kind: z.literal('terrain'),
    variant: z.enum(TERRAIN_VARIANTS),
    extent: z.tuple([span, span]),
    amplitude: z.number().min(0).max(8),
    seed: seedValue,
    at: vector3.optional(),
    yaw: turns.optional(),
  })
  .strict();

/**
 * **Profil tažený po křivce** — jediná zakřivená forma, kterou jazyk umí sám.
 *
 * Kit staví z hotových kusů a jeho `arch` je pět předem vymodelovaných variant.
 * Klenba, žebro, oblouk mostu ani trubka vedená obloukem se z nich složit nedá:
 * kus se dá otočit a zvětšit, ale ne ohnout. Cílový snímek to obcházel ručně
 * psaným `three` (žebra jako trubky po Catmull-Rom křivce, 1132 řádků mimo
 * jazyk) — a přesně tenhle rozdíl je důvod, proč generovaný svět nikdy nevypadá
 * jako ten ručně napsaný.
 *
 * **Dráha je táž Catmull-Rom křivka jako u `arrayAlongCurve`** a sdílí s ní
 * i strop `MAX_CURVE_POINTS`. Dvě různá čísla by byly dvě různé pravdy o tomtéž
 * uzlu ve dvou větvích jazyka; `curveOffsets()` je jediný sampler obou.
 *
 * **Rozdíl mezi `sweep` a `arrayAlongCurve` je souvislost.** `arrayAlongCurve`
 * rozsadí po dráze kopie kusu, mezi kterými zůstanou mezery. `sweep` z profilu
 * udělá **jedno uzavřené těleso** — plášť plus víka na obou koncích — takže
 * z něj je oblouk, ne řetěz korálků.
 *
 * Profil je uzavřený mnohoúhelník v rovině kolmé na tečnu dráhy, zapsaný jako
 * dvojice `[u, v]`. Jeho pořadí se **nemusí** hlídat: kompilátor si profil
 * otočí do kladného směru sám, protože jinak by celé těleso mělo normály
 * dovnitř a v prohlížeči by zmizelo. Nulová plocha profilu je naopak odmítnutí
 * — z ní nevznikne tenký tvar, ale neviditelný.
 */
const sweepNode = z
  .object({
    kind: z.literal('sweep'),
    profile: z.array(z.tuple([coordinate, coordinate])).min(3).max(MAX_CURVE_POINTS),
    path: z.array(vector3).min(2).max(MAX_CURVE_POINTS),
    segments: z.int().min(2).max(MAX_SWEEP_SEGMENTS),
    swatch: z.enum(SWATCH_NAMES),
    ...placement,
  })
  .strict();

/** Sjednocení. Jediný uzel, který nese víc potomků — proto se z něj skládá scéna. */
const groupNode = z
  .object({
    kind: z.literal('group'),
    children: z.array(nodeIndex).min(1).max(16),
  })
  .strict();

/** Řada kopií po pravidelném kroku. `count` počítá **včetně** originálu. */
const repeatNode = z
  .object({
    kind: z.literal('repeat'),
    child: nodeIndex,
    count: z.int().min(2).max(16),
    step: vector3,
  })
  .strict();

/**
 * Zrcadlo kolem roviny kolmé na osu. Osa `y` chybí schválně: svět stojí na
 * zemi a zrcadlení výšky by kusy poslalo pod ni.
 */
const mirrorNode = z
  .object({
    kind: z.literal('mirror'),
    child: nodeIndex,
    axis: z.enum(['x', 'z']),
    about: coordinate.optional(),
  })
  .strict();

/**
 * Řez kvádrem — díra, ne booleovský rozdíl.
 *
 * Kompilátor zahodí trojúhelníky, jejichž těžiště padne dovnitř kvádru. Je to
 * levné, deterministické a stačí to na průchod prosekaný do zdi. Ostrý ořez
 * s dopočítanou stěnou by znamenal CSG, pro které v `TOOLING.md` závislost není.
 */
const carveNode = z
  .object({
    kind: z.literal('carve'),
    child: nodeIndex,
    at: vector3,
    size: z.tuple([span, span, span]),
  })
  .strict();

/** Rozsetí kopií do kruhu. Deterministické — `seed` jde do `pure-rand`. */
const scatterNode = z
  .object({
    kind: z.literal('scatter'),
    child: nodeIndex,
    count: z.int().min(2).max(24),
    radius: z.number().min(0.5).max(32),
    seed: seedValue,
  })
  .strict();

/**
 * Řada kopií podél Catmull-Rom křivky. `count` počítá **včetně** obou konců.
 *
 * Tohle je uzel, kterým se ze slovníku dostane most, schodiště nebo řada
 * pilířů podél zatáčky — dosud musel model každou kopii vypsat souřadnicí,
 * což je přesně to, na co mu nestačí `maxNodes`.
 *
 * Kopie se **jen posunou, neotočí se po tečně.** Je to méně, než by šlo, a je
 * to schválně: otočení po tečně mění, jak kus vypadá, a bez měření by se
 * nepoznalo, jestli je hezčí. Otáčení má model k dispozici jako `yaw`/`pitch`/
 * `roll` na kusu samém.
 */
const arrayAlongCurveNode = z
  .object({
    kind: z.literal('arrayAlongCurve'),
    child: nodeIndex,
    count: z.int().min(2).max(24),
    points: z.array(vector3).min(2).max(MAX_CURVE_POINTS),
  })
  .strict();

/**
 * Umístí podstrom na kotvu **jiného** uzlu.
 *
 * Model tím skládá vztahy („varhany stojí na plošině") místo souřadnic, které
 * si musí spočítat sám. Kotva je bod na kvádru opsaném cílovému podstromu, viz
 * `ANCHOR_SITES`.
 *
 * **Cíl je odkaz, ne rodičovství — do výsledku se nedostane.** Kdo chce vidět
 * obojí, dá cíl i `anchorTo` do téhož `group`. Kdyby `anchorTo` vracelo obojí,
 * počítal by se cíl v každém `group` dvakrát a rozpočet draw callů by lhal.
 */
const anchorToNode = z
  .object({
    kind: z.literal('anchorTo'),
    child: nodeIndex,
    target: nodeIndex,
    site: z.enum(ANCHOR_SITES),
    offset: vector3.optional(),
  })
  .strict();

const geomNodeSchema = z.discriminatedUnion('kind', [
  massNode,
  columnNode,
  archNode,
  panelNode,
  organicNode,
  fixtureNode,
  actorNode,
  terrainNode,
  sweepNode,
  groupNode,
  repeatNode,
  mirrorNode,
  carveNode,
  scatterNode,
  arrayAlongCurveNode,
  anchorToNode,
]);

export const geomProgramSchema = z
  .object({
    version: z.literal(GEOM_VERSION),
    nodes: z.array(geomNodeSchema).min(1).max(GEOM_LIMITS.maxNodes),
    root: nodeIndex,
  })
  .strict();

export type GeomNode = z.infer<typeof geomNodeSchema>;
export type GeomProgram = z.infer<typeof geomProgramSchema>;

export interface GeomValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Potomci uzlu — to, co se z něj **postaví**. Tvarové uzly nemají žádné,
 * `group` několik, ostatní operace jednoho.
 *
 * `anchorTo.target` mezi ně nepatří: cíl se do výsledku nedostane, je to jen
 * odkaz na souřadnici. Kdo kontroluje pořadí indexů, musí použít
 * `referencedIndicesOf`, ne tuhle funkci.
 */
export function childIndicesOf(node: GeomNode): readonly number[] {
  if (node.kind === 'group') return node.children;
  return 'child' in node ? [node.child] : [];
}

/**
 * Všechno, na co uzel ukazuje — potomci **i** cíl kotvy.
 *
 * Tohle je seznam, který musí být striktně pod uzlem. Kdyby se pořadí indexů
 * hlídalo jen přes `childIndicesOf`, dala by se kotvou napsat vazba na uzel
 * výš nebo cyklus a průchod odspodu nahoru by četl `undefined`.
 */
export function referencedIndicesOf(node: GeomNode): readonly number[] {
  return node.kind === 'anchorTo'
    ? [node.child, node.target]
    : childIndicesOf(node);
}

/**
 * Indexy řádků, na které se z `root` dá dojít.
 *
 * Průchod odshora dolů, protože dosažitelnost se šíří opačně než rozpočty.
 * Bez rekurze: potomek má vždy nižší index, což vynucuje `structuralIssues`,
 * takže stačí jeden sestup polem.
 *
 * Jde se po `referencedIndicesOf`, ne po `childIndicesOf`: cíl `anchorTo` se
 * do výsledku nevkládá, ale kompilátor z něj čte kvádr, takže dosažitelný je.
 */
export function reachableFrom(nodes: readonly GeomNode[], root: number): ReadonlySet<number> {
  const reached = new Set<number>([root]);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (!reached.has(index)) continue;
    for (const child of referencedIndicesOf(nodes[index])) reached.add(child);
  }
  return reached;
}

/**
 * Řádky, ze kterých se do obrazu doopravdy dostanou trojúhelníky.
 *
 * Užší než `reachableFrom` právě o cíle kotev: `anchorTo` si z cíle vezme
 * kvádr a **kusy zahodí**, takže řádek, na který se z kořene dojde jedině jako
 * na `target`, je dosažitelný a přesto v obraze nikde. Objekt, který si ho
 * nárokuje, tedy nedostane ani jeden kus — a nedozví se to z ničeho, co soudí
 * dosažitelnost.
 */
export function placedFrom(nodes: readonly GeomNode[], root: number): ReadonlySet<number> {
  const placed = new Set<number>([root]);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (!placed.has(index)) continue;
    for (const child of childIndicesOf(nodes[index])) placed.add(child);
  }
  return placed;
}

/**
 * Řádky, které se z obrazu dají ještě **vybrat jako vlastní kusy**.
 *
 * Užší než `placedFrom` o všechno pod `carve`: řez slepí celý podstrom do
 * jedné sítě (`compilePlacements` v `./placements.ts`), takže po něm už ta
 * část není složeninou kusů, kterou by šlo orazítkovat a předat jednomu
 * objektu. Její trojúhelníky v obraze **jsou** — jen je nikdo nemůže dostat
 * samostatně.
 *
 * Do potomka `carve` se proto nesestupuje. Řádek dosažitelný dvěma cestami,
 * z nichž jedna řezem nevede, tu zůstává: razítko mu drží ta druhá.
 */
export function separableFrom(nodes: readonly GeomNode[], root: number): ReadonlySet<number> {
  const separable = new Set<number>([root]);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (!separable.has(index)) continue;
    if (nodes[index].kind === 'carve') continue;
    for (const child of childIndicesOf(nodes[index])) separable.add(child);
  }
  return separable;
}

/**
 * Kolik umístěných kusů vyleze z každého uzlu po rozvinutí operací.
 *
 * Průchod odspodu nahoru — potomek má vždy nižší index než rodič, což vynucuje
 * `structuralIssues`, takže v poli je hotová hodnota dřív, než ji někdo čte.
 * `carve` násobí jedničkou: díra kusy neubírá ani nepřidává.
 */
export function instanceCounts(nodes: readonly GeomNode[]): readonly number[] {
  const counts: number[] = [];
  nodes.forEach((node, index) => {
    switch (node.kind) {
      case 'group':
        counts[index] = node.children.reduce((sum, child) => sum + counts[child], 0);
        break;
      case 'repeat':
      case 'scatter':
      case 'arrayAlongCurve':
        counts[index] = node.count * counts[node.child];
        break;
      case 'mirror':
        counts[index] = 2 * counts[node.child];
        break;
      case 'carve':
      case 'anchorTo':
        // Kotva kus posune, nepřidá ho. Cíl se nepočítá, protože se do
        // výsledku nedostane — počítá se tam, kde je do světa doopravdy vložen.
        counts[index] = counts[node.child];
        break;
      default:
        counts[index] = 1;
    }
  });
  return counts;
}

/**
 * Plocha uzavřeného mnohoúhelníku, se znaménkem (shoelace). Kladná znamená
 * pořadí proti směru hodinových ručiček v rovině `[u, v]`.
 */
export function profileArea(profile: readonly (readonly [number, number])[]): number {
  let twice = 0;
  for (let index = 0; index < profile.length; index += 1) {
    const [u1, v1] = profile[index];
    const [u2, v2] = profile[(index + 1) % profile.length];
    twice += u1 * v2 - u2 * v1;
  }
  return twice / 2;
}

/**
 * To, co schéma neumí: rozsah a monotonii indexů, rozpočet po rozvinutí a dva
 * druhy zdegenerovaného `sweep`. Vrací **všechny** nálezy, ne první — program
 * se odmítá s důvodem.
 */
function structuralIssues(program: GeomProgram): string[] {
  const issues: string[] = [];
  const fail = (message: string) => issues.push(message);

  if (program.root >= program.nodes.length)
    fail(`root references node ${program.root} outside the table of ${program.nodes.length}`);

  program.nodes.forEach((node, index) => {
    for (const child of referencedIndicesOf(node)) {
      // **Vzájemně výlučné, a v tomhle pořadí** — týž důvod jako ve
      // `shape/schema.ts`: potomek mimo tabulku je vždycky i nad vlastním
      // řádkem, takže obrácené pořadí nechá hlášku o tabulce navždy mrtvou.
      if (child >= program.nodes.length) {
        fail(`node ${index} references node ${child} outside the table of ${program.nodes.length}`);
      } else if (child >= index) {
        fail(`node ${index} references node ${child} at or above itself`);
      }
    }
  });

  // Dvě degenerace `sweep`, které schéma z jednoho řádku nevidí, protože jsou
  // to vlastnosti celého pole, ne jednoho čísla. Obě vyrobí těleso, které
  // projde vším ostatním a v obraze po něm nezůstane nic — a to je horší než
  // pád, protože se to nemá kde ohlásit.
  program.nodes.forEach((node, index) => {
    if (node.kind !== 'sweep') return;

    if (Math.abs(profileArea(node.profile)) < 1e-9) {
      fail(`node ${index} sweeps a profile with no area, so it would build nothing visible`);
    }

    const [first] = node.path;
    if (node.path.every((point) => point.every((value, axis) => value === first[axis]))) {
      fail(`node ${index} sweeps along ${node.path.length} identical points, which is not a path`);
    }
  });

  // Rozpočet se počítá až nad neporušenou tabulkou; nad cyklem nebo nad
  // odkazem mimo tabulku by `instanceCounts` četlo `undefined`.
  if (issues.length > 0) return issues;

  // Mrtvý řádek se odmítá, ne přehlíží — týž důvod jako v `shape/schema.ts`.
  // Rozpočet níž se čte z `[root]`, ale **kompilátor staví každý řádek
  // tabulky** (`compileGeomProgram`, `compilePlacements`), takže uzel mimo
  // strom projde bránou nezapočítaný a postaví se stejně. Řetěz čtyř
  // nedosažitelných `repeat` řádků ohlásil 1 kus proti stropu 120 a vyrobil
  // jich 65 536; každý další řádek to násobí znovu.
  const reached = reachableFrom(program.nodes, program.root);
  const orphans = program.nodes
    .map((_node, index) => index)
    .filter((index) => !reached.has(index));
  if (orphans.length > 0) {
    fail(`nodes ${orphans.join(', ')} cannot be reached from root ${program.root}`);
  }

  const expanded = instanceCounts(program.nodes)[program.root];
  if (expanded > GEOM_LIMITS.maxInstances)
    fail(
      `program expands to ${expanded} placed pieces, above maxInstances ${GEOM_LIMITS.maxInstances}`,
    );

  return issues;
}

export function validateGeomProgram(input: unknown): GeomValidation {
  const parsed = geomProgramSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `schema:/${issue.path.join('/')}: ${issue.message}`),
    };
  }

  const issues = structuralIssues(parsed.data);
  return { ok: issues.length === 0, issues };
}

/** Přijme, nebo vyhodí s pojmenovaným důvodem. Kompilátor bere jen tenhle vstup. */
export function parseGeomProgram(input: unknown): GeomProgram {
  const validation = validateGeomProgram(input);
  if (!validation.ok) throw new Error(`invalid geom program: ${validation.issues.join('; ')}`);
  return geomProgramSchema.parse(input);
}
