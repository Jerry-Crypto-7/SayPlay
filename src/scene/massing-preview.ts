import {GEOM_VERSION,type GeomNode,type GeomProgram} from '@/geom/program';
import type {IntentRole,PlannedObject,PlannerEmission} from '@/model/worldstream-intent';
import type {Vec3} from '@/shape/types';
import {visualPreviewSchema,type SemanticObject,type VisualPreview} from '@/worldstream/schema';
import {readSceneSpec} from './spec';

/**
 * **Hrubý hmotový náhled — jedna bedna na jeden naplánovaný objekt.**
 *
 * `buildIntentPreview` je přísný schválně: ověřuje relace a radši neřekne nic,
 * než aby ukázal rozvržení, které věta netvrdí. Naměřeno nad osmnácti
 * archivovanými plány série T18 tím profilem projde **jeden**
 * (`intent-preview.ts`, P20 F1). Zbylých sedmnáct relací tedy porotce po dobu
 * čekání nevidí vůbec nic — a to je díra, kterou zavírá tenhle soubor.
 *
 * Tohle **není** druhý layout engine a nic neověřuje. Postaví hmotový model:
 * každý objekt z rejstříku plánovače dostane jednu hmotu `mass.block`, jejíž
 * **velikost říká role a `importance`** a **poloha pořadí v emisi**. Žádná
 * relace se nečte, takže není co odmítnout.
 *
 * ## Kudy se ke klientovi dostane, že je to jen hrubé
 *
 * Značka je **uvnitř náhledu**, ne na rámci `visual.preview`. Rozhodl o tom
 * reconnect: podle §21 je autoritativní snapshot a ten nese jedině pole
 * `visualPreview` (`reducer.ts` → `applySnapshot`), takže cokoli přidaného do
 * payloadu rámce vrácenému klientovi zmizí. Značka je proto první řádek
 * `validation.limitations` (`MASSING_PREVIEW_NOTICE`) a čte ji
 * `isMassingPreview()`; `validation.layout` je `not-requested`, protože tahle
 * cesta doopravdy žádné rozvržení neověřila.
 *
 * `stage` zůstává `intent-layout`. Třetí hodnota by byla změna
 * `visualPreviewSchema`, tedy kontraktu, který čtou i rámce compileru — na to
 * tahle úloha nesahá.
 *
 * ## Proč to přesto smí odmítnout
 *
 * Návratový tvar je union stejně jako u přísné cesty. Není to obrana proti
 * plánu — je to obrana proti tomu, aby funkce vracela objekt, o kterém
 * `visualPreviewSchema` neřekla ano. Emise, která prošla
 * `readPlannerEmission` s `requireSceneSpec`, sem takový objekt poslat nemůže:
 * `readSceneSpec` prožene každý `stableId` abecedou identifikátoru. Tvrzení
 * „projde všech 18" je proto **naměřené**
 * (`evals/worldstream/massing-preview.json`), ne slíbené typem.
 */

/** Jediná značka, která přežije reconnect. Klient ji čte `isMassingPreview()`. */
export const MASSING_PREVIEW_NOTICE =
  'Rough massing only: one block per planned object, sized by its role and importance and placed in plan order. Nothing here is checked against the sentence — shapes, proportions, colors and spacing all change once the world is compiled.';

/**
 * Značka hmot odhadnutých **ze slov věty, bez modelu** (`word-massing.ts`, P21 T4).
 *
 * Táž cesta jako `MASSING_PREVIEW_NOTICE` — první řádek `limitations`, protože
 * jen ten přežije snapshot — ale jiná věta, protože je to jiné tvrzení:
 * plánovač ještě nepromluvil a bloky jsou slovník, ne plán. Klient podle ní
 * ukáže vlastní hlášku (`isWordMassing()`), a náhled plánovače ji nahradí celou.
 */
export const WORD_MASSING_NOTICE = 'Blocks guessed from the words in your sentence. The model has not answered yet.';

