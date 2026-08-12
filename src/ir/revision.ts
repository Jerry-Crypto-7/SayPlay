/**
 * Dvě nezávislé revize — a je to **oprava konkrétního selhání**, ne symetrie
 * pro symetrii.
 *
 * `DESIGN-BOOK.md` §13.1.1 ho popisuje přesně: *„okamžitý vzhledový commit během
 * probíhající verifikace `sim` by revizi posunul — a patch pravidel by se pak
 * odmítal jako zastaralý, ačkoli se na `sim` nic nezměnilo."* Se sdílenou revizí
 * je živá editace vzhledu a živá editace pravidel v neustálém konfliktu, který
 * nemá žádnou příčinu v datech.
 *
 * `baseRevision` v patchi proto odkazuje na **tu svou** revizi. Commit do `look`
 * nikdy nezvedne `simRevision` a naopak — a protože obojí je jen celé číslo,
 * musí to hlídat test s **oběma** asercemi: že se ta správná zvedla o jedna
 * a ta druhá zůstala. Bez první z nich by prošla i implementace s konstantními
 * revizemi, která jen umí odmítnout „zastaralou" hodnotu.
 */

import { applyPatch, type Operation } from 'rfc6902';

import { reject, rejectionFromZod, type PatchRejection } from '../patch/reject';
import {
  lookSchema,
  unhashableValues,
  simHashOf,
  simSchema,
  validateLook,
  type WorldDoc,
} from './worlddoc';

export type Part = 'sim' | 'look';

export interface RevisionCommit {
  readonly verdict: 'COMMITTED';
  readonly doc: WorldDoc;
  readonly part: Part;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
}

export type RevisionResult = RevisionCommit | PatchRejection;

/** Patch nese revizi, proti které byl vydán. Bez ní by nešlo poznat zastaralost. */
export interface PartPatch {
  readonly part: Part;
  readonly baseRevision: number;
  readonly operations: readonly Operation[];
}

function revisionOf(doc: WorldDoc, part: Part): number {
  return part === 'sim' ? doc.simRevision : doc.lookRevision;
}

/**
 * Aplikuje patch na **jednu část** dokumentu.
 *
 * Transakčně stejně jako `patch/apply.ts`: operace se pouštějí na hlubokou kopii
 * a aktivní dokument se vrací nedotčený, dokud kopie neprojde. Zastaralá
 * `baseRevision` se odmítne **dřív, než se cokoli aplikuje** — na aktivní graf se
 * v tom případě nesáhne vůbec, což je celý smysl kontroly.
 */
