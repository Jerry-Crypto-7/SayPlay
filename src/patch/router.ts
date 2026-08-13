/**
 * Router patche — **dráhu rozhodují cesty, nikdy štítek od modelu**.
 *
 * `DESIGN-BOOK.md` §7 to říká přímo: *„První znění nechávalo dráhu určit modelovým
 * štítkem. To dělá z modelu autoritu nad tím, co se bude verifikovat — přesně ta
 * chyba, kterou §7 zakazuje u `EditContract`."* Model, který si smí říct „tohle je
 * jen vzhled", si tím vybírá, jestli jeho změna půjde přes verifikátor. Router
 * proto štítek **přečte a zapíše, ale nepoužije**.
 *
 * Kontrakt není v tomhle souboru — je ve zmrazeném `protocol.v1.json` pod
 * `editContract.router`, a test ho odtamtud čte místo aby ho opisoval:
 *
 * - `decidesFrom`: normalizované JSON Pointer cesty operací patche
 * - `decidesFromLabel`: `false`
 * - `simWinsRule`: jakýkoli zápis, vznik nebo smazání pod `/sim` **bezpodmínečně**
 *   přesměruje celý dotčený patch do dráhy pravidel, i když patch nese štítek `look`
 * - `labelMismatch`: zaznamenaná anomálie do telemetrie, **není** důvod k odmítnutí
 * - `mixedPatch`: rozdělí se na dva patche s jedním sémantickým záměrem
 *
 * **Normalizace je to podstatné slovo.** Dráha se nesmí rozhodovat porovnáním
 * řetězců: `"/simRevision".startsWith("/sim")` je `true`, ačkoli `simRevision` je
 * kořenové pole dokumentu a ne část `sim`; a člen doslova pojmenovaný `/sim` se
 * podle RFC 6901 píše `/~1sim`, takže by naopak proklouzl. Rozhoduje se proto nad
 * **rozebranými tokeny** — týmž dekodérem, jaký používá rozbor cesty v `reject.ts`.
 */

import type { Operation } from 'rfc6902';

import { commitPart, type Part, type PartPatch } from '../ir/revision';
import type { LookPart, WorldDoc } from '../ir/worlddoc';
import { currentRequestId } from '../obs/trace';
import { describeThrown, operationSchema, pointerOf, pointerTokens, reject, type PatchRejection } from './reject';

/** §7 mluví o dráhách, dokument o částech. Je to totéž rozdělení dvěma slovníky. */
export type Lane = 'rules' | 'look';

const LANE_OF_PART: Readonly<Record<Part, Lane>> = { sim: 'rules', look: 'look' };

/** Části dokumentu, do kterých smí patch mířit. Kořenová pole (`simHash`, obě revize) mezi ně nepatří. */
const ROUTABLE = new Set<string>(['sim', 'look']);

/**
 * Patch, jak přijde od modelu.
 *
 * `label` je tu proto, aby šel **zaznamenat**, ne aby se podle něj rozhodovalo.
 * Je `string`, ne `Part`: model může poslat cokoli a neznámý štítek je taky
 * neshoda, ne chyba typu.
 */
export interface LabelledPatch {
  readonly label?: string;
  readonly operations: readonly Operation[];
}

export interface RoutedPatch {
  readonly lane: Lane;
  readonly part: Part;
  /**
   * Operace přepsané do souřadnic **části**.
   *
   * `commitPart` klonuje `doc[part]`, takže cesta zakotvená v dokumentu
   * (`/sim/rules/open`) by v ní ukazovala mimo. Strhnout prefix je legální právě
   * proto, že ho router předtím přečetl jako rozhodnutí o dráze — nikdy se
   * nestrhává „naslepo".
   */
  readonly operations: readonly Operation[];
}

export interface RoutingAnomaly {
  readonly kind: 'label-mismatch';
  /** Korelační ID z `obs/trace`. `undefined` mimo požadavek — vymýšlet ho by byl falešný záznam. */
  readonly requestId: string | undefined;
  readonly label: string;
  /** Části, do kterých cesty skutečně míří. Ony rozhodly. */
  readonly parts: readonly Part[];
  /** První pointer, který štítku odporuje. */
  readonly evidence: string;
}

