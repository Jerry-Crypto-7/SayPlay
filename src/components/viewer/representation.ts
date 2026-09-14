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
  /**
   * Kandidát, který je připojený a **čeká na odhalení** (§13.3 bod 4).
   *
   * `null` je pravidlo, ne výjimka: slot má rozdělané odhalení jen po tu
   * necelou vteřinu, než crossfade doběhne.
   */
  readonly staged: Object3D | null;
}

export type OfferOutcome =
  | { readonly ok: true; readonly view: SlotView; readonly deferred: DisposalTally }
  | {
      readonly ok: false;
      readonly refusal: RepresentationRefusal;
      readonly deferred: DisposalTally;
    };

/**
 * Proč se nedalo dokončit odhalení. Ke čtyřem důvodům `offer()` přibývá jeden.
 *
 * `NOTHING_STAGED` není totéž co `UNKNOWN_SLOT`: slot existuje, jen se na něm
 * žádné odhalení neběží. Rozlišit to je podmínka toho, aby se dvojí `commit()`
 * (dva snímky, ve kterých se odhalení uzavře) dal poznat od commitu na cizí
 * slot — první je neškodné opakování, druhé je vada volajícího.
 */
export type CommitRefusal = RepresentationRefusal | 'NOTHING_STAGED';

export type CommitOutcome =
  | { readonly ok: true; readonly view: SlotView; readonly deferred: DisposalTally }
  | {
      readonly ok: false;
      readonly refusal: CommitRefusal;
      readonly deferred: DisposalTally;
    };

export interface RepresentationRegistry {
  readonly slots: readonly SlotView[];
  /** Založí slot: obal, transformace, sockety, a volitelně hrubou podobu. */
  open(slot: SemanticSlot, rough?: Object3D | null): SlotView;
  /** Reconcile an accepted rough form while retaining the wrapper and sockets. */
  replaceRough(slot: SemanticSlot, rough: Object3D | null): SlotView;
  remove(stableId: string): DisposalTally;
  view(stableId: string): SlotView | null;
  /** Jediné dveře, kterými se podoba dostane na scénu. */
  offer(candidate: RepresentationCandidate): OfferOutcome;
  /**
   * §13.3 body 1–4: kandidát projde **týmiž branami jako `offer()`** a připojí
   * se **neviditelný** vedle hrubé podoby. Ta zůstane, dokud odhalení nedoběhne.
   *
   * Proč to není jen `offer()` s příznakem: `offer()` je atomická výměna a její
   * kontrakt zní „stará podoba odešla právě jednou". Odhalení má naopak okno,
   * ve kterém stojí na scéně obě — a to okno musí umět skončit **oběma** směry
   * (`commit`, `abandon`), protože §13.3 bod 7 chce, aby vadné odhalení nechalo
   * hrubou podobu naživu. Jedna funkce se dvěma konci by ten druhý konec
   * neuměla vůbec.
   */
  stage(candidate: RepresentationCandidate): OfferOutcome;
  /** §13.3 bod 6: kandidát se stane podobou, stará odejde právě jednou. */
  commit(stableId: string): CommitOutcome;
  /** §13.3 bod 7: odhalení selhalo — kandidát odejde, hrubá podoba zůstane. */
  abandon(stableId: string): DisposalTally;
  /** Druhá věta: zvedne revizi, běžící práci tím zneplatní. */
  revise(stableId: string): number | null;
  /** Světová poloha socketu, čtená z **obalu**. `null`, když takový není. */
  socketWorld(stableId: string, name: string): Vec3 | null;
  dispose(): DisposalTally;
}

interface SlotEntry {
  slot: SemanticSlot;
  readonly group: Group;
  readonly sockets: Map<string, Object3D>;
  revision: number;
  contentHash: string | null;
  attached: Object3D | null;
  /** Kandidát v odhalení a revize, proti které vznikl. Obojí, nebo ani jedno. */
  staged: Object3D | null;
  stagedRevision: number;
  stagedHash: string | null;
}