export function commitPart(doc: WorldDoc, patch: PartPatch): RevisionResult {
  const current = revisionOf(doc, patch.part);
  if (patch.baseRevision !== current)
    return reject(
      'STRUCTURE',
      `/${patch.part}Revision`,
      `baseRevision ${current}`,
      `patch was issued against ${patch.part}Revision ${patch.baseRevision}, current is ${current}`,
    );

  const draft = structuredClone(doc[patch.part]) as unknown;
  const outcomes = applyPatch(draft as object, [...patch.operations]);
  for (let i = 0; i < outcomes.length; i += 1) {
    const failure = outcomes[i];
    if (failure === null) continue;
    const failedPath = (failure as { path?: unknown }).path;
    const operation = patch.operations[i];
    return reject(
      'MALFORMED_OPERATION',
      typeof failedPath === 'string' ? failedPath : operation.path,
      `an applicable ${operation.op} target`,
      `operation ${i} (${operation.op} ${operation.path}): ${failure.message}`,
    );
  }

  if (patch.part === 'look') {
    const shape = lookSchema.safeParse(draft);
    if (!shape.success) return rejectionFromZod(shape.error, ['look']);
    // Konečnost VŠECH čísel — `NaN` projde typem `number` a rozbije stavbu
    // geometrie až tam, kde se nedá vrátit nic než prázdná obrazovka.
    const verdict = validateLook(draft);
    if (!verdict.ok) return reject('STRUCTURE', '/look', 'finite numbers throughout', verdict.issues[0]);

    const committed: WorldDoc = { ...doc, look: shape.data, lookRevision: doc.lookRevision + 1 };
    return {
      verdict: 'COMMITTED',
      doc: committed,
      part: 'look',
      revisionBefore: doc.lookRevision,
      revisionAfter: committed.lookRevision,
    };
  }

  const shape = simSchema.safeParse(draft);
  if (!shape.success) return rejectionFromZod(shape.error, ['sim']);

  // Konečnost platí pro `sim` NALÉHAVĚJI než pro `look`: `NaN`, `Infinity`
  // i `null` kolabují v kanonickém zápisu na tentýž řetězec, takže by se
  // dokumenty s různou sémantikou schovaly za jeden `simHash` — a hash je tady
  // kotva certifikátu, ne jen kontrolní součet.
  const nonFinite = unhashableValues(shape.data, '/sim');
  if (nonFinite.length > 0) return reject('STRUCTURE', '/sim', 'finite numbers throughout', nonFinite[0]);

  // `simHash` se přepočítá, protože se změnila právě ta část, ze které se počítá.
  const withSim = { ...doc, sim: shape.data, simRevision: doc.simRevision + 1 };
  const committed: WorldDoc = { ...withSim, simHash: simHashOf(withSim) };
  return {
    verdict: 'COMMITTED',
    doc: committed,
    part: 'sim',
    revisionBefore: doc.simRevision,
    revisionAfter: committed.simRevision,
  };
}

export interface MixedResult {
  /** Vzhled se commitne OKAMŽITĚ — nečeká na ověření pravidel. */
  readonly look: RevisionResult;
  /** Pravidla se vloží do AKTUÁLNÍHO dokumentu, tedy už do toho se vzhledem. */
  readonly sim: RevisionResult;
  readonly doc: WorldDoc;
}

/**
 * Smíšený požadavek: **nečeká se na sebe**.
 *
 * Zmrazený protokol to má doslova: *„Validní `look` se commitne OKAMŽITĚ; po
 * ověření se `sim` atomicky vloží do AKTUÁLNÍHO dokumentu se zachováním
 * aktuálního `look` i `lookRevision`."*
 *
 * „Do aktuálního" je to podstatné slovo. Kdyby se `sim` vkládal do dokumentu
 * zachyceného před vzhledovým commitem, vzhled by se tím vrátil zpátky — hráč by
 * viděl, jak mu úprava zmizela ve chvíli, kdy se dokončila verifikace něčeho
 * úplně jiného.
 */
export function commitMixed(doc: WorldDoc, lookPatch: PartPatch, simPatch: PartPatch): MixedResult {
  const look = commitPart(doc, lookPatch);
  const afterLook = look.verdict === 'COMMITTED' ? look.doc : doc;

  // `sim` se vydává proti své vlastní revizi, kterou vzhledový commit nezvedl —
  // proto tenhle patch projde, i když se mezitím vzhled změnil.
  const sim = commitPart(afterLook, simPatch);
  const afterSim = sim.verdict === 'COMMITTED' ? sim.doc : afterLook;

  return { look, sim, doc: afterSim };
}

/** Dokument, jak ho vidí volající po neúspěchu — vždy ten původní. */
export function isStale(result: RevisionResult): boolean {
  return result.verdict === 'REJECTED' && result.expected.startsWith('baseRevision');
}

// `parseWorldDoc` tu **záměrně není**. Vracela `WorldDoc` po pouhém `safeParse`,
// tedy bez kontroly verze i bez kontroly `simHash`, pod jménem, které vypadá
// jako ta samozřejmá cesta — a příští volající, který potřebuje „přečíst
// dokument", by sáhl po ní a požadavek „migrace explicitně odmítá" by se tiše
// stal doporučením. Jediný vstup je `migrateWorldDoc`.
