/**
 * **Hrubý svět — blueprint na sloty a to, co je v nich hned teď.**
 *
 * Tohle je krok mezi „model dopsal" a „porotce něco vidí". Z blueprintu vzniká
 * pro **každý** `SemanticObject` jeden `SemanticSlot` (`./slots.ts`) a k němu
 * ta nejlepší podoba, která se dá vyrobit do tří sekund. Hrdinský tvar se
 * mešuje v mřížce 32³, řádek kompozice se vezme tak, jak je, a když ani jedno
 * nevyjde, zbude prostorově poctivá hlína.
 *
 * ## Prázdný slot neexistuje
 *
 * To je celá teze téhle úlohy. Chybějící tvar, odmítnutý tvar, prázdný mesh,
 * řádek slepený řezem — z každé z těch cest musí vylézt objekt, který někde
 * stojí, něco zabírá a dá se na něj ukázat druhou větou. Objekt, který
 * z potrubí tiše vypadne, je horší než ošklivý objekt: ošklivý se dá zpevnit
 * (§13, hot-swap), chybějící se nedá ani najít.
 *
 * ## Žebřík je zavřený seznam, ne odhad
 *
 * `PROXY_RUNGS` je šest příček z design booku §27 v jeho pořadí. Hrubý svět
 * z nich obsazuje tři (`ROUGH_RUNGS`) a je to **záměr, ne mezera**:
 *
 * - `g3-ready` (48³) je výsledek materializace, kterou dělá hot-swap ve vlně 3;
 *   hrubý svět ji vyrobit nemůže, protože by na ni porotce čekal.
 * - `g2-reduced` je snížení počtu instancí, a to je nástroj adaptivní kvality
 *   (vlna 5). Tady by se neměl o co opřít: `parseGeomProgram` program nad
 *   `GEOM_LIMITS.maxInstances` (120 kusů) odmítne už na vstupu, takže
 *   zkompilovaný blueprint je v rozpočtu **vždycky**. Příčka, která by se
 *   tady snažila snižovat, by snižovala něco, co se nikdy nepřeteklo.
 *
 * Že hrubá cesta obsadí právě ty tři, drží test. Až vlna 3 nebo 5 přidá svoji
 * příčku, spadne tam — a to je smysl toho testu: nová příčka se má **dopsat**
 * do seznamu, ne se v něm objevit sama.
 *
 * ## Co tenhle soubor nedělá
 *
 * Nekreslí. Vrací plán a data; `three` se tu objevuje jen kvůli maticím
 * v `GeomPlacement`. Vlastníkem slotů za běhu je `RepresentationRegistry`
 * (§13.1, vlna 3 T18) — tenhle soubor mu dodává první obsah a pak nic.
 */

import { Box3, Matrix4, Vector3 } from 'three';

import { bakePlacements, compilePlacements, type GeomPlacement } from '@/geom/placements';
import { childIndicesOf, placedFrom, separableFrom, type GeomNode } from '@/geom/program';
import { blueprintRejectionSentence, type BlueprintOutcome } from '@/model/worldstream-repair';
import {
  MeshBudgetError,
  MeshEmptyError,
  type MeshOrder,
  type MeshResult,
} from '@/shape/mesh-client';
import { MESH_DETAIL, type Bounds3, type ShapeProgram, type Vec3 } from '@/shape/types';
import { planRootRepeat, type RepeatInstances } from '@/shape/repeat-plan';

import { budgetFor, type QualityTier } from './quality';
import { visualPreviewSchema, type VisualPreview, type WorldstreamBlueprint } from './schema';
type VisualScene = Pick<WorldstreamBlueprint, 'geometry' | 'objects' | 'shapes' | 'sceneSpec' | 'intent' | 'title' | 'sessionSeed'>;
import { boundsCenter, slotFromAsset, slotFromForm, slotFromWorldForm, type SemanticSlot } from './slots';
import type { AssetManifest } from '@/assets/manifest';
import { WORLDSTREAM_ASSETS } from '@/assets/catalog';
import { sceneEnvironment, type SceneEnvironment } from '@/scene/environment';
import { readSurface } from '@/assets/materials';
import type { AssetReference } from '@/assets/schema';

/* ------------------------------------------------------------------ *
 * Žebřík — design book §27, v jeho pořadí.
 * ------------------------------------------------------------------ */

export const PROXY_RUNGS = [
  'g3-ready',
  'g3-reduced',
  'g2-rich',
  'g2-reduced',
  'semantic-clay',
  'declined',
] as const;

export type ProxyRung = (typeof PROXY_RUNGS)[number];

/**
 * Co která příčka znamená. **Anglicky, protože to porotce čte** — hlášky,
 * popisky a `data-testid` produktu jsou anglicky (`CLAUDE.md`, Konvence).
 */
export const PROXY_RUNG_LABELS: Readonly<Record<ProxyRung, string>> = {
  'g3-ready': 'authored shape, full detail',
  'g3-reduced': 'authored shape, rough grid',
  'g2-rich': 'authored composition',
  'g2-reduced': 'authored composition, fewer instances',
  'semantic-clay': 'semantic clay',
  declined: 'declined',
};

/** Příčky, které umí obsadit hrubý svět. Zbytek patří vlnám 3 a 5. */
export const ROUGH_RUNGS = ['g3-reduced', 'g2-rich', 'semantic-clay'] as const;

export type RoughRung = (typeof ROUGH_RUNGS)[number];

/**
 * Mřížka hrubého světa **výchozí úrovně**.
 *
 * Od `T26` ji volí `QualityBudget.roughResolution`, ne tahle konstanta —
 * zůstává proto, že je to pořád táž hodnota u všech tří úrovní (pod 32³ žádná
 * příčka neexistuje) a je na ni navázaný test, který si toho má všimnout, až
 * nějaká vznikne.
 */
export const ROUGH_RESOLUTION = MESH_DETAIL.rough.resolution;

