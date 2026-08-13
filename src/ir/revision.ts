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

import { operationSchema, pointerFault, reject, rejectionFromZod, type PatchRejection } from '../patch/reject';
import {
  lookSchema,
  ruleKeyFault,
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

  // **Jeden záchyt kolem celého zbytku**, a je to reakce na to, jak tahle úloha
  // probíhala: pět kol brány, pokaždé skutečná vada, pokaždé jiné dveře —
  // vymyšlená hloubka schématu, `Infinity`, `undefined` hlouběji ve stromu,
  // `Date`/`Map`/`Set`, `__proto__` v cestě. Zavírat je po jedné znamená zavřít
  // tu, kterou zrovna někdo našel.
  //
  // Kontrakt je tím pádem jednoduchý a nezávisí na výčtu: `commitPart` **nikdy
  // nevyhodí**. Volající dostane verdikt, protože u smíšeného požadavku je rozdíl
  // mezi „`sim` neprošel" a pádem ten, že pád sebere i `look`, který se právě
  // commitnul a ukázal hráči.
  try {
    return commitChecked(doc, patch);
  } catch (error) {
    return threw(`/${patch.part}`, `applying the patch to ${patch.part}`, error);
  }
}

function threw(pointer: string, what: string, error: unknown): PatchRejection {
  const message = error instanceof Error ? error.message : String(error);
  return reject('MALFORMED_OPERATION', pointer, 'a patch the system can apply and hash', `${what} threw: ${message}`);
}

