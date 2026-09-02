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
import type { MeshOrder, MeshResult } from '@/shape/mesh-client';
import { MESH_DETAIL, type Bounds3, type ShapeProgram, type Vec3 } from '@/shape/types';

import type { WorldstreamBlueprint } from './schema';
import { boundsCenter, slotFromForm, slotFromWorldForm, type SemanticSlot } from './slots';

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

/** Mřížka hrubého světa. Jediné číslo, na kterém tahle úloha stojí. */
export const ROUGH_RESOLUTION = MESH_DETAIL.rough.resolution;

/* ------------------------------------------------------------------ *
 * Výsledek.
 * ------------------------------------------------------------------ */

export type ProxyForm =
  | { readonly rung: 'g3-reduced'; readonly kind: 'mesh'; readonly mesh: MeshResult }
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
  readonly slot: SemanticSlot;
  readonly form: ProxyForm;
}

export type ProxyWorld =
  | {
      readonly kind: 'built';
      readonly title: string;
      readonly sessionSeed: number;
      readonly resolution: number;
      /** Jeden na každý `SemanticObject`, v pořadí blueprintu. */
      readonly slots: readonly ProxySlot[];
      /** Kompozice bez toho, co si nárokoval některý slot. */
      readonly scenery: readonly GeomPlacement[];
    }
  /** Ani hlína nešla vyrobit, protože žádný blueprint není (§27, příčka 6). */
  | { readonly kind: 'declined'; readonly rung: 'declined'; readonly reason: string };

export interface ProxyDeps {
  /**
   * Objednávka meshe. Vstřikuje se, aby tenhle soubor nemusel znát worker —
   * v produktu je to `createMeshClient().mesh`, v testu atrapa.
   */
  readonly mesh: (order: MeshOrder) => Promise<MeshResult>;
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

function splitComposition(blueprint: WorldstreamBlueprint): Composition | string {
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

  const blueprint = outcome.result.value;
  const composition = splitComposition(blueprint);
  const compositionFailure = typeof composition === 'string' ? composition : null;
  const owned = typeof composition === 'string' ? new Map<number, readonly GeomPlacement[]>() : composition.owned;
  const scenery = typeof composition === 'string' ? [] : composition.scenery;

  // Tvary jdou napřed a po jednom: dokud neskončí, není co do slotů dát.
  // Selhání jednoho tvaru je věta pro ten jeden objekt, ne konec světa.
  const meshes = new Map<string, MeshResult | string>();
  for (const program of meshingOrder(blueprint.shapes)) {
    try {
      meshes.set(
        program.shapeId,
        await deps.mesh({
          program,
          sessionSeed: blueprint.sessionSeed,
          resolution: ROUGH_RESOLUTION,
          // **Syrový `targetBounds` je tu správně a rezervu sem nepřidávej.**
          // Od `T13-meshpadding` (2. 9. 2026) mele `handleMeshJob()`
          // v `paddedBounds(bounds, resolution)`; objednávka říká, kam tvar
          // patří, worker si k tomu přidá jednu buňku, aby tvar napsaný na
          // svůj vlastní obal nezmizel. Rezerva na obou místech by kvádr
          // nafoukla dvakrát a zbytečně zhrubla síť.
          bounds: program.targetBounds,
        }),
      );
    } catch (error) {
      meshes.set(program.shapeId, error instanceof Error ? error.message : String(error));
    }
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

    if (object.source.kind === 'shape') {
      const program = shapesById.get(object.source.shapeId);
      // Odkazy jsou oboustranně ověřené (`findBlueprintReferenceIssues`), takže
      // objekt míří na tvar, který v `shapes` je. Prázdné `shapes` na tomhle
      // dokumentu ale tuhle větev pouští — proto se `undefined` čte, ne tvrdí.
      const result = program === undefined ? undefined : meshes.get(program.shapeId);
      if (program === undefined || typeof result === 'string' || result === undefined) {
        return clay(typeof result === 'string' ? result : 'the shape is missing');
      }
      return {
        slot: slotFromForm(object, {
          localBounds: program.targetBounds,
          anchors: program.anchors,
        }),
        form: { rung: 'g3-reduced', kind: 'mesh', mesh: result },
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
    title: blueprint.title,
    sessionSeed: blueprint.sessionSeed,
    resolution: ROUGH_RESOLUTION,
    slots,
    scenery,
  };
}