/** Jméno uzlu obalu. Raycast čte `stableId` odsud, ne ze jména meshe (`T23`). */
export function slotGroupName(stableId: string): string {
  return `slot:${stableId}`;
}

/** Jméno socketu na obalu. */
export function socketName(name: string): string {
  return `socket:${name}`;
}

/**
 * Který slot ten uzel patří — **inverze `slotGroupName()`, a proto stojí vedle ní**.
 *
 * Tohle je celé pravidlo raycastu (`T23`). Paprsek trefí `Mesh`, a jméno toho
 * meshe je `form:<id>` nebo `detail:<id>`, tedy jméno **podoby**, ne objektu.
 * Číst `stableId` odtamtud znamená mít druhou pravdu o identitě: podoba se
 * vymění a jméno se s ní změní, zatímco slot je právě ta věc, která výměnu
 * přežívá (§13.2). Proto se leze **nahoru** k obalu a odpověď dává jedině on.
 *
 * Trefa mimo jakýkoli slot — kulisa, podlaha, prázdno — vrací `null`. Je to
 * legitimní odpověď a znamená „porotce klikl vedle", ne chybu.
 *
 * Prefix se ani tady neopisuje: kdyby se `slotGroupName()` změnil, přestane
 * tahle funkce hledat spolu s ním, místo aby tiše spadla na nulu shod.
 */
export function slotIdOfNode(object: Object3D | null | undefined): string | null {
  for (let node = object ?? null; node !== null; node = node.parent) {
    // `slotGroupName('')` dá samotný prefix, takže se nikde neopisuje `'slot:'`.
    const prefix = slotGroupName('');
    if (node.name.startsWith(prefix) && node.name.length > prefix.length)
      return node.name.slice(prefix.length);
  }
  return null;
}