/**
 * Mřížky **pod** hrubou příčkou, na které se tvar přemeshuje, když se do
 * rozpočtu `MESH_DETAIL.rough` nevešel. V pořadí, ve kterém se zkoušejí.
 *
 * ## Proč tenhle žebřík vůbec je (naměřeno 7. 9. 2026, `T14r-meshbudget`)
 *
 * Ze třiceti vět prvního živého běhu spadlo **osm** hrdinů na krabici, a ani
 * jednou proto, že by model nic nenapsal — tvar napsal pokaždé a pokaždé ho
 * zahodil rozpočet hrubé příčky. Čtyřikrát na trojúhelnících (16 160 až
 * 20 280 proti stropu 16 000, jeden o pouhé 1 %) a čtyřikrát na čase (521 až
 * 2 453 ms proti 350 ms).
 *
 * `MESH_DETAIL` má přitom jen `rough` 32³ a `high` 48³, tedy jedinou příčku
 * **nad** tou, na které se hrubý svět staví. Tvar, který přeteče o procento,
 * proto nespadl o příčku níž — spadl rovnou na `semantic-clay`, což je bedna.
 * Celá teze produktu zní „hrubá hlína, která ztvrdne do detailu **bez ztráty
 * identity**", a příčka se jmenuje `g3-reduced`, tedy „authored shape, rough
 * grid". Hrubší mřížka je tedy ta chybějící příčka, ne výjimka z pravidla.
 *
 * ## Co se schválně **nezvedlo**
 *
 * `maxTriangles` ani `maxMs`. Ta čísla jsou naměřená a `src/shape/types.ts`
 * u nich výslovně píše „nepřepisuj čísla výš"; zvednutí stropu by mělo
 * následek na každém světě, ne jen na těch osmi. Tenhle žebřík naopak stropy
 * **dodržuje** — jen dá tvaru druhou a třetí šanci se do nich vejít.
 *
 * ## Proč zrovna 24 a 16
 *
 * Buněk ubývá s třetí mocninou, takže 24³ je 0,42× a 16³ 0,125× práce 32³.
 * Naměřeno nad těmi osmi: **pět** se srovnalo hned na 24³, **dva** až na 16³,
 * jeden nevyhověl ani tam. `clay` klesl **z 8 na 1**.
 *
 * ⚠ **Ten jeden zbylý (`glowingAnemoneColony`) míjí strop o 4 % na 16³** —
 * 363 až 421 ms proti 350, měřeno dvakrát a pokaždé jinak. Je to wall-clock
 * číslo, tedy měření stroje a zátěže kolem, ne programu (`MESH_DETAIL` to
 * o `maxMs` říká samo). Třetí příčka by se tedy vybírala podle jediného
 * vzorku, který se sám hýbe — a ten správný nástroj je soudit cenu v počtu
 * vyhodnocení, ne přidávat mřížku. Žebřík proto zůstává dvoustupňový a tvar,
 * který nevyhoví ani na 16³, spadne na hlínu s větou, která jmenuje, že se to
 * zkusilo.
 *
 * ⚠ **Co se hrubší mřížkou doopravdy ztrácí, ať to nikdo nemusí hádat.** Sedm
 * zachráněných tvarů drží kvádr zadání do pár procent; výjimka je
 * `ribcageForest` na 16³, kde ze **684** trojúhelníků zbude hloubka 9,4 m
 * proti zadaným 13 m, tedy 72 %. Pořád je to napsaný tvar, ne bedna — ale je
 * to ta nejhorší naměřená ztráta detailu a nová příčka pod 16³ by ji jenom
 * prohloubila.
 *
 * ⚠ **Od `T14r-boundspad` sem vede druhá cesta, a ta s rozpočtem nesouvisí.**
 * Rezervu si přidává worker jako **jednu buňku**, tedy `1/resolution` kvádru,
 * takže hrubší příčka jí rezervuje víc: 24³ dá 4,17 % tam, kde 32³ dalo
 * 3,13 %. Tvar, který svou krabici přeteče o kousek víc než jednu buňku,
 * nemá na první příčce jediný vzorek venku a povrch nevznikne vůbec. Naměřeno
 * nad archivem `create-raw.json`: ze 41 tvarů, které projdou bránou schématu,
 * je takový jeden (`chessBoardShape`, c26) a na 24³ z něj vyleze 4 232
 * trojúhelníků. Sestup po prázdném meshi je tedy druhá záchrana, ne opakování
 * téhož výpočtu.
 *
 * ## Proč žebřík nemá celkový deadline — `T14r-ladderdeadline`, změřeno 9. 9. 2026
 *
 * Worker soudí čas **až po vymeshování**, takže přeteklá příčka se platí celá:
 * nejdražší svět archivu (`c08`) zaplatil 2 595 ms na příčce s rozpočtem
 * 350 ms, pak 1 060 ms, a uspěl až na 16³ za 348 ms. Celkem **4 003 ms**, z toho
 * 1 408 ms jsou ty dvě příčky navíc. Přes sekundu meshování má **5 z 65** světů
 * archivu.
 *
 * **Deadline se ale neposadí nikam, kde by neplatil hrdiny.** Ty tři světy, co
 * stojí nejvíc, jsou přesně ty, kterým žebřík hrdinu **zachránil** — uspěly až
 * na poslední příčce. Součet rozpočtů vlastních příček (3 × 350 = 1 050 ms) by
 * jich obětoval **tři**, aby ušetřil 3,4 s; `c08` uspěje až po 3 655 ms, takže
 * jakákoli mez, která na něm ušetří čas, ho zároveň pošle na hlínu. Je to
 * vlastnost, ne otázka ladění, a je to opak toho, co `e614918` vyhrálo
 * (`clay` 8 → 1).
 *
 * **A není to nekonečno, které by mez potřebovalo.** Práci jedné příčky shora
 * omezují rozpočty programu: 33³ rohů × `maxEvaluations` 512 je nejdražší
 * legální tvar, a naměřených 2 595 ms je přesně on. Nejhorší případ žebříku je
 * tedy ohraničený už dnes, jen tou branou, ne stopkami.
 *
 * **Kde ta sekunda a půl doopravdy leží:** ne na cestě k prvnímu snímku. Sklad
 * jedenácti světů (`authored-worlds.json`) protočí všech svých 13 tvarů za
 * 2 393 ms dohromady, sestupuje u dvou a na 16³ nejde ani jeden — žebřík na
 * první snímek přidá pár set milisekund. Ta čtyřsekundová cena je z dějství II,
 * které samo trvá kolem dvou a půl minuty.
 *
 * Kdyby se k tomu někdo vracel: měřit se to **nemá stopkami**, protože `maxMs`
 * je měření stroje. Jediná cesta, která nedělá kompromis mezi časem a hrdinou,
 * je odhadnout cenu příčky **předem** z programu (buňky × vyhodnocení na buňku)
 * a přeskočit tu, na kterou tvar nemá — to je ale nový nákladový model, ne mez.
 *
 * **Nejsou to `MeshResolution`.** Ten typ vyjmenovává mřížky, které umí
 * *žebřík podob* a měřicí stránka; tohle jsou mřížky poslední záchrany, které
 * se do žádného artefaktu ani cache klíče nedostávají.
 */
