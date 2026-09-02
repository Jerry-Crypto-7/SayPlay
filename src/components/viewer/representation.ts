/**
 * **`RepresentationRegistry` — jediný vlastník slotů** (P15 T18, design book
 * §9.7, §9.8 a §13.2).
 *
 * Slot je adresa, na které se střídají podoby: hrubá hlína, mesh v 32³, později
 * mesh v 64³. Tenhle soubor je **jediné místo, kde se ta výměna smí stát**, a
 * to je celý jeho smysl. Kdyby mesh připojoval ten, komu dorazil z workeru,
 * měl by každý příjemce vlastní představu o tom, co se při výměně nesmí hnout
 * — a §13.2 jmenuje čtyři věci, které se hnout nesmějí: `stableId`, world
 * transform, kotvy a sockety.
 *
 * ## Obal drží invarianty, podoba se mění pod ním
 *
 * Každý slot má **obal** (`Group`) s transformací slotu a se sockety jako
 * vlastními potomky. Podoba je jeho **jediný další potomek** a vyměňuje se
 * odpojením jednoho uzlu a připojením druhého. Sockety se tím z principu
 * nemají jak hnout — nejsou na meshi, jsou vedle něj. Kdyby seděly na meshi,
 * byla by jejich světová poloha funkcí právě té věci, která se vyměňuje, a
 * „přežije objekt výměnu podoby" by bylo tvrzení, které nikdo nedrží.
 *
 * ## Pozdní výsledek staré revize se zahazuje, nepřipojuje
 *
 * Druhá věta zvedne revizi objektu a zruší běžící práci (§10.5), jenže
 * pracovník se ukončuje na hranici bloku — výsledek staré revize tedy může
 * dorazit **po** commitu nové. Bez kontroly je to tichá výměna: objekt dostane
 * podobu, kterou porotce právě odvolal, a nikde to nevyskočí. Je to tatáž vada
 * a tatáž kontrola jako v `src/worldstream/session.ts`; rozdíl je, že tam se
 * hlídá **stav relace** a tady **scéna**, a obojí se hlídat musí, protože mezi
 * nimi je asynchronní worker.
 *
 * ## Dvě brány, dvě různé otázky — a tohle je ta druhá
 *
 * `T19` (`src/worldstream/mesh-gate.ts`) se ptá, jestli je mesh **zdravý**:
 * prázdná geometrie, přetečené trojúhelníky, nekonečné číslo, exploze
 * materiálů. Tenhle soubor se ptá, jestli je to mesh **tohohle slotu**: sedí
 * do kvádru, který si slot objednal? Jsou to různé otázky a nesmí se slít do
 * jedné — duplikovaná brána je brána, která se časem rozejde (viz tentýž zákaz
 * v hlavičce `session.ts`).
 *
 * ## Prohraný kandidát se odkládá **právě jednou**
 *
 * Kandidát nese geometrii, materiál a textury na GPU, ať vyhrál nebo ne.
 * Odložit ho nulakrát znamená únik, který se projeví až u šestého promptu;
 * odložit ho dvakrát je v three neškodné, ale rozbije to součet — a součet je
 * jediné, čím se únik měří. Každá cesta tímhle souborem proto končí právě
 * jedním `disposeSubtree()` nad tím, co odešlo, a nikdy nad tím, co zůstalo.
 */

import { Group, Object3D, Vector3 } from 'three';

import type { Bounds3, Vec3 } from '@/shape/types';
import { boundsExtent, type SemanticSlot } from '@/worldstream/slots';

import { addTallies, disposeSubtree, EMPTY_TALLY, type DisposalTally } from './dispose';