export interface MassOrigin {
  readonly stableId: string;
  /** Řádek `GeomProgram`, na kterém ta hmota stojí. */
  readonly node: number;
  readonly basis: 'ground-plate' | 'grid-cell';
  /** Pořadí v `plan.objects` — jediné, co rozhoduje o buňce. */
  readonly index: number;
  readonly role: IntentRole;
  readonly importance: 0 | 1 | 2 | 3;
  readonly size: Vec3;
  readonly at: Vec3;
}

export type MassingPreviewResult =
  | {ok: true; preview: VisualPreview; origins: readonly MassOrigin[]}
  | {ok: false; reason: string; details: readonly string[]};

/**
 * Kolik hmot se vejde do jednoho náhledu.
 *
 * Váže **obálka**, ne geometrie: `visualPreviewSchema` bere nejvýš 64
 * sémantických objektů. `GEOM_LIMITS.maxNodes` (96 řádků, skupina po šestnácti
 * potomcích) je pod tím volný — 64 hmot + 4 skupiny + kořen = 69 řádků.
 * Emise s víc identitami se ustřihne a zbytek se napíše do omezení.
 */
const MAX_MASSES = 64;

/** Nejdelší hrana jedné hmoty. `scale3` v `GeomProgram` končí na osmi. */
const PLATE_EXTENT = 8;
const MIN_EDGE = 0.1;
const PLATE_HEIGHT = 0.25;
const GAP = 0.4;

/** `importance` 0–3 → měřítko. Nejmenší hmota je pořád vidět, největší nepřebije desku. */
const IMPORTANCE_GAIN = [0.6, 0.8, 1, 1.25] as const;

const isGround = (role: IntentRole): boolean => role === 'architecture' || role === 'terrain';
const clamp = (value: number): number => Math.min(PLATE_EXTENT, Math.max(MIN_EDGE, value));

/** Přirozená velikost: **role** dá tvar, **`importance`** měřítko. Nic jiného. */
function naturalSize(object: PlannedObject): {footprint: number; height: number} {
  const gain = IMPORTANCE_GAIN[object.importance];
  const base =
    object.role === 'hero' ? {footprint: 1.4, height: 1.8}
    : object.role === 'effect' ? {footprint: 0.5, height: 0.5}
    : {footprint: 0.8, height: 0.9};
  return {footprint: base.footprint * gain, height: base.height * gain};
}

/**
 * `notice` je první řádek `limitations` — výchozí je značka plánovačského
 * hmotového náhledu, odhad ze slov posílá `WORD_MASSING_NOTICE`. Nic jiného
 * se mezi oběma cestami neliší: geometrie je táž funkce nad jinou emisí.
 */