export const COARSER_GRIDS = [24, 16] as const;

/**
 * Věta pro objekt, na kterého nezbyl hrdinský rozpočet.
 *
 * **Vlastní důvod, ne `the shape is missing`.** Tvar nechybí a model ho napsal
 * správně — jen se na tuhle úroveň kvality nevešel, a to je informace pro toho,
 * kdo se ptá, proč objekt vypadá jako bedna. Splynutí s chybějícím tvarem je
 * přesně ta záměna, kterou `T14` musela opravovat u rozpadu příčin.
 */
export function overBudgetReason(heroes: number): string {
  return `this quality tier renders ${heroes} authored ${heroes === 1 ? 'shape' : 'shapes'}`;
}

/* ------------------------------------------------------------------ *
 * Výsledek.
 * ------------------------------------------------------------------ */

export type ProxyForm =
  | { readonly rung: 'semantic-clay'; readonly kind: 'asset'; readonly drawn: true;
      readonly reference: AssetReference; readonly level: number }
  | {
      readonly rung: 'g3-reduced';
      readonly kind: 'mesh';
      readonly mesh: MeshResult;
      readonly repeat?: RepeatInstances;
      readonly samplingAction?: {kind:'repeat-instanced'|'unsupported';reason:string};
      /**
       * Mřížka, ve které tenhle mesh doopravdy vznikl.
       *
       * Obvykle je to `ProxyWorld.resolution`, ale nemusí: tvar, který se do
       * rozpočtu hrubé příčky nevešel, se přemeshoval o příčku níž
       * (`COARSER_GRIDS`). Bez tohohle pole by svět deklaroval jednu mřížku a
       * některé jeho tvary mlely jinou — přesně ta třída tichého rozporu,
       * kterou plán honí od `T29-lambdadetect`.
       */
      readonly resolution: number;
    }
  | {
      readonly rung: 'g2-rich';
      readonly kind: 'placements';
      readonly placements: readonly GeomPlacement[];
    }
  /**
   * Hlína. Podoba je kvádr slotu — nic se nepřikládá, protože `localBounds`
   * ho už nese. `reason` je věta pro porotce, ne kód: říká, proč tenhle objekt
   * zatím vypadá jako bedna.
   *
   * `drawn` říká, jestli se ta bedna má **vykreslit**. Rozhoduje o tom
   * `clayCause()` níž: tři z cest na hlínu vedou k objektu, jehož geometrie
   * v obraze doopravdy stojí, jen ji nemůže dostat do vlastních rukou. Tam by
   * bedna prorostla skutečným tvarem.
   */
  | {
      readonly rung: 'semantic-clay';
      readonly kind: 'clay';
      readonly reason: string;
      readonly drawn: boolean;
    };

export interface ProxySlot {
  /** Immutable source for renderer sampling diagnostics, never a replacement mesh. */
  readonly detailProgram?:ShapeProgram;
  readonly slot: SemanticSlot;
  readonly form: ProxyForm;
}

export type ProxyWorld =
  | {
      readonly kind: 'built';
      readonly environment?: SceneEnvironment;
      readonly sceneSpec?: import('@/scene/spec').SceneSpec;
      readonly title: string;
      readonly sessionSeed: number;
      /**
       * Mřížka, na kterou byl svět **objednán** — `budget.roughResolution`.
       *
       * ⚠ **Není to tvrzení o tom, v čem každý slot doopravdy vznikl —
       * `T14r-worldgrid`.** Od `T14r-meshbudget` smí tvar, který se do rozpočtu
       * hrubé příčky nevešel, sestoupit o příčku níž (`COARSER_GRIDS`), a
       * v čem vznikl doopravdy, říká `ProxyForm.resolution` u toho slotu. Kdo
       * chce vypsat, na čem svět stojí, bere `slotResolutions()` níž; tohle
       * číslo je objednávka, ne výsledek.
       */
      readonly resolution: number;
      /**
       * Úroveň kvality, se kterou se svět postavil (`T26`). Nese ji svět, ne
       * volající: kdo ho dostane, musí umět odpovědět „proti jakému rozpočtu
       * se tohle má soudit?" bez toho, aby se ptal někoho třetího.
       */
      readonly quality: QualityTier;
      /** Jeden na každý `SemanticObject`, v pořadí blueprintu. */
      readonly slots: readonly ProxySlot[];
      /** Kompozice bez toho, co si nárokoval některý slot. */
      readonly scenery: readonly GeomPlacement[];
    }
  /** Ani hlína nešla vyrobit, protože žádný blueprint není (§27, příčka 6). */
  | { readonly kind: 'declined'; readonly rung: 'declined'; readonly reason: string };

/**
 * Mřížky, ve kterých hotové tvary toho světa doopravdy vznikly. Sestupně,
 * bez duplicit; prázdné pole, když svět žádný mesh nemá.
 *
 * ⚠ **Existuje proto, že jedno číslo na světě je od `T14r-meshbudget` nepravda
 * o sestoupeném tvaru — `T14r-worldgrid`.** Ze dvou nabídnutých cest se vzala
 * ta, kde se **věta počítá z příček slotů**; `ProxyWorld.resolution` zůstává
 * jedním číslem a je to objednávka, ne výsledek. Druhá cesta — rozbít to pole
 * — by sahala na typ, který čte víc míst, a to je proti rozsahu úlohy:
 * jediný dnešní konzument je vývojářská adresa mimo porotcovu cestu.
 *
 * Sloty bez meshe (`g2-rich`, hlína) se nepočítají. Nemají mřížku, a doplnit
 * jim tu světovou by vyrobilo přesně to číslo, které tahle funkce odstraňuje.
 */
