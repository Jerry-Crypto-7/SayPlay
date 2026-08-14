/**
 * Rozhodovací půlka `/api/edit` — **mimo route modul, a jsou pro to dva důvody**.
 *
 * ## Aby to šlo otestovat
 *
 * Všech 25 zmrazených editačních patchů míří výhradně pod `/sim`: vzhled v P1
 * nikdo neemituje a generátor rodin je až P5. `Allowed doubles` úlohy přitom
 * zakazuje nahradit upstream čímkoli mimo `MANIFEST.lock`, takže **vzhledovou
 * větev nespustí přes `POST` žádný legální vstup** — ani commit `look`, ani
 * brána 409 nad `lookRevision`. Obojí tu leželo jako kód, o kterém tvrdil něco
 * jen docblock: dvě po sobě jdoucí brány nad T14 předvedly mutaci, která
 * prošla celou sadou (prohození `lookPatch`/`simPatch`, a pak brána, která
 * přestala číst `routed.part` a ptala se natvrdo na `sim`).
 *
 * Testuje se to proto o patro níž, ručně psanými `look` patchi — týž postup,
 * jakým dráhu vzhledu testuje T22 (`mixed.patch.json` je taky ruční JSON).
 * **Hranice `route:POST /api/edit` tím nedostává double:** běží skutečný router,
 * skutečný `commitMixed`, skutečný verifikátor svědka i skutečné počítání dosahu.
 *
 * ## Aby route modul nesl jen to, co Next dovoluje
 *
 * App Router modul `route.ts` smí exportovat metody HTTP a pár konfiguračních
 * konstant, ne libovolné funkce. Ověřovací typy, které to hlídají, generuje
 * `next build` do `.next/types/` — a `tsconfig.json` je dnes `exclude`-uje, takže
 * ta kontrola v tomhle repu **neběží** a zelený build o legálnosti exportu nic
 * nedokazuje (viz „Rozhodnout" u T14 v plánu). Držet rozhodovací kód mimo route
 * modul je správně bez ohledu na to, jak se ten `exclude` rozhodne.
 */

import { buildRuntimeWorld } from '../../../ir/build';
import { findDanglingReferences } from '../../../ir/references';
import { commitMixed, commitPart, isStale, type Part, type PartPatch, type RevisionResult } from '../../../ir/revision';
import type { WorldDoc } from '../../../ir/worlddoc';
import type { PatchRejection } from '../../../patch/reject';
import { changedLeaves } from '../../../patch/scope';
import { verifyWitness } from '../../../verify/witness';

export type Stage = 'routing' | 'apply' | 'references' | 'lowering' | 'witness';

export interface Rejection {
  readonly stage: Stage;
  readonly reason: string;
  readonly pointer: string;
  readonly detail: string;
}

/** Revize, které klient prohlašuje za aktuální. Obě, protože obě části se patchují. */
export interface BaseRevision {
  readonly sim: number;
  readonly look: number;
}

export function revisionOf(doc: WorldDoc, part: Part): number {
  return part === 'sim' ? doc.simRevision : doc.lookRevision;
}

export interface StaleRevision {
  readonly part: Part;
  /** Revize, proti které byl patch podle klienta vydán. */
  readonly claimed: number;
  /** Revize, na které dokument doopravdy je. */
  readonly current: number;
}