function commitChecked(doc: WorldDoc, patch: PartPatch): RevisionResult {
  // **Uložená část dřív než patch** — tatáž hranice, jakou drží `patch/apply.ts`.
  // Bez ní by se vada, která ve světě ležela už předtím, vykázala jako nález nad
  // draftem, tedy jako by ji přinesl tenhle patch; volající by ho přeemitoval
  // donekonečna. `sealSimHash` dokument zapečetí bez kontroly, takže `WorldDoc`
  // sem umí přijít i mimo `migrateWorldDoc`.
  const stored = unhashableValues(doc[patch.part], `/${patch.part}`);
  if (stored.length > 0)
    return reject(
      'STRUCTURE',
      stored[0].pointer,
      'a stored part with a JSON form',
      `the ${patch.part} part this patch targets cannot be canonicalized: ${stored[0].detail}`,
    );

  // Tvar OPERACÍ dřív, než je uvidí knihovna — `patch/apply.ts` to dělá ze
  // stejného důvodu a `commitPart` ho při přebírání té struktury vynechal:
  // `readonly Operation[]` platí jen při překladu, patch přichází jako JSON od
  // modelu, a operace bez `path` uvnitř `rfc6902` **vyhodí**. U smíšeného
  // požadavku by ta výjimka přišla až PO commitnutém `look`, takže by volající
  // místo `{look: COMMITTED, sim: REJECTED}` dostal pád a commitnutý dokument by
  // se ztratil — přesně ten kontrakt, který se tu má držet.
  for (let i = 0; i < patch.operations.length; i += 1) {
    const parsed = operationSchema.safeParse(patch.operations[i]);
    if (parsed.success) continue;
    const path = (patch.operations[i] as { path?: unknown } | null)?.path;
    return reject(
      'MALFORMED_OPERATION',
      typeof path === 'string' ? path : '',
      'an RFC 6902 operation with op and path',
      `operation ${i}: ${parsed.error.issues[0].message}`,
    );
  }

  // Hodnoty, které kanonizace zahladí, se odmítají **v operaci**, ne až ve
  // výsledku. `rfc6902` i `zod` si vstup po svém překopírují, takže `Map`, cyklus
  // nebo funkce se za nimi buď promění v něco jiného, nebo shodí celý průchod
  // výjimkou dřív, než se ke kontrole vůbec dojde. Odmítnout patch je navíc
  // přesnější odpověď než odmítnout dokument, který z něj vznikl.
  for (let i = 0; i < patch.operations.length; i += 1) {
    const operation = patch.operations[i] as { value?: unknown };
    if (!('value' in operation)) continue;
    const unusable = unhashableValues(operation.value, `operation ${i} value`);
    if (unusable.length > 0)
      return reject(
        'MALFORMED_OPERATION',
        patch.operations[i].path,
        'a value with a JSON form',
        unusable[0].detail,
      );
  }

  const draft = structuredClone(doc[patch.part]) as unknown;

  // Operace se pouštějí **po jedné**, a každá ve svém `try`.
  //
  // `rfc6902` na některých cílech nevrací chybu, ale **vyhodí**: `add
  // /grid/cell/x`, kde `grid.cell` je číslo, skončí `TypeError: Cannot create
  // property 'x' on number '1'`. Projde přitom kontrolou tvaru i hodnoty, protože
  // vada není v operaci — je ve dvojici operace a dokumentu, a tu nelze vidět
  // dřív než při aplikaci. Patchovat primitivum, jako by to byl objekt, je běžná
  // chyba emise, ne útok.
  //
  // Dávkové `applyPatch` by u toho ztratilo index, takže by odmítnutí nemělo
  // pointer. Po jedné je to totéž pořadí nad tímtéž draftem — knihovna operace
  // stejně aplikuje sekvenčně — jen s tím rozdílem, že se ví, která z nich to
  // byla, a že se u ní dá zastavit.
  for (let i = 0; i < patch.operations.length; i += 1) {
    const operation = patch.operations[i];

    // **Kam operace míří podle RFC 6901**, rozhodnuto vlastním rozborem — teprve
    // co jím projde, uvidí `rfc6902`. Knihovna sama tři klíče přeskakuje a pole
    // indexuje přes `parseInt`, takže by `remove /witness/ops/prototype/0`
    // smazalo `ops[0]` a `add /witness/ops/smuggled` provedlo
    // `splice(NaN → 0, 0, …)`, tedy přečíslovalo operace svědka: konzistentní
    // dokument, sedící hash, jiný svět.
    const fault = pointerFault(draft, operation);
    if (fault !== null)
      return reject(
        'MALFORMED_OPERATION',
        fault.pointer,
        fault.expected,
        `operation ${i} (${operation.op} ${operation.path}): ${fault.reason}`,
      );

    let failure: ReturnType<typeof applyPatch>[number] | undefined;
    try {
      [failure] = applyPatch(draft as object, [operation]);
    } catch (error) {
      return threw(operation.path, `operation ${i} (${operation.op} ${operation.path})`, error);
    }
    if (failure === null || failure === undefined) continue;
    const failedPath = (failure as { path?: unknown }).path;
    return reject(
      'MALFORMED_OPERATION',
      typeof failedPath === 'string' ? failedPath : operation.path,
      `an applicable ${operation.op} target`,
      `operation ${i} (${operation.op} ${operation.path}): ${failure.message}`,
    );
  }

  return sealPart(doc, patch.part, draft);
}

/** Kontroly a zapečetění nad hotovým draftem. Volá se **uvnitř** `try`. */
function sealPart(doc: WorldDoc, part: Part, draft: unknown): RevisionResult {
  // Hodnoty, které kanonizace zahladí, se kontrolují na SYROVÉM draftu — dřív,
  // než ho uvidí zod. Parser si data překopíruje, takže `Map` nebo cyklus by za
  // ním vypadaly jinak, než co do dokumentu doopravdy přišlo; a cyklus by navíc
  // shodil samotné parsování dřív, než by se k němu kontrola dostala.
  const unhashable = unhashableValues(draft, `/${part}`);
  if (unhashable.length > 0)
    return reject('STRUCTURE', `/${part}`, 'values with a JSON form', unhashable[0].detail);

  if (part === 'look') {
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

  // Pravidlo uložené jinde než pod svým `id` je pravidlo, které existuje a přesto
  // se nedá adresovat — odůvodnění je u `ruleKeyFault`. Kontrola stojí až tady,
  // protože se ptá na tvar VÝSLEDKU, ne na tvar operace: `replace` na `id`
  // rozejde klíč s `id` stejně spolehlivě jako `add /rules/-`.
  const keyFault = ruleKeyFault(shape.data);
  if (keyFault !== null)
    return reject('STRUCTURE', keyFault.pointer, 'a rule filed under its own id', keyFault.detail);

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
