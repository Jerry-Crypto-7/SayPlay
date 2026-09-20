/**
 * **Klientský reducer: autoritativní stav složený z proudu, nikdy dohádaný**
 * (P15 T17, design book §20 a §21).
 *
 * Server drží pravdu (`session.ts`), klient jen skládá to, co mu přišlo po
 * drátě. Rozdíl mezi „skládá" a „hádá" je celý smysl tohohle souboru: rámec
 * může dorazit dvakrát, může chybět, a po reconnectu přijde snapshot, který
 * se s rozehraným stavem musí potkat. Každá ze tří situací má tady jedno
 * pravidlo a žádná z nich nedoplňuje stav, který server neposlal.
 *
 * ## Tři pravidla, na kterých to stojí
 *
 * 1. **Duplicitní rámec se přepíše, nezopakuje.** Log slučuje průběh přepisem
 *    konce **při zachování `sequence`** (`events.ts`), takže odběratel běžně
 *    dostane totéž číslo podruhé s novějším obsahem — a to i bez jediného
 *    výpadku spojení. Rámec s `sequence === state.sequence` se proto aplikuje
 *    znovu a číslo se nehne; rámec **nižší** je stará kopie a zahazuje se celý.
 *    Obojí dohromady je idempotence: tentýž rámec podruhé nesmí hnout stavem.
 *
 * 2. **Mezera v `sequence` proud zabíjí, nezalepuje.** Chybějící číslo znamená,
 *    že klient neví, co mu uteklo — a přechod, který neviděl, si dopočítat
 *    nedá. Reducer proto vrátí `SEQUENCE_GAP` a **stav nechá netknutý**;
 *    volající (`client.ts`) si musí dojít pro snapshot. Zalepit mezeru tím, že
 *    se rámec prostě přijme, znamená svět, který na serveru neexistuje — a
 *    pozná se to až tím, že do něj porotce nemůže sáhnout.
 *
 * 3. **`revision` nikdy neklesne.** Revize objektu je jediné, co odděluje
 *    podobu, kterou porotce právě objednal, od podoby, kterou před vteřinou
 *    odvolal (§9.8). Snapshot, který dorazí opožděně nebo z opakovaného
 *    požadavku, ji proto smí jen zvednout. Klesnout by znamenalo přijmout
 *    mesh staré revize jako aktuální — a to vypadá úplně stejně dobře jako
 *    ten správný, dokud se někdo nepodívá, co ten objekt měl být.
 *
 * ## Proč tu není druhá kontrola monotonie příček
 *
 * `session.ts` už jednu má (§9.8) a druhá by se od ní časem rozešla — je to
 * tentýž důvod, pro který v něm nejsou podmínky brány `T19`. Klient ji navíc
 * nepotřebuje: rámce chodí v pořadí `sequence`, nižší číslo se zahazuje
 * pravidlem 1 a mezera pravidlem 2, takže se příčka pozpátku nemá jak dostat
 * dovnitř. Kdyby přišla, je to vada serveru a klient ji má **ukázat**, ne
 * zahladit.
 *
 * ## Co reducer schválně neumí
 *
 * `patch.*` a `branch.created` (§20) posunou jen `sequence`. Jejich stav
 * bydlí v `src/sim` a v editačním řetězu, ne tady, a vyrábět pro ně poloviční
 * kopii by znamenalo dvě pravdy o tomtéž. Přijmout je ale musí, jinak by
 * druhá věta vyrobila mezeru z pravidla 2.
 */

import { meshResolution } from './cache';
import { visualPreviewSchema, type VisualPreview } from './schema';
import { readSceneSpec, type SceneSpec } from '@/scene/spec';
import type { MeshFailure, MeshResolution } from './cache';
import type { SessionEvent, SessionEventType } from './events';
import type { RepresentationRung, SessionPhase } from './session';

/* ------------------------------------------------------------------ *
 * Stav, který klient drží.
 * ------------------------------------------------------------------ */

/**
 * Podoba jednoho objektu tak, jak ji zná klient.
 *
 * **Není to `RepresentationState` ze serveru a nemá být.** Rámce §20 nesou
 * z artefaktu tři čísla (`contentHash`, `resolution`, `triangles`), ne celý
 * `MeshArtifact` — bounds, vertices a `buildMs` po drátě nejdou. Kopírovat
 * serverový typ by tedy znamenalo pole, která by klient musel vyplnit
 * něčím vymyšleným.
 */