export function slotResolutions(world: ProxyWorld): readonly number[] {
  if (world.kind !== 'built') return [];
  const grids = world.slots
    .map((entry) => (entry.form.rung === 'g3-reduced' ? entry.form.resolution : null))
    .filter((value): value is number => value !== null);
  return [...new Set(grids)].sort((a, b) => b - a);
}

export interface ProxyDeps {
  readonly assets?: AssetManifest;
  /** Only for a fully validated blueprint: show stable coarse slots before meshing. */
  readonly deferMeshes?: boolean;
  /**
   * Objednávka meshe. Vstřikuje se, aby tenhle soubor nemusel znát worker —
   * v produktu je to `createMeshClient().mesh`, v testu atrapa.
   */
  readonly mesh: (order: MeshOrder) => Promise<MeshResult>;
  /**
   * Úroveň kvality. **Čte se jednou, na začátku stavby** (`T26`, §23) — od té
   * chvíle je to konstanta a fan-out ji už nemůže změnit. Výchozí `full`, aby
   * volající, kterého kvalita nezajímá, dostal to, co dostával dosud.
   */
  readonly quality?: QualityTier;
}

/* ------------------------------------------------------------------ *
 * Kvádr naměřený na kusech.
 * ------------------------------------------------------------------ */

/**
 * Kvádr, který kusy doopravdy zabírají.
 *
 * Počítá se z upečené kopie a ta se hned zahodí — je to týž postup, jaký
 * používá `anchorTo` v `placements.ts`, a ze stejného důvodu: obalový kvádr
 * otočeného kusu je menší než otočený obalový kvádr, takže součet kvádrů
 * jednotlivých kusů by dal jiné číslo než to, co je vidět.
 *
 * `boundsOfGeometry()` se sem nepřebírá schválně: hlásí prázdno větou
 * o `anchorTo`, a ta by tady lhala o tom, co se zrovna dělo.
 */
function measureBounds(placements: readonly GeomPlacement[]): Bounds3 | null {
  const baked = bakePlacements(placements);
  baked.computeBoundingBox();
  const box: Box3 | null = baked.boundingBox;
  const empty = box === null || box.isEmpty();
  const min = empty ? new Vector3() : box.min;
  const max = empty ? new Vector3() : box.max;
  const bounds: Bounds3 = {
    min: [min.x, min.y, min.z] as Vec3,
    max: [max.x, max.y, max.z] as Vec3,
  };
  baked.dispose();
  return empty ? null : bounds;
}

/**
 * Týž kvádr, ale **po kusech**, aby se kotva měla čeho chytit.
 *
 * Obal celku sám nestačí: rozmnožený vlastník má střed obalu v prázdnu mezi
 * kopiemi (viz `nearestPiece()` v `./slots.ts`). Kusy se proto pečou po jednom
 * — je to táž práce jako jedno upečení celku, jen se nespojí do jedné sítě,
 * takže se tím nic nezdraží.
 *
 * Prázdný kus se **přeskakuje, ne vrací jako prázdno**: řádek může mít vedle
 * pěti plných kusů jeden slepený do ničeho a kotva má sednout na těch pět.
 */
function measurePieces(placements: readonly GeomPlacement[]): readonly Bounds3[] {
  const pieces: Bounds3[] = [];

  for (const placement of placements) {
    const baked = bakePlacements([placement]);
    baked.computeBoundingBox();
    const box: Box3 | null = baked.boundingBox;
    if (box !== null && !box.isEmpty())
      pieces.push({
        min: [box.min.x, box.min.y, box.min.z] as Vec3,
        max: [box.max.x, box.max.y, box.max.z] as Vec3,
      });
    baked.dispose();
  }

  return pieces;
}

/**
 * Kusy přepočítané do prostoru slotu.
 *
 * **Podoba je na každé příčce v prostoru slotu, nikdy ve světě.** Mesh z tvaru
 * v něm vyleze sám (worker počítá v `program.targetBounds`), kusy kompozice
 * ne — ty už světové matice nesou, protože je model napsal rovnou na jejich
 * místo. Odečte se jim tedy střed slotu a do světa je vrátí `slot.transform`,
 * úplně stejně jako mesh.
 *
 * Jednotný význam `transform` **není úklid, je to podmínka hot-swapu**: až
 * zeď dostane vlastní `ShapeProgram`, vymění se jen obsah slotu. Kdyby kusy
 * zůstaly ve světě a transformace u té příčky znamenala něco jiného, musel by
 * se při výměně přepočítat i rám slotu — a `world transform slotu` je podle
 * design booku §13.2 přesně to, co se hnout nesmí.
 */
function intoSlotSpace(
  placements: readonly GeomPlacement[],
  worldBounds: Bounds3,
): readonly GeomPlacement[] {
  const center = boundsCenter(worldBounds);
  const shift = new Matrix4().makeTranslation(-center[0], -center[1], -center[2]);
  // Rozepsané po polích jako `transformed()` v `placements.ts`, a ze stejného
  // důvodu: rozprostření sjednocení by z kusu udělalo objekt s oběma sadami
  // polí, který se do `GeomPlacement` nevejde.
  return placements.map((placement) => {
    const matrix = new Matrix4().multiplyMatrices(shift, placement.matrix);
    const { mirrored, owner } = placement;
    return placement.kind === 'piece'
      ? { kind: 'piece' as const, pieceId: placement.pieceId, matrix, mirrored, owner }
      : { kind: 'mesh' as const, geometry: placement.geometry, matrix, mirrored, owner };
  });
}

/* ------------------------------------------------------------------ *
 * Stavba.
 * ------------------------------------------------------------------ */

function declined(reason: string): ProxyWorld {
  return { kind: 'declined', rung: 'declined', reason };
}

/** Věta o tom, proč svět nevznikl. Bere se z kola, které ho odmítlo. */
function outcomeReason(outcome: Exclude<BlueprintOutcome, { kind: 'compiled' }>): string {
  if (outcome.kind === 'unavailable') return `the model did not answer: ${outcome.detail}`;
  // Vlastní věta, a je to důležité právě proto, že ji čte porotce: „the model
  // did not answer" by o běhu, ve kterém se model nevolal, tvrdilo nepravdu.
  if (outcome.kind === 'invalidInput') return `the request was built wrong before the model saw it: ${outcome.detail}`;
  return blueprintRejectionSentence(outcome.fault);
}