export interface Routing {
  readonly verdict: 'ROUTED';
  /** Jeden patch, nebo dva u smíšeného. Pořadí operací uvnitř každého zůstává. */
  readonly patches: readonly RoutedPatch[];
  readonly anomalies: readonly RoutingAnomaly[];
}

export type RoutingResult = Routing | PatchRejection;

/**
 * Telemetrie anomálií.
 *
 * Zmrazený protokol žádá **záznam**, ne návratovou hodnotu: neshoda štítku a cest
 * je signál o modelu, který se má sbírat napříč během, ne něco, co obslouží
 * volající a zahodí. Anomálie proto jde na obě strany — do výsledku i sem.
 *
 * P1 nemá exportér telemetrie a stavět ho dopředu by byla fikce; sběrné pole se
 * čte přes `drainRoutingAnomalies()`. Až exportér vznikne, změní se odběratel,
 * ne tohle místo.
 *
 * **Strop je tu proto, že odběratel zatím neexistuje.** Do T14 nemělo `routePatch`
 * produkčního volajícího a pole rostlo jen v testu, který ho hned vyprázdnil.
 * Endpoint `/api/edit` ho teď volá jednou za požadavek, takže dlouho běžící
 * `next start` by si bez stropu držel jednu anomálii na každý špatně oštítkovaný
 * patch — navždy a včetně `requestId`. Přetečení zahazuje **nejstarší** záznam:
 * novější anomálie vypovídá o modelu, který právě běží, a `droppedAnomalies`
 * říká nahlas, že se něco zahodilo, aby se ztráta nedala splést s tichem.
 */
const MAX_RECORDED_ANOMALIES = 256;

const recorded: RoutingAnomaly[] = [];
let dropped = 0;

function record(anomaly: RoutingAnomaly): void {
  recorded.push(anomaly);
  if (recorded.length > MAX_RECORDED_ANOMALIES) {
    recorded.splice(0, recorded.length - MAX_RECORDED_ANOMALIES);
    dropped += 1;
  }
}

export function drainRoutingAnomalies(): RoutingAnomaly[] {
  dropped = 0;
  return recorded.splice(0);
}

/** Kolik anomálií strop zahodil od posledního vyprázdnění. */
export function droppedAnomalies(): number {
  return dropped;
}

/** Do které části dokumentu cesta míří — `null`, když do žádné. */
function partOfPointer(pointer: string): Part | null {
  const [root] = pointerTokens(pointer);
  return root !== undefined && ROUTABLE.has(root) ? (root as Part) : null;
}

/** Táž cesta v souřadnicích části: kořenový token pryč, zbytek znovu zakódovaný. */
function withoutPart(pointer: string): string {
  return pointerOf(pointerTokens(pointer).slice(1));
}

/** Cesty, které operace adresuje. `move` a `copy` mají dvě a musí souhlasit. */
function pointersOf(operation: Operation): readonly string[] {
  return operation.op === 'move' || operation.op === 'copy'
    ? [operation.path, operation.from]
    : [operation.path];
}

function rehomed(operation: Operation): Operation {
  const next = { ...(operation as unknown as Record<string, unknown>) };
  next.path = withoutPart(operation.path);
  if (typeof next.from === 'string') next.from = withoutPart(next.from);
  return next as unknown as Operation;
}

/**
 * Rozřazení patche do dráhy — jediný vstup na editační cestě.
 *
 * Vrací buď rozřazené patche (jeden, nebo dva u smíšeného), nebo odmítnutí
 * s pointerem. **Odmítá se jen to, co nemá kam jít**: cesta mimo obě části,
 * kořen dokumentu, a `move`/`copy` přes hranici částí. Neshoda štítku mezi ně
 * nepatří — o té rozhodly cesty a zůstává po ní záznam.
 */