/**
 * Brána 409 — **zastaralost se rozhoduje před aplikací čehokoli**.
 *
 * Kdyby se na ni přišlo až uvnitř `commitMixed`, smíšený požadavek by zůstal půl
 * commitnutý a klient by dostal 409 nad světem, který se mu mezitím pod rukama
 * pohnul.
 *
 * **Ptá se každé části na JEJÍ vlastní revizi, a to je celý §13.1.1.** Patch
 * pravidel se posuzuje proti `simRevision`, patch vzhledu proti `lookRevision`.
 * Se sdílenou revizí by vzhledový commit uprostřed verifikace `sim` odmítl patch
 * pravidel jako zastaralý, ačkoli se na `sim` nezměnilo nic — a naopak by
 * `look` patch propadl branou dolů a `commitPart` by ho odmítl až **uvnitř 200**
 * jako `apply/STALE_REVISION`, tedy mimo deklarovanou taxonomii stavů.
 *
 * **Co tahle brána doopravdy umí, poctivě.** Endpoint je bezstavový: „aktuální"
 * revizi nezná odjinud než z dokumentu, který mu poslal týž volající. Porovnává
 * tedy `baseRevision` proti `doc.<part>Revision` — dvě čísla z jednoho požadavku.
 * Chytí tím **vnitřní rozpor požadavku**, což je přesně ta chyba, kterou dělá
 * klient se dvěma revizemi a jedním strojem: patch vydaný proti jedné části,
 * zatímco druhá se mezitím posunula. **Nechytí zastaralost proti světu, který
 * drží někdo jiný** — volající se dvěma koly pozadu pošle svůj dokument i své
 * `baseRevision` a oba spolu souhlasí. Autorita nad „aktuální" revizí by
 * znamenala server, který si světy drží; ten v P1 neexistuje a stavět ho tady by
 * bylo mimo rozsah úlohy. Co existuje, je monotónní čítač: `revision.ts` zvedá
 * revizi části o jedna při každém commitu, takže dvě různé historie nikdy
 * nevydají totéž číslo nad týmž obsahem.
 *
 * Vrací **první** rozpor v pořadí, ve kterém model své záměry vydal, nebo `null`.
 */
export function staleRevision(
  doc: WorldDoc,
  base: BaseRevision,
  routed: readonly { readonly part: Part }[],
): StaleRevision | null {
  for (const patch of routed) {
    const current = revisionOf(doc, patch.part);
    if (base[patch.part] === current) continue;
    return { part: patch.part, claimed: base[patch.part], current };
  }
  return null;
}

export interface CommitOutcome {
  readonly outcome: 'CERTIFIED' | 'REJECTED';
  /** Které půlky si volající smí nechat. Pořadí je pořadí commitu, ne abecední. */
  readonly applied: readonly Part[];
  readonly changedLeaves: readonly string[];
  /** Dokument po commitu — u odmítnuté půlky ten předchozí. */
  readonly after: WorldDoc;
  readonly certificate: ReturnType<typeof verifyWitness> | null;
  readonly rejections: readonly Rejection[];
}

/** Commit rozřazených částí a atribuce výsledku. */
export function commitRoutedParts(doc: WorldDoc, parts: readonly PartPatch[]): CommitOutcome {
  // Smíšený požadavek: `look` se commitne OKAMŽITĚ a `sim` se vkládá do
  // AKTUÁLNÍHO dokumentu, tedy už do toho se vzhledem (§13.1.1). Vlastní
  // pořadí by vzhled vrátilo zpátky hráči před očima.
  const lookPatch = parts.find((patch) => patch.part === 'look');
  const simPatch = parts.find((patch) => patch.part === 'sim');
  const outcome =
    lookPatch !== undefined && simPatch !== undefined
      ? commitMixed(doc, lookPatch, simPatch)
      : singlePart(doc, parts[0]);

  const applied: Part[] = [];
  // **Obě půlky si nesou svůj důvod.** U smíšeného požadavku umí selhat každá
  // zvlášť a z jiné příčiny; nechat si jen jednu znamená, že se ta druhá ztratí
  // beze stopy a model dostane k opravě polovinu zprávy.
  const rejections: Rejection[] = [];
  let after = doc;

  if (outcome.look !== null) {
    if (outcome.look.verdict === 'COMMITTED') {
      applied.push('look');
      after = outcome.look.doc;
    } else rejections.push(fromRejection('apply', outcome.look));
  }

  let certificate: ReturnType<typeof verifyWitness> | null = null;

  if (outcome.sim !== null) {
    if (outcome.sim.verdict === 'COMMITTED') {
      // `look` se mezitím mohl commitnout, takže se bere dokument ze `sim` větve —
      // ta už ten vzhled nese.
      const simDoc = outcome.sim.doc;
      const verified = certifySim(simDoc);
      certificate = verified.certificate;
      if (verified.rejection === null) {
        applied.push('sim');
        after = simDoc;
      } else {
        // Necertifikovaný patch se vztahuje **výhradně na `sim`** — `look`, který
        // se commitnul, v `applied` zůstává a scéna se s ním nezahazuje.
        rejections.push(verified.rejection);
      }
    } else rejections.push(fromRejection('apply', outcome.sim));
  }

  return {
    outcome: rejections.length === 0 ? 'CERTIFIED' : 'REJECTED',
    applied,
    // Dosah **diffem stavu**, ne čtením operací (`editContract.changedLeafRule`).
    // Počítá se jen z toho, co se doopravdy použilo: necertifikovaná `sim` se
    // nikam neaplikuje, takže její listy nejsou změněné, jen navrhované.
    changedLeaves: [
      ...(applied.includes('sim') ? changedLeaves(doc.sim, after.sim, '/sim') : []),
      ...(applied.includes('look') ? changedLeaves(doc.look, after.look, '/look') : []),
    ].sort(),
    after,
    certificate,
    rejections,
  };
}