/**
 * Kusy kompozice rozdělené podle toho, komu patří.
 *
 * Když `compilePlacements()` spadne, vrací se prázdno a důvod. Selhat umí:
 * program, ze kterého po řezech nezbude ani trojúhelník, a odkaz na kus,
 * který v kitu není. Ani jedno nechytí schéma, protože obojí je vlastnost
 * **výsledku**, ne zápisu.
 */
interface Composition {
  readonly owned: ReadonlyMap<number, readonly GeomPlacement[]>;
  readonly scenery: readonly GeomPlacement[];
}

function splitComposition(blueprint: VisualScene): Composition | string {
  const owners = new Set(
    blueprint.objects.flatMap((object) =>
      object.source.kind === 'geom' ? [object.source.node] : [],
    ),
  );

  let root: readonly GeomPlacement[];
  try {
    root = compilePlacements(blueprint.geometry, owners);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const owned = new Map<number, GeomPlacement[]>();
  const scenery: GeomPlacement[] = [];
  for (const placement of root) {
    if (placement.owner === undefined) {
      scenery.push(placement);
      continue;
    }
    const group = owned.get(placement.owner);
    if (group === undefined) owned.set(placement.owner, [placement]);
    else group.push(placement);
  }
  return { owned, scenery };
}

/**
 * Hrdinské tvary v pořadí, ve kterém se mají mešovat.
 *
 * `priority` je pole programu a znamená přesně tohle (`ShapeProgram`). Fronta
 * klienta je sériová schválně, takže pořadí odeslání **je** pořadí, ve kterém
 * se objekty objeví — a hrdina, na kterého věta míří, se má objevit první.
 */
function meshingOrder(shapes: readonly ShapeProgram[]): readonly ShapeProgram[] {
  return [...shapes].sort((left, right) => right.priority - left.priority);
}

/** Hotový mesh plus mřížka, ve které vznikl. */
interface MeshedShape {
  readonly mesh: MeshResult;
  readonly resolution: number;
  readonly repeat?: RepeatInstances;
  readonly samplingAction?: {kind:'repeat-instanced'|'unsupported';reason:string};
}

/** Shared rough/high request path. A unit mesh keeps the original slot's fit. */
export async function meshShapeForRender(program:ShapeProgram,sessionSeed:number,resolution:number,mesh:(order:MeshOrder)=>Promise<MeshResult>):Promise<MeshedShape> {
  const preserveInstances=resolution>32&&planRootRepeat(program,32).kind==='repeat-instanced';
  const plan=planRootRepeat(program,resolution,preserveInstances);
  const sampled=plan.kind==='repeat-instanced'?plan.program:program;
  const result=await mesh({program:sampled,sessionSeed,resolution,bounds:sampled.targetBounds});
  const count=plan.kind==='repeat-instanced'?plan.instances.offsets.length:1;
  const limit=resolution>MESH_DETAIL.rough.resolution?MESH_DETAIL.high.maxTriangles:MESH_DETAIL.rough.maxTriangles;
  if(result.triangleCount*count>limit)throw new MeshBudgetError(`Repeated mesh draws ${result.triangleCount*count} triangles across ${count} copies; limit ${limit}`);
  return {mesh:result,resolution,...(plan.kind==='repeat-instanced'?{repeat:plan.instances,samplingAction:{kind:'repeat-instanced' as const,reason:`Meshed one bounded unit; ${count} internal instances preserve the original slot.`}}:
    plan.kind==='unsupported'?{samplingAction:{kind:'unsupported' as const,reason:plan.reason}}:{})};
}

/**
 * Objednat tvar a při odmítnutí, které hrubší mřížka umí změnit, ho zkusit níž.
 *
 * **Sestupuje se po dvou odmítnutích, a obě mají vlastní třídu chyby.**
 *
 * - `MeshBudgetError` — trojúhelníky nebo čas. Hrubší mřížka jich vyrobí míň.
 * - `MeshEmptyError` — v kvádru nebyl žádný povrch. Vypadá to jako opakování
 *   téhož výpočtu, ale není: rezervu si přidává worker sám jako **jednu buňku**
 *   (`paddedBounds`), tedy `1/resolution` kvádru, takže 24³ rezervuje 4,17 %
 *   tam, kde 32³ rezervovalo 3,13 %. Tvar, který svou krabici přeteče o kousek
 *   víc než jednu buňku, je na hrubší příčce uvnitř a povrch se uzavře.
 *
 * ⚠ **Do `T14r-boundspad` se po prázdném meshi nesestupovalo** a stálo tu, že
 * „meshovač je deterministický a hrubší mřížka na nich nemá co změnit".
 * Deterministický je, ale objednávka na hrubší příčce **není tatáž** — liší se
 * právě tou rezervou. Naměřeno 9. 9. 2026 nad archivem `create-raw.json`:
 * ze 41 tvarů, které projdou bránou schématu, vrátí prázdno na první příčce
 * jediný (`chessBoardShape`, c26), a na 24³ z něj vyleze **4 232
 * trojúhelníků**. Byl to jediný hrdina celého archivu, který kvůli tomu padal
 * na hlínu; po sestupu nepadá žádný.
 *
 * Vadné zadání a brána programu vlastní třídu nemají a končí hned — ty na
 * mřížce nezávisejí.
 *
 * Vrací hotový mesh, nebo větu, proč žádný není. Ta věta jde rovnou porotci,
 * takže když se sestupovalo, **řekne to i proč** — jinak by hláška jmenovala
 * mřížku 16, o které svět nikde jinde nemluví.
 */
async function meshDownTheLadder(
  program: ShapeProgram,
  sessionSeed: number,
  roughResolution: number,
  mesh: (order: MeshOrder) => Promise<MeshResult>,
): Promise<MeshedShape | string> {
  const ladder = [roughResolution, ...COARSER_GRIDS];
  let refusal = '';
  // **Příčina se sbírá po příčkách, ne do jedné proměnné** — nález nezávislé
  // revize 9. 9. 2026 na `G3`. Dokud tu stálo jedno `steppedBecause`, každá
  // další příčka ho přepsala, takže věta pro porotce přiřkla **poslední**
  // příčinu **prvnímu** sestupu: běh, který na 32³ přetekl rozpočet a na 24³
  // vrátil prázdno, hlásil „stepped down from 32 because … reserve".
  //
  // Příčky a příčiny jsou proto zarovnané: `refusedRungs[i]` je důvod, proč
  // odmítla `ladder[i]`. Fráze se přišívá k číslu mřížky („32 went over
  // budget"), aby věta nemohla mluvit o mřížce bez toho, co se na ní stalo.
  const refusedRungs: string[] = [];

  for (const resolution of ladder) {
    try {
      return await meshShapeForRender(program,sessionSeed,resolution,mesh);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);

      const retryable =
        error instanceof MeshBudgetError
          ? 'went over budget'
          : error instanceof MeshEmptyError
            ? 'did not fit inside the reserve its box carries'
            : null;

      // **Sestup se přiznává i u ne-sestupového odmítnutí** — nález nezávislé
      // revize 9. 9. 2026. Prázdný mesh na hrubší příčce se vracel holou větou
      // té příčky, tedy o mřížce, o které svět nikde nemluví („empty mesh …
      // inside the requested box" o 24³, zatímco objednávka zněla 32³), a
      // příčina „byl moc detailní" z ní zmizela úplně.
      if (retryable === null)
        return refusedRungs.length === 0
          ? refusal
          : `${refusal} — on grid ${String(resolution)}, stepped down from ${String(ladder[0])}: ${refusedRungs.join(', ')}`;

      refusedRungs.push(`${String(resolution)} ${retryable}`);
    }
  }

  return `${refusal} — the shape was remeshed down the grid ladder ${ladder.join(' → ')} and was refused on every rung: ${refusedRungs.join(', ')}`;
}