export function routePatch(patch: LabelledPatch): RoutingResult {
  // **Jeden záchyt kolem celého zbytku** — tentýž kontrakt, jaký drží `commitPart`
  // a `applyWorldPatch`, a ze stejného důvodu: výjimka odsud není odmítnutí, je to
  // odpověď bez verdiktu. U smíšeného požadavku navíc sebere i tu půlku, která se
  // mezitím commitla a ukázala hráči.
  try {
    return routeChecked(patch);
  } catch (error) {
    return reject(
      'MALFORMED_OPERATION',
      '',
      'a patch the router can read',
      `routing the patch threw: ${describeThrown(error)}`,
    );
  }
}

/** Jak se ta hodnota jmenuje v odmítnutí. Bez toho by odpověď mlčela o tom, co přišlo. */
function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function routeChecked(patch: LabelledPatch): RoutingResult {
  // **Tvar OBÁLKY dřív než tvar operací**, a je to táž třída vady, jakou o pár
  // řádků níž řeší kontrola `path` — jen o úroveň výš. `readonly Operation[]` platí
  // jen při překladu; obálka přichází jako JSON od modelu úplně stejně jako
  // operace v ní. `operations: null` vyhodí hned na `.length`, a `operations: {}`
  // má `length === undefined`, takže smyčka neproběhne ani jednou a router vydá
  // `ROUTED` bez jediného patche — tedy úspěch popisující nulovou práci, na který
  // volající odpoví „prošlo to".
  const operations = (patch as { readonly operations?: unknown } | null | undefined)?.operations;
  if (!Array.isArray(operations))
    return reject(
      'MALFORMED_OPERATION',
      '',
      'an envelope with an array of operations',
      `the patch carries operations as ${shapeOf(operations)}, so there is no path to decide the lane from`,
    );

  if (operations.length === 0)
    return reject(
      'MALFORMED_OPERATION',
      '',
      'at least one operation',
      'a patch with no operations names no path, so there is nothing to decide the lane from',
    );

  // Pořadí prvního výskytu, ne abecedně: u smíšeného patche se tím zachová
  // pořadí, ve kterém model své dva záměry vydal.
  const order: Part[] = [];
  const byPart = new Map<Part, Operation[]>();
  let mismatch: string | null = null;

  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i] as Operation;

    // Tvar dřív, než se z operace čte cesta. `readonly Operation[]` platí jen při
    // překladu — patch přichází jako JSON od modelu, takže `path` nemusí být ani
    // řetězec, a `String(undefined)` by se tvářilo jako pointer.
    const parsed = operationSchema.safeParse(operation);
    if (!parsed.success) {
      const path = (operation as { path?: unknown } | null)?.path;
      return reject(
        'MALFORMED_OPERATION',
        typeof path === 'string' ? path : '',
        'an RFC 6902 operation with op and path',
        `operation ${i}: ${parsed.error.issues[0].message}`,
      );
    }

    const pointers = pointersOf(operation);
    const parts: Part[] = [];
    for (const pointer of pointers) {
      const part = partOfPointer(pointer);
      if (part === null)
        return reject(
          'MALFORMED_OPERATION',
          pointer,
          'a path anchored in /sim or /look',
          `operation ${i} (${operation.op} ${pointer}): the document has two patchable parts and this path names neither`,
        );
      parts.push(part);
    }

    // `move` a `copy` čtou na jednom místě a zapisují na druhém. Přes hranici částí
    // to není jedna operace, kterou by šlo provést — `sim` a `look` se commitují
    // každá zvlášť, proti své vlastní revizi, a mezi tím může být jakýkoli jiný
    // commit. Rozdělit ji na `remove` + `add` musí ten, kdo ví, co tím myslel.
    if (parts.length === 2 && parts[0] !== parts[1])
      return reject(
        'MALFORMED_OPERATION',
        operation.path,
        `a ${operation.op} within one part of the document`,
        `operation ${i} (${operation.op}) reads from /${parts[1]} and writes to /${parts[0]}; the two parts commit against separate revisions, so this is not one operation`,
      );

    const [part] = parts;
    if (!byPart.has(part)) {
      byPart.set(part, []);
      order.push(part);
    }
    (byPart.get(part) as Operation[]).push(rehomed(operation));

    // **Tady je `simWinsRule` splněný, a je splněný tím, že tu nic nestojí.**
    // Neexistuje větev, ve které by štítek operaci přesunul jinam, než kam míří
    // její cesta — takže zápis pod `/sim` skončí v dráze pravidel bezpodmínečně.
    // Kdyby se to mělo hlídat až kontrolou navrch, znamenalo by to, že někde výš
    // štítek rozhoduje.
    if (mismatch === null && patch.label !== undefined && patch.label !== part) mismatch = pointers[0];
  }

  const patches: RoutedPatch[] = order.map((part) => ({
    lane: LANE_OF_PART[part],
    part,
    operations: byPart.get(part) as Operation[],
  }));

  const anomalies: RoutingAnomaly[] = [];
  if (mismatch !== null) {
    const anomaly: RoutingAnomaly = {
      kind: 'label-mismatch',
      requestId: currentRequestId(),
      label: patch.label as string,
      parts: order,
      evidence: mismatch,
    };
    anomalies.push(anomaly);
    record(anomaly);
  }

  return { verdict: 'ROUTED', patches, anomalies };
}