export interface ShapeView {
  readonly stableId: string;
  /** Revize, kterou klient zná. **Nikdy neklesne** (pravidlo 3). */
  readonly revision: number;
  readonly rung: RepresentationRung | 'failed';
  readonly contentHash: string | null;
  readonly resolution: MeshResolution | null;
  readonly triangles: number | null;
  readonly failure: MeshFailure | null;
  readonly retryable: boolean;
}

export interface ClientState {
  /** `null`, dokud nedorazil první rámec. */
  readonly sessionId: string | null;
  readonly phase: SessionPhase;
  /** Poslední přijaté číslo. Prázdný stav má 0, stejně jako prázdný log. */
  readonly sequence: number;
  readonly shapes: readonly ShapeView[];
  /** Autoritativní blueprint. Přijde rámcem `blueprint.ready` i snapshotem. */
  readonly blueprint: unknown | null;
  readonly visualPreview?: VisualPreview | null;
  /**
   * Co planner z věty přečetl, jakmile to ví — **dřív než blueprint**.
   *
   * Compiler je nejdelší volání celé cesty (naměřeno 12. 9. 2026: 64 s proti
   * 8 s planneru) a po celou tu dobu stála stavová věta na „Writing the
   * world." bez jediné známky, že se věta vůbec pochopila. Setting a teze
   * jsou to, co se dá v tu chvíli pravdivě říct. Snapshot je nenese, takže
   * po reconnectu zůstává to, co klient viděl v rámci.
   *
   * **Čtyři pole, ne dvě — P18 T5.** Server posílá celou čtveřici od
   * `sessions.ts:952` a klient si z ní do té doby bral půlku: hrdiny i seznam
   * abstrakcí zahazoval `intentOf()`, takže se porotce za celý compiler
   * nedozvěděl, které objekty ze své věty dostane a co systém neumí.
   * Seznamy jsou vždycky pole — chybějící seznam je prázdný, viz `stringList`.
   */
  readonly intent: {
    readonly sceneSpec?: SceneSpec;
    readonly setting: string;
    readonly spatialThesis: string;
    readonly heroObjects: readonly string[];
    readonly unsupported: readonly string[];
  } | null;
  /** Veřejná věta o poruše. Text výjimky poskytovatele sem nikdy nejde. */
  readonly fault: string | null;
  /**
   * Svět vznikl z uložené odpovědi modelu na tutéž větu (P16 T6). Přijde
   * v rámci `blueprint.ready` i snapshotem; `null`, dokud blueprint není
   * nebo ho model psal teď. Stavová věta z toho říká porotci, že se na
   * model nečekalo — jinak by rychlý svět vypadal jako rychlý model.
   */
  readonly reused: { readonly at: string; readonly savedCalls: number } | null;
}

export function initialClientState(): ClientState {
  return {
    sessionId: null,
    phase: 'accepted',
    sequence: 0,
    shapes: [],
    blueprint: null,
    visualPreview: null,
    intent: null,
    fault: null,
    reused: null,
  };
}

/* ------------------------------------------------------------------ *
 * Výsledek jednoho rámce.
 * ------------------------------------------------------------------ */

/**
 * Proč rámec neprošel.
 *
 * - `SEQUENCE_GAP` — mezi posledním přijatým číslem a tímhle rámcem chybí
 *   aspoň jedno. Volající musí sáhnout po snapshotu.
 * - `FOREIGN_SESSION` — rámec patří jiné relaci. Stane se to, když se čtečka
 *   přepne na novou relaci dřív, než dočte starý proud.
 */
export type ReduceFault = 'SEQUENCE_GAP' | 'FOREIGN_SESSION';

export type ReduceOutcome =
  | {
      readonly ok: true;
      readonly state: ClientState;
      /**
       * `false` znamená „ten rámec jsme už měli a nic se nezměnilo".
       * Vrací se, aby čtečka nepřekreslovala scénu na každý duplikát.
       */
      readonly applied: boolean;
    }
  | { readonly ok: false; readonly fault: ReduceFault; readonly state: ClientState };

/* ------------------------------------------------------------------ *
 * Čtení payloadů — úzce a bez důvěry.
 * ------------------------------------------------------------------ */

