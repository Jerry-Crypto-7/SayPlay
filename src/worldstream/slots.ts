/**
 * **`SemanticSlot` — místo ve světě, které si objekt drží napořád.**
 *
 * Slot není podoba objektu. Je to *adresa*, na které se podoby střídají:
 * hrubá hlína, mesh v mřížce 32³, později mesh ve 48³. Design book §13.2
 * jmenuje, co se při té výměně nesmí hnout — `stableId`, world transform,
 * kotvy a sockety. Přesně ta čtveřice bydlí tady, a proto tenhle soubor
 * o žádné z těch podob nic neví: neimportuje `three`, neimportuje meshovač.
 *
 * ## Dva prostory, ne tři
 *
 * - **Prostor slotu** je ten, ve kterém je napsaná podoba. U hrdinského tvaru
 *   je to `ShapeProgram.targetBounds`, tedy souřadnice, ve kterých model
 *   napsal svoje pole vzdáleností. **Mesh z něj vyleze v témž prostoru
 *   v jakémkoli rozlišení** — a to je celý důvod, proč kotva zapsaná tady
 *   přežije výměnu podoby, zatímco kotva odvozená z meshe by se s každou
 *   mřížkou posunula.
 * - **Svět** je to, co vidí kamera. `transform` je most mezi nimi, osově
 *   zarovnaný: měřítko a posun, žádná rotace. Rotaci si nese sama podoba,
 *   ať už jako uzel `rotate` v programu tvaru, nebo jako matice kusu
 *   v kompozici.
 *
 * **Podoba je v prostoru slotu na každé příčce žebříku, bez výjimky**, takže
 * `transform` znamená pořád totéž a kdo kreslí, nemusí se ptát, odkud objekt
 * je. Kusy kompozice nesou světové matice, takže se před vložením do slotu
 * přepočítají (`intoSlotSpace()` v `./proxy.ts`). Kdyby se to nedělalo, měla
 * by jedna příčka jiný význam transformace než ostatní — a při hot-swapu by
 * se musel přepočítat rám slotu, tedy přesně to, co design book §13.2 jmenuje
 * jako invariant.
 *
 * ## Proč dvě pravidla, a ne jedno
 *
 * `slotFromForm()` a `slotFromWorldForm()` se liší v jediné otázce: **kdo ví,
 * kde objekt stojí.**
 *
 * `ShapeProgram` neví nic — nese jen svůj vlastní kvádr kolem počátku, žádné
 * umístění. Jediné, co o poloze hrdiny mluví, je `targetBounds` z placementu,
 * takže tvar se do něj **normalizuje**.
 *
 * Řádek kompozice ví všechno — model ho napsal rovnou na jeho místo
 * (`at`, `scale`, obalený v `repeat` a `scatter`), takže jeho kusy už ve světě
 * stojí. Přesadit je podle `targetBounds` by znamenalo hýbat světem podle
 * druhého, méně přesného zápisu téže věci. Deklarovaný kvádr se u nich proto
 * **neuplatňuje**; jeho rozdíl proti naměřenému je měřítko toho, jak přesně
 * model umí odhadnout vlastní kompozici, a měří ho T14, ne tenhle soubor.
 */

import type { IntentRole } from '@/model/worldstream-intent';
import type { AnchorSpec, Bounds3, Vec3 } from '@/shape/types';

import type { SemanticObject, SemanticSource } from './schema';

/**
 * Slot → svět. Nejdřív `scale`, pak `translation`, po složkách.
 *
 * Rozložené na dvě trojice místo `Matrix4` schválně: tenhle soubor čte
 * i měřidlo v Node a serverová větev, a `three` je 600 kB, které tam nemají
 * co dělat. Složit z toho matici je jeden řádek na straně, která kreslí.
 */
export interface SlotTransform {
  readonly scale: Vec3;
  readonly translation: Vec3;
}

export interface SemanticSlot {
  /** Identita objektu. Přežívá výměnu podoby i druhou větu (§13.2). */
  readonly stableId: string;
  readonly label: string;
  readonly role: IntentRole;
  readonly importance: 0 | 1 | 2 | 3;
  /** Odkud si slot bere hmotu. Kopie z objektu, aby se nemusel dohledávat. */
  readonly source: SemanticSource;
  /** Kvádr, ve kterém je napsaná podoba. Nezávislý na rozlišení meshe. */
  readonly localBounds: Bounds3;
  /** Týž kvádr po `transform`, tedy tam, kde ho porotce uvidí. */
  readonly worldBounds: Bounds3;
  readonly transform: SlotTransform;
  /** V souřadnicích slotu, ne meshe. Prázdné pole je legitimní. */
  readonly anchors: readonly AnchorSpec[];
}

/** Co o své podobě ví ten, kdo ji napsal. */
export interface SlotForm {
  readonly localBounds: Bounds3;
  readonly anchors: readonly AnchorSpec[];
}

/* ------------------------------------------------------------------ *
 * Kvádry.
 * ------------------------------------------------------------------ */

export function boundsCenter(bounds: Bounds3): Vec3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

export function boundsExtent(bounds: Bounds3): Vec3 {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
}