// ---------------------------------------------------------------------------
// Dráha vzhledu — sémanticky neodmítá, technicky ano
// ---------------------------------------------------------------------------

/**
 * Stavba geometrie z `look`. V P1 ji dodává volající; generátor rodin je P5.
 *
 * Smí **vyhodit** — tenhle typ existuje právě proto, že vyhodit smí a že se to
 * nesmí dostat k rendereru.
 */
export type GeometryBuild = (look: LookPart) => void;

export interface LookLaneOutcome {
  readonly verdict: 'COMMITTED' | 'REVERTED' | 'REJECTED';
  /**
   * Dokument, se kterým se dá dál renderovat — **vždycky nějaký**.
   *
   * Po `REVERTED` i po `REJECTED` je to ten předchozí, tedy včetně předchozího
   * `look` a předchozí `lookRevision`.
   */
  readonly doc: WorldDoc;
  /** Odmítnutí ze schématu nebo z rozboru cesty. `null`, když se commitovalo nebo vracelo. */
  readonly rejection: PatchRejection | null;
  /** Proč se vrátil předchozí `look`. `null`, když se nevracelo. */
  readonly reverted: string | null;
}

/**
 * Dráha vzhledu: commit, pak stavba geometrie — a **pád stavby je návrat, ne pád**.
 *
 * §7: *„Sémanticky neodmítá, technicky ano."* Vzhled se nesmí odmítnout proto, že
 * se nelíbí, ale vadná geometrie shodí renderer a poruší §13.4 (*„Prázdná
 * obrazovka je chyba"*) — tedy právě to pravidlo, kvůli kterému dráha vzhledu
 * existuje. Rozdíl mezi „nová geometrie se nepostavila" a „hráč kouká na černo" je
 * celý přínos téhle funkce.
 *
 * Schéma a konečnost čísel řeší `commitPart`; sem patří jen ta část, kterou žádná
 * kontrola nad daty nezachytí, protože se projeví teprve při stavbě.
 */
export function runLookLane(doc: WorldDoc, patch: PartPatch, build: GeometryBuild): LookLaneOutcome {
  if (patch.part !== 'look')
    return {
      verdict: 'REJECTED',
      doc,
      rejection: reject(
        'STRUCTURE',
        '/lookRevision',
        'a patch routed to the look lane',
        `the look lane received a ${patch.part} patch — the lane is decided by the paths, so this is a caller bug, not a model one`,
      ),
      reverted: null,
    };

  const result = commitPart(doc, patch);
  if (result.verdict === 'REJECTED') return { verdict: 'REJECTED', doc, rejection: result, reverted: null };

  try {
    build(result.doc.look);
  } catch (error) {
    // Vrací se **vstupní** dokument, ne ten commitnutý: `lookRevision` se tím
    // nezvedne, takže další patch vydaný proti staré revizi pořád platí a klient
    // se nedostane do stavu, kdy je pozadu proti dokumentu, který nikdy neuviděl.
    return {
      verdict: 'REVERTED',
      doc,
      rejection: null,
      reverted: `building geometry from the new look threw: ${describeThrown(error)}`,
    };
  }

  return { verdict: 'COMMITTED', doc: result.doc, rejection: null, reverted: null };
}
