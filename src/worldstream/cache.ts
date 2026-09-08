/**
 * **Hotový mesh a cache, která ho nepočítá dvakrát** (P13 vlna 3, T15).
 *
 * Design book §9.6 (`MeshArtifact`) a §10.4 (idempotence). Tenhle soubor drží
 * tři věci, které patří k sobě: **jak hotový mesh vypadá jako záznam**, **jak
 * se z programu a rozlišení spočítá jeho klíč** a **kdo si pamatuje, že se to
 * už jednou počítalo**.
 *
 * **Proč je `MeshArtifact` tady a ne v `src/shape/types.ts`.** Ten soubor je
 * *jazyk* tvaru a v hlavičce se výslovně vymezuje proti tomu, aby v něm
 * bydlelo rozlišení, kvalita a cena — to jsou rozhodnutí potrubí (§9.5).
 * `MeshArtifact` je přesně takové rozhodnutí: nese `resolution`. A `contentHash`
 * je **jeho pole i klíč téhle cache** naráz, takže typ a hashovací funkce musí
 * stát vedle sebe. Kdyby stály jinde, dá se artefakt uložit pod cizí klíč a
 * každé pozdější `lookup` vrátí cizí mesh — tiše a natrvalo.
 *
 * **Co v artefaktu schválně není: kotvy.** §9.6 je vyjmenovává, ale §12.2 a
 * hotový `SemanticSlot` z T13 je dávají **slotu**, ne meshi, a `slots.ts` to
 * odůvodňuje: kotva v souřadnicích slotu přežije změnu rozlišení, kotva
 * odvozená z meshe ne. Druhá kopie na artefaktu je právě ten způsob, jak se
 * spouštěč dveří ocitne jinde než dveře.
 *
 * **Co v artefaktu taky není: samotné trojúhelníky.** `vertices` a `triangles`
 * jsou *počty*. Buffery vlastní pracovník a registry (T18); záznam je JSON,
 * aby přežil reload přes snapshot (§10.4) a dal se poslat do snapshotu relace
 * (§21) bez toho, aby se přes drát tahaly megabajty.
 */

import { canonicalHash } from '@/ir/worlddoc';
import type { Bounds3, ShapeProgram } from '@/shape/types';

/**
 * Čtyři mřížky, které §9.6 pojmenovává.
 *
 * V **žebříku podob** jsou jen dvě — 32³ hrubá hmota a 48³ vysoký detail,
 * a ta čísla drží `MESH_DETAIL` v `src/shape/types.ts`, ne tenhle seznam.
 * 64³ a 96³ zůstávají pojmenované, protože je umí měřicí stránka
 * `/dev/mesh-budget` a export; produkt je na scénu nepouští.
 */
export const MESH_RESOLUTIONS = [32, 48, 64, 96] as const;

export type MeshResolution = (typeof MESH_RESOLUTIONS)[number];

/**
 * Číslo z drátu jako `MeshResolution`, nebo `null`. **Ptá se seznamu, netvrdí.**
 *
 * ⚠ **Existuje kvůli `T14r-ladderhash` a je to jedna ze dvou nabídnutých cest —
 * vzala se ta druhá.** `COARSER_GRIDS = [24, 16]` (`proxy.ts`) je záchranná
 * příčka **pod** hrubou hmotou; nejsou to plnohodnotné úrovně podoby a do
 * `MESH_RESOLUTIONS` proto nepatří. Alternativa byla ty mřížky do seznamu
 * přijmout, což by znamenalo přeučit `everyTierIsPlayable()`, co je úroveň.
 * Zvolila se užší cesta: seznam zůstává čtyřmi pojmenovanými mřížkami a
 * **odmítá se na hranici**, kudy neověřené číslo vstupuje.
 *
 * Ta hranice je dnes jediná: dvě místa v `reducer.ts`, kde se `resolution`
 * čte z události nebo ze snapshotu. Do `T14r-ladderhash` tam stálo
 * `as MeshResolution` — přetypování, které o hodnotě nic neověří — takže
 * `resolution: 24` prošlo tiše a `shapeContentHash(program, 24)` by vyrobil
 * klíč cache mimo jmenovaný žebřík. Dvě různé podoby téhož tvaru pak můžou
 * sdílet klíč, nebo naopak minout cache. Dnes to nikdo nepošle (žádné
 * produkční místo `MeshArtifact` z hrubší mřížky nestaví); probudí to `T21b`,
 * až hrubý mesh z prohlížeče začne hlásit artefakt.
 */