function viewOf(entry: SlotEntry): SlotView {
  return {
    stableId: entry.slot.stableId,
    revision: entry.revision,
    contentHash: entry.contentHash,
    group: entry.group,
    attached: entry.attached,
    staged: entry.staged,
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
        staged: null,
        stagedRevision: 0,
        stagedHash: null,
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

    replaceRough(slot, rough) {
      const entry = entries.get(slot.stableId);
      if (!entry) return this.open(slot, rough);
      const old = entry.slot;
      entry.revision++;
      if (entry.attached) disposeSubtree(entry.attached);
      if (entry.staged) disposeSubtree(entry.staged);
      entry.staged = null; entry.stagedHash = null; entry.contentHash = null;
      entry.attached = rough;
      if (rough) entry.group.add(rough);
      if (slot.transform.scale.some((value, index) => value !== old.transform.scale[index])) entry.group.scale.set(...slot.transform.scale);
      if (slot.transform.translation.some((value, index) => value !== old.transform.translation[index])) entry.group.position.set(...slot.transform.translation);
      for (const [name, socket] of entry.sockets) if (!slot.anchors.some(anchor => anchor.name === name)) {
        socket.removeFromParent(); entry.sockets.delete(name);
      }
      for (const anchor of slot.anchors) {
        let socket = entry.sockets.get(anchor.name);
        if (!socket) { socket = new Object3D(); socket.name = socketName(anchor.name); entry.sockets.set(anchor.name, socket); entry.group.add(socket); }
        socket.position.set(...anchor.at);
      }
      entry.slot = slot;
      return viewOf(entry);
    },

    remove(stableId) {
      const entry = entries.get(stableId);
      if (!entry) return EMPTY_TALLY;
      entries.delete(stableId);
      return disposeSubtree(entry.group);
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

      // Rozdělané odhalení tahle výměna přebíjí: jeho kandidát je starší a už
      // se nemá kam připojit. Odejde spolu se starou podobou, ne místo ní —
      // proto se účty sčítají a nepřepisují.
      const displaced = entry.staged;
      if (displaced !== null) {
        entry.group.remove(displaced);
        entry.staged = null;
        entry.stagedHash = null;
      }

      return {
        ok: true,
        view: viewOf(entry),
        deferred: addTallies(
          leaving === null ? EMPTY_TALLY : disposeSubtree(leaving),
          displaced === null ? EMPTY_TALLY : disposeSubtree(displaced),
        ),
      };
    },

    stage(candidate) {
      const entry = entries.get(candidate.stableId);
      // Brány jsou tytéž a ve stejném pořadí jako v `offer()`, protože se ptají
      // na totéž. Kdyby se lišily, mohl by tudy projít mesh, který by atomickou
      // cestou neprošel — a odhalení by z brány udělalo obchvat.
      if (entry === undefined)
        return { ok: false, refusal: 'UNKNOWN_SLOT', deferred: disposeSubtree(candidate.object) };

      if (candidate.revision !== entry.revision)
        return { ok: false, refusal: 'STALE_REVISION', deferred: disposeSubtree(candidate.object) };

      const misfit = fits(entry.slot.localBounds, candidate.bounds);
      if (misfit !== null)
        return { ok: false, refusal: misfit, deferred: disposeSubtree(candidate.object) };

      // Druhý kandidát na týž slot vytlačí prvního. Je novější, takže vyhrává
      // z téhož důvodu jako u `offer()` — a odložit se musí, protože i prohraný
      // drží geometrii na GPU.
      const displaced = entry.staged;
      if (displaced !== null) entry.group.remove(displaced);

      // **Neviditelný, ne průhledný** (§13.3 bod 4). Průhlednost je věc
      // odhalení a to ještě nezačalo; jeden snímek s plně vykresleným
      // kandidátem přes hrubou podobu je přesně ten pop-in, kterému se tahle
      // úloha vyhýbá.
      candidate.object.visible = false;
      entry.group.add(candidate.object);
      entry.staged = candidate.object;
      entry.stagedRevision = candidate.revision;
      entry.stagedHash = candidate.contentHash;

      return {
        ok: true,
        view: viewOf(entry),
        deferred: displaced === null ? EMPTY_TALLY : disposeSubtree(displaced),
      };
    },

    commit(stableId) {
      const entry = entries.get(stableId);
      if (entry === undefined) return { ok: false, refusal: 'UNKNOWN_SLOT', deferred: EMPTY_TALLY };

      const staged = entry.staged;
      if (staged === null) return { ok: false, refusal: 'NOTHING_STAGED', deferred: EMPTY_TALLY };

      const clear = (): void => {
        entry.staged = null;
        entry.stagedHash = null;
      };

      // Revize se zvedla, **zatímco odhalení běželo** — druhá věta ten objekt
      // mezitím odvolala. Kandidát se proto nepřipojí a odejde; hrubá podoba
      // zůstane, což je tentýž konec jako u selhaného odhalení.
      if (entry.stagedRevision !== entry.revision) {
        entry.group.remove(staged);
        clear();
        return { ok: false, refusal: 'STALE_REVISION', deferred: disposeSubtree(staged) };
      }

      const leaving = entry.attached;
      staged.visible = true;
      entry.attached = staged;
      entry.contentHash = entry.stagedHash;
      clear();

      return {
        ok: true,
        view: viewOf(entry),
        deferred: leaving === null ? EMPTY_TALLY : disposeSubtree(leaving),
      };
    },

    abandon(stableId) {
      const entry = entries.get(stableId);
      if (entry === undefined || entry.staged === null) return EMPTY_TALLY;

      const staged = entry.staged;
      entry.group.remove(staged);
      entry.staged = null;
      entry.stagedHash = null;
      return disposeSubtree(staged);
    },

    revise(stableId) {
      const entry = entries.get(stableId);
      if (entry === undefined) return null;
      entry.revision += 1;
      // Rozdělaný kandidát se tu **neodkládá** a je to záměr: odhalení běží
      // a jeho konec ho odloží sám — `commit()` ho odmítne jako zastaralou
      // revizi a odloží, `abandon()` taky. Odložit ho už tady by znamenalo
      // sáhnout na uzel, který právě kreslí `Materialize`, a účet za něj by
      // se ztratil, protože `revise()` vrací číslo, ne `DisposalTally`.
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