/* ------------------------------------------------------------------ *
 * Proč tenhle objekt nedostal svůj řádek — a jestli se ta bedna kreslí.
 * ------------------------------------------------------------------ */

/**
 * **Rozhodnutí (2. 9. 2026, `T13-claydouble`): u tří ze čtyř příčin se hlína
 * nekreslí. Slot zůstane, bedna zmizí.**
 *
 * Tři z těch čtyř důvodů vedly dosud k jedné a téže větě, a to je špatně
 * dvakrát: hláška mířila na špatnou příčinu a bedna se stavěla i tam, kde už
 * geometrie stojí. Liší se přitom v jediné věci — **je ta geometrie v obraze?**
 *
 * - `taken` — týž řádek si vzal jiný objekt. Kusy jsou vidět, jen patří jemu.
 * - `nested` — kusy si vzal řádek **pod** tímhle. Razítko se dává zdola nahoru
 *   a `stamped()` už orazítkovaný kus přepsat nesmí, takže vlastníkovi vyššího
 *   řádku nezbude nic. Jeho geometrie je přesto celá v obraze, jen pod cizím
 *   jménem.
 * - `carved` — řez nad řádkem slepil podstrom do jedné sítě, ta jde do kulisy.
 *   Trojúhelníky toho řádku v ní **jsou**; nedají se z ní vybrat.
 * - `anchor-only` — `anchorTo` si z cíle vzalo kvádr a kusy zahodilo. Tenhle
 *   řádek v obraze **není nikde**.
 *
 * U prvních tří by bedna na `targetBounds` prorostla skutečným tvarem —
 * porotce uvidí dvojobraz a ten čte jako vada renderu, ne jako poctivé
 * přiznání, že model napsal nárok, na který nedosáhl. Přiznání zůstává tam,
 * kam patří: ve větě `reason`, kterou nese inspektor.
 *
 * **Druhá nabízená cesta — odečíst tu geometrii z kulisy a dát ji objektu —
 * se zavrhla měřením, ne vkusem.** U `taken` i `nested` by odebrala kusy
 * soupeři, který je vlastní právem prvního razítka. U `carved` je jednotkou
 * řezu **celý podstrom**, takže by objekt dostal i sourozence toho řádku, a
 * jeho `worldBounds` by tím lhaly — a `worldBounds` slotu jsou podle design
 * booku §13.2 přesně to, co se při hot-swapu hnout nesmí. Ani jednou to tedy
 * není volba mezi dvěma dobrými konci.
 *
 * **Do opravného kola se z těch čtyř posílají dva.** `taken` a `anchor-only`
 * hlásí `findBlueprintReferenceIssues()` (`references.ts`), protože obojí se
 * pozná ze zápisu a model to umí přepsat. `nested` a `carved` ne: nárok na
 * řádek i na jeho potomka je vada teprve tehdy, když tomu vyššímu nakonec nic
 * nezbude, a to je vlastnost **výsledku**, ne zápisu — přesně ta hranice,
 * kterou má `references.ts` napsanou v hlavičce.
 *
 * **Co se tím ztrácí, přiznaně:** řez, který svůj podstrom vymazal do
 * posledního trojúhelníku a přitom nechal program naživu sourozenci, dá
 * objektu `drawn: false` nad prázdnem — tělo nebude mít žádné. Rozeznat ten
 * případ od řezu, který tvar nechal stát, by chtělo původ trojúhelníku, a ten
 * `carve` nepřenáší: slepí podstrom do jedné sítě a razítko v ní zaniká.
 * Slot, kvádr, kotvy i věta ale zůstávají, takže objekt je pořád k nalezení
 * a pořád vyměnitelný za vlastní `ShapeProgram` — a to je invariant, který
 * tenhle soubor doopravdy hájí („Prázdný slot neexistuje" nahoře).
 */