/**
 * O kolik smí naměřený kvádr přerůst ten deklarovaný, než je to jiný objekt.
 *
 * **Zdůvodnění, ne vkus:** meshovač měří kvádr na hotovém meshi, kdežto slot
 * nese kvádr, ve kterém je podoba *napsaná*. Marching cubes klade vrcholy na
 * hrany buněk, takže tvar dotýkající se stěny svého kvádru z něj o kus buňky
 * vyleze — a čím hrubší mřížka, tím větší ten kus je. Čtvrtina je na to
 * pohodlně dost a zároveň o řád méně, než je rozdíl, který dělá „to není ten
 * objekt".
 *
 * ⚠ **Číslo se má přeměřit v `T19` nad korpusem `T8`, ne tady.** Tam se měří,
 * kolik programů by práh odmítl; tady by to bylo jedno číslo z jednoho tvaru.
 */
export const SLOT_FIT_TOLERANCE = 1.25;

/** Proč se kandidát nepřipojil. Stabilní kódy, ne volný text. */
export type RepresentationRefusal =
  | 'UNKNOWN_SLOT'
  | 'STALE_REVISION'
  | 'BOUNDS_MISMATCH'
  | 'BOUNDS_DEGENERATE';

export interface RepresentationCandidate {
  readonly stableId: string;
  /** Revize, **proti které** ta práce vznikla. Ne aktuální revize slotu. */
  readonly revision: number;
  readonly contentHash: string;
  /** Kvádr **naměřený na hotovém meshi**, v prostoru slotu. */
  readonly bounds: Bounds3;
  /** Co dorazilo z workeru. Registry je jediný, kdo to smí připojit. */
  readonly object: Object3D;
}

export interface SlotView {
  readonly stableId: string;
  /** Aktuální revize slotu. Zvedá ji druhá věta (`revise`). */
  readonly revision: number;
  /** Hash připojené podoby, nebo `null` pro slot, který ji nemá. */
  readonly contentHash: string | null;
  /** Obal s transformací a sockety. **Přežívá každou výměnu.** */
  readonly group: Group;
  readonly attached: Object3D | null;
}

export type OfferOutcome =
  | { readonly ok: true; readonly view: SlotView; readonly deferred: DisposalTally }
  | {
      readonly ok: false;
      readonly refusal: RepresentationRefusal;
      readonly deferred: DisposalTally;
    };

export interface RepresentationRegistry {
  readonly slots: readonly SlotView[];
  /** Založí slot: obal, transformace, sockety, a volitelně hrubou podobu. */
  open(slot: SemanticSlot, rough?: Object3D | null): SlotView;
  view(stableId: string): SlotView | null;
  /** Jediné dveře, kterými se podoba dostane na scénu. */
  offer(candidate: RepresentationCandidate): OfferOutcome;
  /** Druhá věta: zvedne revizi, běžící práci tím zneplatní. */
  revise(stableId: string): number | null;
  /** Světová poloha socketu, čtená z **obalu**. `null`, když takový není. */
  socketWorld(stableId: string, name: string): Vec3 | null;
  dispose(): DisposalTally;
}

interface SlotEntry {
  readonly slot: SemanticSlot;
  readonly group: Group;
  readonly sockets: Map<string, Object3D>;
  revision: number;
  contentHash: string | null;
  attached: Object3D | null;
}

/** Jméno uzlu obalu. Raycast čte `stableId` odsud, ne ze jména meshe (`T23`). */
export function slotGroupName(stableId: string): string {
  return `slot:${stableId}`;
}

/** Jméno socketu na obalu. */
export function socketName(name: string): string {
  return `socket:${name}`;
}

function viewOf(entry: SlotEntry): SlotView {
  return {
    stableId: entry.slot.stableId,
    revision: entry.revision,
    contentHash: entry.contentHash,
    group: entry.group,
    attached: entry.attached,
  };
}

/** Sedí naměřený kvádr do toho, který si slot objednal? */
function fits(declared: Bounds3, measured: Bounds3): RepresentationRefusal | null {
  const wanted = boundsExtent(declared);
  const got = boundsExtent(measured);

  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(got[axis]) || got[axis] <= 0) return 'BOUNDS_DEGENERATE';
    // Podlaha proti dělení nulou u plochého slotu: kvádr o nulové výšce je
    // legitimní zápis (deska), a poměr proti němu by byl nekonečno pokaždé.
    const room = Math.max(wanted[axis], 1e-6) * SLOT_FIT_TOLERANCE;
    if (got[axis] > room) return 'BOUNDS_MISMATCH';
  }

  return null;
}