export function meshResolution(value: unknown): MeshResolution | null {
  return MESH_RESOLUTIONS.includes(value as MeshResolution) ? (value as MeshResolution) : null;
}

/** Hotová, změřená geometrie jednoho tvaru. Design book §9.6. */
export interface MeshArtifact {
  readonly shapeId: string;
  /** FNV-1a nad kanonickým programem a rozlišením. Klíč téhle cache. */
  readonly contentHash: string;
  readonly resolution: MeshResolution;
  readonly vertices: number;
  readonly triangles: number;
  /** Kvádr **naměřený na hotovém meshi**, ne deklarovaný v programu. */
  readonly bounds: Bounds3;
  readonly buildMs: number;
}

/**
 * Proč jeden tvar nedopadl. Uzavřený seznam, protože `RepresentationState`
 * z něj skládá `failed` a nový důvod bez rozhodnutí o `isRetryable()` by
 * neprošel překladačem.
 *
 * - `EMPTY_MESH` — meshovač nenašel jedinou buňku se změnou znaménka
 *   (`mesh-worker.ts`: tvar leží mimo kvádr, nebo kvádr celý uvnitř tvaru).
 * - `BUDGET_EXCEEDED` — příčka `MESH_DETAIL` na čase nebo trojúhelnících.
 * - `GATE_REJECTED` — geometrická brána §12.1.
 * - `ARTIFACT_MISMATCH` — kontrolní přečtení §12.3 nesedí s tím, co brána
 *   schválila.
 * - `WORKER_FAILED` — pracovník spadl jako celek.
 * - `CANCELLED` — zvedla se revize a běžící práce se zrušila (§10.5).
 */
export const MESH_FAILURES = [
  'EMPTY_MESH',
  'BUDGET_EXCEEDED',
  'GATE_REJECTED',
  'ARTIFACT_MISMATCH',
  'WORKER_FAILED',
  'CANCELLED',
] as const;

export type MeshFailure = (typeof MESH_FAILURES)[number];

/**
 * Má smysl to zkusit znovu?
 *
 * Rozhoduje o tom **naměřený fakt, ne opatrnost**: meshovač je deterministický
 * — mezi Node a prohlížečem se ve všech čtyřech mřížkách nelišil ani jeden
 * trojúhelník (design book §11.2). Tentýž program v témže rozlišení tedy dá
 * podruhé přesně tentýž výsledek, takže opakovat prázdný mesh, přetečený
 * rozpočet ani zamítnutí brány nemá co změnit; opakovat by se dala jen
 * porucha okolí.
 *
 * `ARTIFACT_MISMATCH` je v retryable půlce schválně: nesedící kontrolní
 * přečtení znamená, že se něco pokazilo **mezi** bránou a zápisem, ne že by
 * program byl špatně.
 */
export function isRetryable(failure: MeshFailure): boolean {
  return failure === 'WORKER_FAILED' || failure === 'CANCELLED' || failure === 'ARTIFACT_MISMATCH';
}

/**
 * Klíč cache: FNV-1a nad kanonickým programem plus rozlišením (§10.4).
 *
 * `canonicalHash` je tentýž algoritmus, kterým se hashuje `WorldDoc.sim` —
 * jedna hashovací rodina v celém projektu, ať se neudržují dvě. Klíče objektů
 * si seřadí sám, takže dva programy se stejným obsahem a jiným pořadím klíčů
 * dají tentýž klíč; to je celý důvod, proč se hashuje kanonizace a ne
 * `JSON.stringify`.
 *
 * **`sessionSeed` v klíči není, a je to rozhodnutí, ne opomenutí.** Mesh na
 * něm závisí — `displace` je šum deterministický ze semínka (§7.2) — jenže
 * semínko je vlastnost **celé relace**, ne jedné objednávky: uvnitř jedné
 * relace je konstantní, takže by do každého klíče přidalo tutéž hodnotu.
 * Místo toho se semínkem svazuje **celá cache** (`createMeshCache`) a restore
 * pod jiným semínkem se odmítne. Klíč tak zůstává přesně tím, co říká §10.4,
 * a záměna napříč relacemi je nemožná tvarem, ne domluvou.
 */