function clayCause(
  node: number,
  rival: string | undefined,
  nodes: readonly GeomNode[],
  placed: ReadonlySet<number>,
  separable: ReadonlySet<number>,
  owned: ReadonlyMap<number, readonly GeomPlacement[]>,
): { readonly reason: string; readonly drawn: boolean } {
  if (rival !== undefined)
    return {
      reason: `composition row ${node} already belongs to ${rival}, so its pieces are drawn there and not a second time here`,
      drawn: false,
    };

  // Nedosažitelný řádek se sem nedostane: `structuralIssues` takový program
  // odmítne už v `parseGeomProgram()` a `splitComposition()` z toho udělá
  // `compositionFailure`. Co projde a přesto není položené, je tedy vždycky
  // cíl `anchorTo` — proto ta věta smí mluvit o kotvě jistotou, ne odhadem.
  if (!placed.has(node))
    return {
      reason: `composition row ${node} is never placed in the world: the composition reaches it only as an anchorTo target, which reads its bounds and drops its pieces`,
      drawn: true,
    };

  if (!separable.has(node))
    return {
      reason: `composition row ${node} was fused into one mesh by a carve above it, so the scenery draws its triangles and no object can be handed them`,
      drawn: false,
    };

  const below = claimedBelow(node, nodes, owned);
  if (below !== undefined)
    return {
      reason: `composition row ${node} was handed out as row ${below} below it, so its pieces are drawn there and not a second time here`,
      drawn: false,
    };

  // Poslední větev je záměrně bez příčiny: čtyři, které jméno mají, jsou
  // vyčerpané výš. Kdyby sem něco došlo, je to nová cesta na hlínu a bedna
  // se má nakreslit — objekt bez těla je horší než objekt s bednou.
  return {
    reason: `composition row ${node} produced no piece of its own, so there is nothing to hand this object`,
    drawn: true,
  };
}

/**
 * Řádek pod `node`, který si kusy vzal dřív. Vrací ten nejbližší.
 *
 * Sestup po `childIndicesOf` odshora dolů, stejně jako `placedFrom` —
 * potomek má vždy nižší index, takže stačí jeden průchod. Hledá se v `owned`,
 * ne v pořadí zpracování objektů: razítka rozdal kompilátor dávno předtím,
 * než se sloty začaly plnit, takže odpověď nesmí záviset na tom, který objekt
 * je v blueprintu první.
 *
 * Sem se dojde jedině tehdy, když vyššímu řádku nezbylo **nic** — kdyby mu
 * zbyl jediný kus, dostal by `g2-rich` a na hlínu by nespadl. Nalezený potomek
 * je tedy doopravdy ten, kdo je má všechny.
 */
function claimedBelow(
  node: number,
  nodes: readonly GeomNode[],
  owned: ReadonlyMap<number, readonly GeomPlacement[]>,
): number | undefined {
  const below = new Set<number>([node]);
  for (let index = node; index >= 0; index -= 1) {
    if (!below.has(index)) continue;
    for (const child of childIndicesOf(nodes[index])) below.add(child);
  }
  below.delete(node);

  let nearest: number | undefined;
  for (const index of below) {
    if (owned.has(index) && (nearest === undefined || index > nearest)) nearest = index;
  }
  return nearest;
}

export async function buildProxyWorld(
  outcome: BlueprintOutcome,
  deps: ProxyDeps,
): Promise<ProxyWorld> {
  if (outcome.kind !== 'compiled') return declined(outcomeReason(outcome));
  return buildProxyWorldFrom(outcome.result.value, deps);
}

/**
 * Totéž z **holého blueprintu**, pro volajícího, který výsledek compileru nemá.
 *
 * Prohlížeč ho nemá a mít nemůže: proudem relace přiletí `blueprint.ready`
 * s blueprintem, a `verdict`, `adjustments` ani `repairs` po drátě nejdou
 * (§20). Kdyby si hlavní stránka `CompiledBlueprint` skládala přetypováním,
 * tvrdila by o certifikátu něco, co nikdy neviděla — a `tsc` by ji nechal.
 *
 * Staví se **z blueprintu a z ničeho jiného**, takže obě cesty dají doslova
 * týž svět; `buildProxyWorld()` výš je tenhle vstup plus rozbalení obálky
 * compileru.
 */
export async function buildProxyWorldFrom(
  blueprint: WorldstreamBlueprint,
  deps: ProxyDeps,
): Promise<ProxyWorld> {
  return buildVisualProxyFrom(blueprint, deps);
}

/** Render-only adapter. No synthetic WorldDoc, runtime controller or session registration. */
export async function buildVisualPreviewFrom(preview: VisualPreview, deps: ProxyDeps): Promise<ProxyWorld & { interactive: false }> {
  return { ...await buildVisualProxyFrom(visualPreviewSchema.parse(preview), deps), interactive: false };
}