export function createRepresentationRegistry(): RepresentationRegistry {
  const entries = new Map<string, SlotEntry>();

  return {
    get slots() {
      return [...entries.values()].map(viewOf);
    },

    open(slot, rough = null) {
      const existing = entries.get(slot.stableId);
      // Slot, který už stojí, se neresetuje. Blueprint se může zopakovat
      // (reconnect, druhá věta), a založit obal znovu by odpojilo podobu,
      // která na scéně je, a spolu s ní i sockety — tedy přesně invarianty
      // §13.2, kvůli kterým ten obal existuje.
      if (existing !== undefined) return viewOf(existing);

      const group = new Group();
      group.name = slotGroupName(slot.stableId);
      group.scale.set(...slot.transform.scale);
      group.position.set(...slot.transform.translation);

      const sockets = new Map<string, Object3D>();
      for (const anchor of slot.anchors) {
        const socket = new Object3D();
        socket.name = socketName(anchor.name);
        socket.position.set(...anchor.at);
        group.add(socket);
        sockets.set(anchor.name, socket);
      }

      const entry: SlotEntry = {
        slot,
        group,
        sockets,
        revision: 0,
        contentHash: null,
        attached: null,
      };
      if (rough !== null) {
        group.add(rough);
        entry.attached = rough;
      }

      entries.set(slot.stableId, entry);
      return viewOf(entry);
    },

    view(stableId) {
      const entry = entries.get(stableId);
      return entry === undefined ? null : viewOf(entry);
    },

    offer(candidate) {
      const entry = entries.get(candidate.stableId);
      // Pořadí kontrol je pořadí §9.8: neznámý slot se nesmí odmítnout jako
      // zastaralá revize, protože to by poslalo hledat závod tam, kde žádný
      // není. A **každá** odmítavá cesta odloží kandidáta, protože ten drží
      // paměť na GPU bez ohledu na to, proč prohrál.
      if (entry === undefined)
        return { ok: false, refusal: 'UNKNOWN_SLOT', deferred: disposeSubtree(candidate.object) };

      if (candidate.revision !== entry.revision)
        return { ok: false, refusal: 'STALE_REVISION', deferred: disposeSubtree(candidate.object) };

      const misfit = fits(entry.slot.localBounds, candidate.bounds);
      if (misfit !== null)
        return { ok: false, refusal: misfit, deferred: disposeSubtree(candidate.object) };

      // Vyhrál. Odejde **ta stará podoba**, ne ta nová — a právě jednou.
      const leaving = entry.attached;
      entry.group.add(candidate.object);
      entry.attached = candidate.object;
      entry.contentHash = candidate.contentHash;

      return {
        ok: true,
        view: viewOf(entry),
        deferred: leaving === null ? EMPTY_TALLY : disposeSubtree(leaving),
      };
    },

    revise(stableId) {
      const entry = entries.get(stableId);
      if (entry === undefined) return null;
      entry.revision += 1;
      return entry.revision;
    },

    socketWorld(stableId, name) {
      const socket = entries.get(stableId)?.sockets.get(name);
      if (socket === undefined) return null;
      // Ptáme se three, ne počítáme si to sami: kdyby se počítalo tady,
      // testoval by se výpočet, ne to, kde ten socket na scéně doopravdy je.
      // `getWorldPosition` si přepočet předků obstará sám.
      const world = socket.getWorldPosition(new Vector3());
      return [world.x, world.y, world.z];
    },

    dispose() {
      let tally = EMPTY_TALLY;
      for (const entry of entries.values()) tally = addTallies(tally, disposeSubtree(entry.group));
      entries.clear();
      return tally;
    },
  };
}