function record(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Seznam řetězců z rámce, nebo prázdný.
 *
 * Rámec jde po drátě a jeho payload je `unknown`, takže se **soudí každý
 * prvek**, ne jen `Array.isArray`. Jediné číslo uvnitř by jinak doteklo až do
 * `join()` ve stavové větě a porotce by četl „7" mezi jmény objektů.
 */
function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : [];
}

/**
 * Mřížka z rámce, pokud ji ten rámec **nese**. `undefined` znamená „rámec
 * o mřížce nic neřekl", `null` znamená „řekl číslo, které žebřík nejmenuje".
 *
 * ⚠ **Ty dvě věci se nesmějí slít, a do `T14r-stalegrid` slévaly** —
 * `meshResolution(…) ?? previous.resolution` nechalo obojí spadnout na starou
 * hodnotu. U chybějícího pole je to správně (`shape.refining` mřížku nenese
 * a scéna nemá zapomenout, co na ní stojí); u nejmenované mřížky je to lež:
 * rámec zrovna řekl, že mesh vznikl jinde, a stav dál tvrdí 32³.
 *
 * Dnes tudy nikdo neprojde — žádné produkční místo `MeshArtifact` z hrubší
 * mřížky nestaví (`cache.ts`, `meshResolution`). Probudí to `T21b`.
 */