/** Jednodílný patch ve stejném tvaru, v jakém vrací výsledek `commitMixed`. */
function singlePart(doc: WorldDoc, patch: PartPatch): { look: RevisionResult | null; sim: RevisionResult | null } {
  const result = commitPart(doc, patch);
  return patch.part === 'look' ? { look: result, sim: null } : { look: null, sim: result };
}

function fromRejection(stage: Stage, result: PatchRejection): Rejection {
  return {
    stage,
    // `isStale` sem u `sim` dojít nemá — zastaralost odbavuje `staleRevision`
    // před aplikací — ale kdyby se ta hranice někdy posunula, ať to řekne
    // verdikt, ne mlčení.
    reason: isStale(result) ? 'STALE_REVISION' : result.reason,
    pointer: result.pointer,
    detail: `${result.detail} (expected ${result.expected})`,
  };
}

/**
 * Svědek po editaci — **znovu ověřený nad commitnutou `sim`**, ne převzatý.
 *
 * Editace, která pravidla změní tak, že svědek přestane docházet do výhry, je
 * přesně ta věc, kterou má editační větev umět zachytit. Převzít starý
 * certifikát by znamenalo tvrdit o novém světě něco, co bylo naměřené nad jiným.
 */
function certifySim(doc: WorldDoc): {
  certificate: ReturnType<typeof verifyWitness> | null;
  rejection: Rejection | null;
} {
  // Před snížením do IR, ne po něm: povrchová jména se do IR nedostanou, takže
  // odkaz osiřelý po editaci by se za nimi už nedal najít.
  const dangling = findDanglingReferences(doc);
  if (dangling.length > 0)
    return {
      certificate: null,
      rejection: {
        stage: 'references',
        reason: 'DANGLING_REFERENCE',
        pointer: '/sim',
        detail: `${dangling[0].where} names no declared ${dangling[0].namespace} ${dangling[0].name}`,
      },
    };

  const built = buildRuntimeWorld(doc.sim);
  if (!built.ok)
    return {
      certificate: null,
      rejection: {
        stage: 'lowering',
        reason: built.reason,
        pointer: '/sim',
        detail: built.issues[0] ?? 'no detail',
      },
    };

  const verdict = verifyWitness(built.world, built.world.trace);
  if (verdict.verdict === 'REJECTED')
    return {
      certificate: verdict,
      rejection: {
        stage: 'witness',
        reason: verdict.reason,
        pointer: '/sim/witness',
        detail: verdict.detail,
      },
    };

  return { certificate: verdict, rejection: null };
}