export function buildMassingPreview(plan: PlannerEmission, options: {sessionSeed: number; notice?: string}): MassingPreviewResult {
  const objects = plan.objects.slice(0, MAX_MASSES);
  const limitations = [options.notice ?? MASSING_PREVIEW_NOTICE];
  if (objects.length < plan.objects.length)
    limitations.push(`Only ${String(objects.length)} of the ${String(plan.objects.length)} planned identities fit one geometry program; the rest carry no block in this preview.`);

  const grid = objects.filter((object) => !isGround(object.role));
  const columns = Math.max(1, Math.ceil(Math.sqrt(grid.length)));
  const rows = Math.max(1, Math.ceil(grid.length / columns));
  const stride = Math.max(0.5, ...grid.map((object) => naturalSize(object).footprint)) + GAP;
  // Jedna hmota se nesmí roztáhnout přes `scale3`, takže se zmenší celá
  // mřížka jedním činitelem — poměry mezi hmotami zůstanou, jak byly.
  const fit = Math.min(1, (PLATE_EXTENT - GAP) / (Math.max(columns, rows) * stride));
  const plate = clamp(Math.max(columns, rows) * stride * fit + GAP);

  const nodes: GeomNode[] = [];
  const origins: MassOrigin[] = [];
  const semantic: SemanticObject[] = [];
  let cell = 0;
  let plateTop = 0;

  for (const [index, object] of objects.entries()) {
    // Zapisovatelná trojice schválně: `GeomNode` má umístění mutable, kdežto
    // `Vec3` v `MassOrigin` je readonly — a ta readonly do mutable nejde.
    let size: [number, number, number];
    let at: [number, number, number];
    if (isGround(object.role)) {
      // Desky se vrší dolů v pořadí z emise, takže se nepřekrývají a mřížka
      // stojí na nule.
      size = [plate, PLATE_HEIGHT, plate];
      at = [0, plateTop - PLATE_HEIGHT / 2, 0];
      plateTop -= PLATE_HEIGHT;
    } else {
      const natural = naturalSize(object);
      const footprint = clamp(natural.footprint * fit);
      const height = clamp(natural.height * fit);
      size = [footprint, height, footprint];
      at = [(cell % columns - (columns - 1) / 2) * stride * fit, height / 2, (Math.floor(cell / columns) - (rows - 1) / 2) * stride * fit];
      cell += 1;
    }
    const node = nodes.length;
    nodes.push({kind: 'mass', variant: 'block', at, scale: size});
    origins.push({stableId: object.stableId, node, basis: isGround(object.role) ? 'ground-plate' : 'grid-cell',
      index, role: object.role, importance: object.importance, size, at});
    semantic.push({stableId: object.stableId, label: object.label.slice(0, 120),
      synonyms: object.synonyms.filter((word) => word.length > 0).slice(0, 16).map((word) => word.slice(0, 120)),
      role: object.role, importance: object.importance, source: {kind: 'geom', node},
      targetBounds: {min: [at[0] - size[0] / 2, at[1] - size[1] / 2, at[2] - size[2] / 2],
        max: [at[0] + size[0] / 2, at[1] + size[1] / 2, at[2] + size[2] / 2]}});
  }

  // Tentýž nosník jako v přísné cestě: skupina unese 16 potomků, takže se
  // řádky slučují po šestnácti, dokud nezbyde jeden kořen.
  const roots = nodes.map((_, index) => index);
  while (roots.length > 16) {
    const children = roots.splice(0, 16);
    roots.push(nodes.length);
    nodes.push({kind: 'group', children});
  }
  const root = nodes.length;
  nodes.push({kind: 'group', children: roots});
  const geometry: GeomProgram = {version: GEOM_VERSION, nodes, root};

  // SceneSpec jde dál jen tehdy, když pořád popisuje přesně tenhle rejstřík —
  // po ustřižení už ne. Nic z něj se přitom neověřuje.
  const spec = plan.sceneSpec === undefined ? undefined : readSceneSpec(plan.sceneSpec, objects.map((object) => object.stableId));

  const parsed = visualPreviewSchema.safeParse({kind: 'visual-preview', stage: 'intent-layout', interactive: false,
    version: 'worldstream-v2', sessionSeed: options.sessionSeed, title: plan.intent.setting.slice(0, 120), intent: plan.intent,
    ...(spec === undefined || typeof spec === 'string' ? {} : {sceneSpec: spec}),
    geometry, objects: semantic, shapes: [],
    look: {modules: {}, palette: 'sand', lightRig: 'rim', atmosphere: 'clear', materialRoles: {}, camera: {}, audio: {}},
    validation: {layout: 'not-requested', limitations}});
  if (!parsed.success)
    return {ok: false, reason: 'PREVIEW_SCHEMA', details: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)};
  return {ok: true, preview: parsed.data, origins};
}

/** Je tenhle náhled hrubý hmotový, nebo přísné rozvržení? Jediná otázka klienta. */
export function isMassingPreview(preview: VisualPreview): boolean {
  return preview.validation.limitations[0] === MASSING_PREVIEW_NOTICE;
}

/** Jsou to hmoty ze slov věty, tedy náhled, který plánovač teprve nahradí? */
export function isWordMassing(preview: VisualPreview): boolean {
  return preview.validation.limitations[0] === WORD_MASSING_NOTICE;
}