export function shapeContentHash(program: ShapeProgram, resolution: MeshResolution): string {
  return canonicalHash({ program, resolution });
}

/**
 * Co cache o klíči ví.
 *
 * `pending` je plnohodnotná odpověď, ne mezistav pro pořádek: bez ní by dvě
 * objednávky téhož tvaru, které dorazí dřív než první výsledek, vyrobily dvě
 * práce — a „tentýž program v témže rozlišení se nikdy nepočítá dvakrát" by
 * platilo jen pro práce, které se nepotkaly v čase.
 */
export type CacheLookup =
  | { readonly kind: 'hit'; readonly artifact: MeshArtifact }
  | { readonly kind: 'pending' }
  | { readonly kind: 'miss' };

export interface MeshCacheSnapshot {
  readonly sessionSeed: number;
  readonly entries: readonly MeshArtifact[];
}

export interface MeshCache {
  readonly sessionSeed: number;
  /** Kolik hotových artefaktů. Rozdělané práce se nepočítají. */
  readonly size: number;
  readonly pending: number;
  lookup(key: string): CacheLookup;
  /**
   * Zabere klíč pro výpočet. `true` znamená „počítej", `false` znamená
   * „nepočítej, výsledek je hotový nebo se na něj čeká".
   */
  reserve(key: string): boolean;
  /** Uloží hotový artefakt a uvolní rezervaci. */
  settle(key: string, artifact: MeshArtifact): void;
  /** Práce skončila bez artefaktu. Klíč se uvolní, aby šel retry. */
  release(key: string): void;
  snapshot(): MeshCacheSnapshot;
}

function build(sessionSeed: number, entries: readonly MeshArtifact[]): MeshCache {
  const done = new Map<string, MeshArtifact>(entries.map((entry) => [entry.contentHash, entry]));
  const running = new Set<string>();

  return {
    sessionSeed,

    get size() {
      return done.size;
    },

    get pending() {
      return running.size;
    },

    lookup(key) {
      const artifact = done.get(key);
      if (artifact !== undefined) return { kind: 'hit', artifact };
      return running.has(key) ? { kind: 'pending' } : { kind: 'miss' };
    },

    reserve(key) {
      if (done.has(key) || running.has(key)) return false;
      running.add(key);
      return true;
    },

    settle(key, artifact) {
      // **Artefakt uložený pod cizí klíč je tichá záměna meshe**, ne chyba,
      // která se ozve. Hash je pole artefaktu, takže se ta shoda dá ověřit
      // jedním porovnáním — a je to jediné místo, kde ji ještě někdo vidí.
      if (artifact.contentHash !== key) {
        throw new Error(
          `mesh artifact ${artifact.shapeId} hashes to ${artifact.contentHash}, cannot be filed under ${key}`,
        );
      }
      running.delete(key);
      done.set(key, artifact);
    },

    release(key) {
      running.delete(key);
    },

    snapshot() {
      // **Rozdělaná práce do snapshotu nepatří.** Snapshot se čte po reloadu
      // a reload zabil pracovníka, který ji počítal; obnovit ji jako `pending`
      // znamená klíč, na který se čeká navždy a který `reserve` nikdy nepustí.
      return { sessionSeed, entries: [...done.values()] };
    },
  };
}

export function createMeshCache(sessionSeed: number): MeshCache {
  return build(sessionSeed, []);
}

/**
 * Obnoví cache z snapshotu (§10.4: „cache žije v relaci a přežije reload").
 *
 * Neshoda semínka je **výjimka, ne prázdná cache**: tichý návrat prázdna by
 * vypadal jako studený start a rozdíl by se projevil až tím, že se všechno
 * přepočítá — kdežto tichá **shoda** pod cizím semínkem by vrátila mesh
 * napsaný jiným šumem a nikdo by se to nedozvěděl vůbec.
 */
export function restoreMeshCache(snapshot: MeshCacheSnapshot, sessionSeed: number): MeshCache {
  if (snapshot.sessionSeed !== sessionSeed) {
    throw new Error(
      `mesh cache was built with session seed ${snapshot.sessionSeed}, cannot restore it under ${sessionSeed}`,
    );
  }
  return build(sessionSeed, snapshot.entries);
}