async function buildVisualProxyFrom(blueprint: VisualScene, deps: ProxyDeps): Promise<ProxyWorld> {
  // **Úroveň se čte tady a nikde jinde** (§23): jedno přečtení před fan-outem,
  // pak už jen `budget`. Kdyby se `deps.quality` četlo uvnitř smyčky, mohla by
  // se úroveň mezi dvěma tvary změnit — a `contentHash` nese rozlišení, takže
  // by z jedné relace vylezly dva různé světy se stejnými jmény slotů.
  const quality: QualityTier = deps.quality ?? 'full';
  const budget = budgetFor(quality);

  const composition = splitComposition(blueprint);
  const compositionFailure = typeof composition === 'string' ? composition : null;
  const owned = typeof composition === 'string' ? new Map<number, readonly GeomPlacement[]>() : composition.owned;
  const scenery = typeof composition === 'string' ? [] : composition.scenery;

  // Tvary jdou napřed a po jednom: dokud neskončí, není co do slotů dát.
  // Selhání jednoho tvaru je věta pro ten jeden objekt, ne konec světa.
  const meshes = new Map<string, MeshedShape | string>();
  // Hrdinský rozpočet se utrácí **odshora podle priority**, protože
  // `meshingOrder()` řadí sestupně: když se na úroveň vejde jeden tvar, dostane
  // ho ten, který model označil za nejdůležitější. Zbytek se ani neobjedná —
  // §23 chce, aby degradace nespustila práci, jejíž výsledek se nepoužije.
  const heroPrograms = meshingOrder(blueprint.shapes).slice(0, budget.heroes);
  for (const program of deps.deferMeshes ? [] : heroPrograms) {
    meshes.set(
      program.shapeId,
      await meshDownTheLadder(program, blueprint.sessionSeed, budget.roughResolution, deps.mesh),
    );
  }

  const shapesById = new Map(blueprint.shapes.map((program) => [program.shapeId, program]));

  /**
   * Řádky, které si už někdo vzal, a kdo. **Nároky jsou nepřenosné.**
   *
   * Od 2. 9. 2026 hlásí druhý nárok na řádek i `findBlueprintReferenceIssues()`
   * (`references.ts`), takže se model dá o opravu ještě požádat. Tenhle záznam
   * tím ale nezaniká: opravné kolo smí skončit i tak, že vada zůstane, a bez
   * něj by pak oba objekty dostaly **tentýž objekt pole** — zeď dvakrát
   * v obraze a hot-swap jednoho slotu odpojující kusy, které pořád vlastní ten
   * druhý. Jméno soupeře se drží kvůli větě, kterou čte porotce.
   */
  const takenBy = new Map<number, string>();

  /**
   * Kam z programu dojdou trojúhelníky, a odkud se dají ještě vybrat jako
   * vlastní kusy. Rozdíl těch dvou množin je přesně `carve`.
   *
   * Program se sem čte znovu, ne z `compilePlacements()`: ten vrací hotový
   * plán, ve kterém už není poznat, který řádek ho vyrobil. A jsou to dva
   * sestupy polem indexů, ne stavba — vedle mešování je to nula.
   */
  const placed = placedFrom(blueprint.geometry.nodes, blueprint.geometry.root);
  const separable = separableFrom(blueprint.geometry.nodes, blueprint.geometry.root);

  const slots: ProxySlot[] = blueprint.objects.map((object) => {
    const clay = (reason: string, drawn = true): ProxySlot => ({
      slot: slotFromWorldForm(object, object.targetBounds),
      form: { rung: 'semantic-clay', kind: 'clay', reason, drawn },
    });

    if (object.source.kind === 'asset') {
      const resolved = (deps.assets ?? WORLDSTREAM_ASSETS).resolve(object.source);
      if (!resolved?.ok) return clay(resolved?.reason ?? 'Asset catalog is unavailable');
      return {
        slot: slotFromAsset(object, resolved.asset),
        form: { rung: 'semantic-clay', kind: 'asset', drawn: true, reference: object.source, level: 0 },
      };
    }
    if (object.source.kind === 'shape') {
      const program = shapesById.get(object.source.shapeId);
      if (deps.deferMeshes && program && heroPrograms.includes(program)) return {
        slot: slotFromForm(object, { localBounds: program.targetBounds, anchors: program.anchors }),
        form: { rung: 'semantic-clay', kind: 'clay', drawn: true, reason: 'Validated shape; detail is being built.' },
      };
      // Odkazy jsou oboustranně ověřené (`findBlueprintReferenceIssues`), takže
      // objekt míří na tvar, který v `shapes` je. Prázdné `shapes` na tomhle
      // dokumentu ale tuhle větev pouští — proto se `undefined` čte, ne tvrdí.
      const result = program === undefined ? undefined : meshes.get(program.shapeId);
      if (program === undefined || typeof result === 'string' || result === undefined) {
        if (typeof result === 'string') return clay(result);
        // Tvar, který se **neobjednal**, není tvar, který chybí. Rozlišuje se
        // to podle toho, jestli o něm blueprint ví: zná-li ho `shapesById`,
        // vypadl na hrdinském rozpočtu úrovně, ne na vadě modelu.
        return clay(program === undefined ? 'the shape is missing' : overBudgetReason(budget.heroes));
      }
      return {
        slot: slotFromForm(object, {
          localBounds: program.targetBounds,
          anchors: program.anchors,
        }),
        form: {
          rung: 'g3-reduced',
          kind: 'mesh',
          mesh: result.mesh,
          resolution: result.resolution,
          ...(result.repeat?{repeat:result.repeat}:{}),
          ...(result.samplingAction?{samplingAction:result.samplingAction}:{}),
        },
      };
    }

    const node = object.source.node;
    const rival = takenBy.get(node);
    const placements = rival === undefined ? owned.get(node) : undefined;
    if (placements === undefined || placements.length === 0) {
      if (compositionFailure !== null) return clay(compositionFailure);
      const cause = clayCause(
        node,
        rival,
        blueprint.geometry.nodes,
        placed,
        separable,
        owned,
      );
      return clay(cause.reason, cause.drawn);
    }

    const bounds = measureBounds(placements);
    if (bounds === null) {
      // **Buffery se tu schválně neuvolňují.** Nabízí se to — kusy, které
      // nikdo nedostane, už nikdo neuklidí, protože `compilePlacements()`
      // uklízí jen to, co se do kořene nedostalo. Jenže sem se dojde jedině
      // tehdy, když se řádek spekl do **prázdna**, takže je to buffer
      // o nula trojúhelnících; a `group` vrací tytéž záznamy dvěma rodičům,
      // takže by `dispose()` mohl sáhnout na geometrii, kterou pořád drží
      // kulisa. Naměřeno nezávislou revizí 31. 8. 2026: úklid vyrobil dvojí
      // uvolnění a uvolněnou geometrii v `scenery`. Nula ušetřených bajtů
      // za dvě nová selhání se neplatí.
      return clay(`composition row ${node} occupies no space`);
    }

    takenBy.set(node, object.stableId);
    return {
      slot: slotFromWorldForm(object, bounds, measurePieces(placements)),
      form: {
        rung: 'g2-rich',
        kind: 'placements',
        placements: intoSlotSpace(placements, bounds),
      },
    };
  });

  return {
    kind: 'built',
    ...(blueprint.sceneSpec ? { sceneSpec: blueprint.sceneSpec, environment: sceneEnvironment(blueprint.intent) } : {}),
    title: blueprint.title,
    sessionSeed: blueprint.sessionSeed,
    resolution: budget.roughResolution,
    quality,
    slots: slots.map(entry => ({ ...entry,
      detailProgram:(()=>{const object=blueprint.objects.find(object=>object.stableId===entry.slot.stableId);return object?.source.kind==='shape'?shapesById.get(object.source.shapeId):undefined;})(),
      slot: { ...entry.slot,
      surface: readSurface(blueprint.sceneSpec?.instances.find(instance => instance.stableId === entry.slot.stableId)
        ?.attributes.find(attribute => attribute.name === 'material')?.value),
    } })),
    scenery,
  };
}