/** Kvádr posunutý tak, aby jeho střed ležel v počátku. */
export function centeredBounds(bounds: Bounds3): Bounds3 {
  const extent = boundsExtent(bounds);
  const half: Vec3 = [extent[0] / 2, extent[1] / 2, extent[2] / 2];
  return { min: [-half[0], -half[1], -half[2]], max: half };
}

/** Bod prostorem slotu do světa. Používá to kreslení kotev i testy. */
export function toWorld(transform: SlotTransform, point: Vec3): Vec3 {
  return [
    point[0] * transform.scale[0] + transform.translation[0],
    point[1] * transform.scale[1] + transform.translation[1],
    point[2] * transform.scale[2] + transform.translation[2],
  ];
}

/* ------------------------------------------------------------------ *
 * Odvozené kotvy.
 * ------------------------------------------------------------------ */

/**
 * Kotvy pro podobu, která si žádné nenapsala — řádek kompozice a hlína.
 *
 * Dvě, ne šest. Design book §27 příčku 5 popisuje jako „primitivní bounds
 * **a kotvy** odvozené ze `SemanticObject[]`", takže odvozovat se smí; kolik
 * jich má být, tam ale nikde nestojí, a šest stěn kvádru je šest slibů, které
 * nikdo neobjednal. `base` a `top` jsou dvě věci, které o objektu platí
 * bez ohledu na to, co je zač: na něčem stojí a něco se na něj dá položit.
 *
 * Poznat je od napsaných jde podle příčky žebříku (`ProxyRung`), ne podle
 * příznaku na kotvě — jeden zdroj pravdy o původu podoby, ne dva.
 */
export function derivedAnchors(localBounds: Bounds3): readonly AnchorSpec[] {
  const center = boundsCenter(localBounds);
  return [
    { name: 'base', at: [center[0], localBounds.min[1], center[2]], normal: [0, -1, 0] },
    { name: 'top', at: [center[0], localBounds.max[1], center[2]], normal: [0, 1, 0] },
  ];
}

/* ------------------------------------------------------------------ *
 * Dvě pravidla, jak slot vzniká.
 * ------------------------------------------------------------------ */

/**
 * Podoba se **normalizuje** do kvádru z placementu.
 *
 * Tohle je cesta hrdinského tvaru. `localBounds` je kvádr, ve kterém model pole
 * vzdáleností napsal, `object.targetBounds` je kvádr, kam ten objekt ve světě
 * patří; `transform` je právě ten poměr.
 *
 * Kotvy zůstávají **doslova** takové, jak je model napsal. Jsou v prostoru
 * slotu, tedy v témž prostoru jako `localBounds`, takže je normalizace potká
 * touž cestou jako mesh — a hlavně je nepotká **znovu** při každé změně
 * rozlišení.
 *
 * Dělení nulou tu nehrozí a nehlídá se: `shapeProgramSchema` odmítá plochý
 * i obrácený `targetBounds` („targetBounds is flat or inverted on at least one
 * axis") a `worldBoundsSchema` chce na každé ose aspoň `MIN_TARGET_EXTENT`.
 */
export function slotFromForm(object: SemanticObject, form: SlotForm): SemanticSlot {
  const local = boundsExtent(form.localBounds);
  const world = boundsExtent(object.targetBounds);
  const scale: Vec3 = [world[0] / local[0], world[1] / local[1], world[2] / local[2]];

  const localCenter = boundsCenter(form.localBounds);
  const worldCenter = boundsCenter(object.targetBounds);
  const translation: Vec3 = [
    worldCenter[0] - localCenter[0] * scale[0],
    worldCenter[1] - localCenter[1] * scale[1],
    worldCenter[2] - localCenter[2] * scale[2],
  ];

  return {
    stableId: object.stableId,
    label: object.label,
    role: object.role,
    importance: object.importance,
    source: object.source,
    localBounds: form.localBounds,
    worldBounds: object.targetBounds,
    transform: { scale, translation },
    anchors: form.anchors,
  };
}

/**
 * Podoba **si svoji velikost nese sama**; slot ji jen posadí, kam patří.
 *
 * Tohle je cesta řádku kompozice a hlíny. `worldBounds` je to, co se doopravdy
 * kreslí — u kompozice naměřený kvádr jejích kusů, u hlíny `targetBounds`,
 * protože hlína nic jiného nemá. Měřítko je proto jednotkové: nic se
 * nenormalizuje, protože kvádr **vznikl z té podoby**, ne naopak.
 *
 * `localBounds` je týž kvádr posunutý do počátku a `transform` je ten posun.
 * Není to obřad navíc: díky němu má **každý** slot počátek uprostřed sebe,
 * a `transform` znamená na všech příčkách žebříku totéž — prostor slotu do
 * světa. Kusy kompozice se do prostoru slotu přepočítají
 * (`intoSlotSpace()` v `./proxy.ts`) přesně proto, aby to platilo i o nich.
 */
export function slotFromWorldForm(object: SemanticObject, worldBounds: Bounds3): SemanticSlot {
  const localBounds = centeredBounds(worldBounds);
  const center = boundsCenter(worldBounds);

  return {
    stableId: object.stableId,
    label: object.label,
    role: object.role,
    importance: object.importance,
    source: object.source,
    localBounds,
    worldBounds,
    transform: { scale: [1, 1, 1], translation: center },
    anchors: derivedAnchors(localBounds),
  };
}