function statedResolution(
  fields: Record<string, unknown>,
): MeshResolution | null | undefined {
  return 'resolution' in fields ? meshResolution(fields.resolution) : undefined;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Zásah cache z rámce nebo snapshotu, nebo `null`. Obě pole se soudí — payload je z drátu. */
function reusedOf(value: unknown): ClientState['reused'] {
  const fields = record(value);
  const at = text(fields.at);
  const savedCalls = count(fields.savedCalls);
  return at === null || savedCalls === null ? null : { at, savedCalls };
}

/** Ke které fázi patří která událost. Ostatní fázi nemění. */
const PHASE_OF: Partial<Record<SessionEventType, SessionPhase>> = {
  'session.accepted': 'accepted',
  'intent.ready': 'intent',
  'blueprint.ready': 'blueprint',
  'world.ready': 'world',
  'session.complete': 'complete',
  'session.failed': 'failed',
};

/** Na kterou příčku ta událost objekt posadí. */
const RUNG_OF: Partial<Record<SessionEventType, RepresentationRung | 'failed'>> = {
  'shape.queued': 'planned',
  'shape.coarse': 'coarse',
  'shape.refining': 'refining',
  'shape.ready': 'refined',
  'shape.failed': 'failed',
};

function blank(stableId: string): ShapeView {
  return {
    stableId,
    revision: 0,
    rung: 'planned',
    contentHash: null,
    resolution: null,
    triangles: null,
    failure: null,
    retryable: false,
  };
}

/**
 * Nová podoba objektu po jednom rámci.
 *
 * Čísla artefaktu se **přepisují jen tehdy, když je ten rámec nese**.
 * `shape.refining` nese `from`, ne nový hash, takže by je jinak vynuloval a
 * scéna by na dobu refinování přestala vědět, co na ní stojí.
 */
function shapeAfter(previous: ShapeView, type: SessionEventType, payload: unknown): ShapeView {
  const rung = RUNG_OF[type];
  if (rung === undefined) return previous;

  const fields = record(payload);
  const hash = text(fields.contentHash);
  // **Ptá se seznamu, netvrdí** — `T14r-ladderhash`. Mřížka mimo
  // `MESH_RESOLUTIONS` je záchranná příčka `COARSER_GRIDS`, ne úroveň podoby,
  // a v klíči cache nemá co dělat. Od `T14r-stalegrid` se ale **nechová jako
  // chybějící hodnota**: rámec, který mřížku nese, přebíjí i prázdnem, protože
  // zrovna řekl, že mesh vznikl jinde než posledně.
  const resolution = statedResolution(fields);
  const triangles = count(fields.triangles);

  return {
    ...previous,
    rung,
    contentHash: hash ?? (rung === 'failed' ? null : previous.contentHash),
    resolution: resolution === undefined ? previous.resolution : resolution,
    triangles: triangles ?? previous.triangles,
    failure: rung === 'failed' ? ((text(fields.reason) as MeshFailure | null) ?? null) : null,
    retryable: rung === 'failed' ? fields.retryable === true : false,
  };
}

function withShape(shapes: readonly ShapeView[], next: ShapeView): readonly ShapeView[] {
  const index = shapes.findIndex((shape) => shape.stableId === next.stableId);
  if (index === -1) return [...shapes, next];
  const copy = [...shapes];
  copy[index] = next;
  return copy;
}

/**
 * Stav po jednom rámci, **bez ohledu na `sequence`** — to řeší `reduceEvent`.
 *
 * Oddělené schválně: aplikace obsahu a rozhodnutí o pořadí jsou dvě různé
 * otázky a slepené dohromady se z nich stane funkce, u které se nedá otestovat
 * ani jedna zvlášť.
 */
function apply(state: ClientState, event: SessionEvent): ClientState {
  const phase = PHASE_OF[event.type];
  const fields = record(event.payload);
  const stableId = text(fields.stableId);
  // `accepted` je tu od P21 T4: hmoty ze slov věty přicházejí ještě před
  // `intent.ready`, protože plánovač v tu chvíli nepromluvil. Slot je týž,
  // takže náhled plánovače je pak prostě další rámec do téhož pole.
  const preview = event.type === 'visual.preview' && (state.phase === 'accepted' || state.phase === 'intent') && state.blueprint === null
    ? visualPreviewSchema.safeParse(fields.preview) : null;

  const shapes =
    stableId === null
      ? state.shapes
      : withShape(
          state.shapes,
          shapeAfter(
            state.shapes.find((shape) => shape.stableId === stableId) ?? blank(stableId),
            event.type,
            event.payload,
          ),
        );

  return {
    sessionId: event.sessionId,
    phase: phase ?? state.phase,
    sequence: Math.max(state.sequence, event.sequence),
    shapes,
    blueprint: event.type === 'blueprint.ready' ? (fields.blueprint ?? null) : state.blueprint,
    visualPreview: event.type === 'blueprint.ready' ? null : preview?.success ? preview.data : state.visualPreview ?? null,
    intent: event.type === 'intent.ready' ? intentOf(fields) : state.intent,
    fault: event.type === 'session.failed' ? (text(fields.reason) ?? 'the session failed') : state.fault,
    reused: event.type === 'blueprint.ready' ? reusedOf(fields.reused) : state.reused,
  };
}

/**
 * Záměr z `intent.ready`. **Rozhodují dvě pole, nesou se čtyři.**
 *
 * Setting a teze jsou povinné: bez nich se o pochopení věty nedá tvrdit nic a
 * stav zůstane `null`. Seznamy povinné nejsou a **chybějící seznam je prázdný
 * seznam** — na rozdíl od mřížky výš, kde se ty dva stavy slít nesmějí. Tady
 * ani jeden nic netvrdí: planner smí `unsupported` vrátit prázdné vědomě
 * („nic jsem neabstrahoval") a rámec, který pole nenese, o hrdinech mlčí
 * stejně. Věta nad tím pak buď má co vypsat, nebo popisek nenapíše vůbec.
 */
function intentOf(fields: Record<string, unknown>): ClientState['intent'] {
  const setting = text(fields.setting);
  const spatialThesis = text(fields.spatialThesis);
  const spec = fields.sceneSpec === undefined ? null : readSceneSpec(fields.sceneSpec);
  return setting === null || spatialThesis === null
    ? null
    : {
        setting,
        spatialThesis,
        heroObjects: stringList(fields.heroObjects),
        unsupported: stringList(fields.unsupported),
        ...(spec && typeof spec !== 'string' ? { sceneSpec: spec } : {}),
      };
}

/**
 * Jeden rámec do stavu. Tři pravidla z hlavičky, v tomhle pořadí.
 *
 * Pořadí není libovolné: cizí relace se musí odmítnout **dřív**, než se její
 * číslo porovná s naším, jinak by rámec z jiné relace vypadal jako mezera a
 * poslal by čtečku pro snapshot relace, které se to netýká.
 */
export function reduceEvent(state: ClientState, event: SessionEvent): ReduceOutcome {
  if (state.sessionId !== null && event.sessionId !== state.sessionId)
    return { ok: false, fault: 'FOREIGN_SESSION', state };

  // Pravidlo 1, spodní půlka: starší číslo je kopie, kterou už máme.
  if (event.sequence < state.sequence) return { ok: true, state, applied: false };

  // Pravidlo 2: mezi posledním přijatým a tímhle chybí aspoň jedno číslo.
  if (event.sequence > state.sequence + 1)
    return { ok: false, fault: 'SEQUENCE_GAP', state };

  // Pravidlo 1, horní půlka: totéž číslo s novějším obsahem (sloučený průběh).
  // Aplikuje se, `sequence` se nehne — `apply` bere maximum.
  return { ok: true, state: apply(state, event), applied: true };
}

/* ------------------------------------------------------------------ *
 * Snapshot po reconnectu.
 * ------------------------------------------------------------------ */

/** Co z `GET /api/worldstream/sessions/:id` reducer čte. */
export interface ClientSnapshot {
  readonly sessionId: string;
  readonly phase: SessionPhase;
  readonly sequence: number;
  readonly representations: readonly {
    readonly stableId: string;
    readonly revision: number;
    readonly state: { readonly kind: string; readonly [key: string]: unknown };
  }[];
  readonly blueprint?: unknown;
  readonly visualPreview?: unknown;
  readonly fault?: string | null;
  readonly reused?: unknown;
}

function viewOfRecord(
  previous: ShapeView | undefined,
  entry: ClientSnapshot['representations'][number],
): ShapeView {
  const base = previous ?? blank(entry.stableId);
  const artifact = record(entry.state.artifact);
  const hash = text(artifact.contentHash);
  const resolution = statedResolution(artifact);

  return {
    ...base,
    // Pravidlo 3. Maximum, ne přiřazení: opožděný snapshot smí revizi jen
    // zvednout, protože nižší číslo znamená podobu, kterou porotce odvolal.
    revision: Math.max(base.revision, entry.revision),
    rung: entry.state.kind as RepresentationRung | 'failed',
    contentHash: hash ?? (entry.state.kind === 'failed' ? null : base.contentHash),
    // Táž brána jako u události výš, a je tu druhá schválně: snapshot po
    // reconnectu je nezávislý vstup z drátu, ne jiný pohled na tentýž. Platí
    // pro ni i totéž rozlišení nesené a nejmenované mřížky (`T14r-stalegrid`).
    resolution: resolution === undefined ? base.resolution : resolution,
    triangles: count(artifact.triangles) ?? base.triangles,
    failure: entry.state.kind === 'failed' ? ((text(entry.state.reason) as MeshFailure | null) ?? null) : null,
    retryable: entry.state.kind === 'failed' ? entry.state.retryable === true : false,
  };
}

/**
 * Autoritativní snapshot do stavu.
 *
 * **Starší snapshot se zahazuje celý.** Dva snapshoty se dají vyrobit dvěma
 * požadavky a dorazit v opačném pořadí; ten s nižší `sequence` popisuje svět,
 * který klient už přerostl, a přijmout ho znamená vrátit se v čase. Rovnost
 * projde, protože snapshot nese i to, co rámce nenesou — revize objektů.
 */
export function applySnapshot(state: ClientState, snapshot: ClientSnapshot): ClientState {
  if (state.sessionId !== null && snapshot.sessionId !== state.sessionId) return state;
  if (snapshot.sequence < state.sequence) return state;

  const known = new Map(state.shapes.map((shape) => [shape.stableId, shape]));
  const shapes = snapshot.representations.map((entry) =>
    viewOfRecord(known.get(entry.stableId), entry),
  );
  // Objekt, který zná jen klient, se nezahazuje: snapshot je autoritativní
  // o tom, co server ví, ne o tom, co klient viděl v rámci, jenž se do
  // snapshotu ještě nestihl promítnout.
  for (const shape of state.shapes)
    if (!snapshot.representations.some((entry) => entry.stableId === shape.stableId))
      shapes.push(shape);

  return {
    sessionId: snapshot.sessionId,
    phase: snapshot.phase,
    sequence: snapshot.sequence,
    shapes,
    blueprint: snapshot.blueprint ?? state.blueprint,
    visualPreview: (snapshot.blueprint ?? state.blueprint) !== null ? null
      : Object.hasOwn(snapshot, 'visualPreview') ? (visualPreviewSchema.safeParse(snapshot.visualPreview).data ?? null) : state.visualPreview ?? null,
    intent: state.intent,
    fault: snapshot.fault ?? state.fault,
    reused: Object.hasOwn(snapshot, 'reused') ? reusedOf(snapshot.reused) : state.reused,
  };
}
