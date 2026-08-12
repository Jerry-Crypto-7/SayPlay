/**
 * Transakční aplikace patche — **commit, nebo nic**.
 *
 * Živá editace je podle `DESIGN-BOOK.md` patch běžícího grafu bez resetu, což
 * znamená, že odmítnutý patch nesmí po sobě nechat ani bajt. Kdyby zůstal
 * poloviční, svět by se dostal do stavu, který nikdo nenapsal: svědek přijatý
 * s původním grafem by přestal platit a certifikát by lhal.
 *
 * Zaručuje se to tím, že se **nikdy nesahá na vstup**. Operace se pouštějí na
 * hlubokou kopii a původní dokument se vrací jen tehdy, když kopie projde
 * tvarem i vazbami. Není to optimalizovatelné „aplikuj a při chybě vrať zpátky" —
 * rollback je kód, který se dá splést, kdežto tohle je vlastnost konstrukce.
 *
 * `rfc6902`, ne `fast-json-patch` a ne immer patche: `CLAUDE.md` to má mezi
 * pastmi, protože **immer patche nejsou RFC 6902** a tvářily by se kompatibilně,
 * dokud by na nich nestál protokol.
 */

import { applyPatch, type Operation } from 'rfc6902';

import { validateIrDoc, worldIr } from '../ir/schema';
import { hashWords } from '../sim/hash';
import type { VerifiableWorld } from '../verify/witness';
import { reject, rejectionFromZod, structurePointer, type PatchRejection } from './reject';

export interface PatchCommit {
  readonly verdict: 'COMMITTED';
  /** Nový dokument. Vstupní zůstal nedotčený. */
  readonly doc: VerifiableWorld;
  readonly hashBefore: string;
  readonly hashAfter: string;
}

export type PatchResult = PatchCommit | PatchRejection;

/**
 * Kanonická serializace: klíče objektů **seřazené**, žádné mezery.
 *
 * Bez toho by hash závisel na pořadí, ve kterém klíče vznikly, takže dokument
 * s týmž obsahem by měl dva různé hashe podle toho, kudy se do paměti dostal.
 * Pole si pořadí drží — u nich je pořadí součástí obsahu.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/**
 * Hash grafu. Je to hash **dokumentu**, ne počátečního stavu.
 *
 * Rozdíl je podstatný: patch, který přidá pravidlo, počáteční stav nezmění, ale
 * graf ano — a právě o změně grafu se tu rozhoduje. Stavový hash z `hash.ts` je
 * pozorování běhu, tenhle je identita zadání. Sdílejí FNV-1a schválně, aby se
 * neudržovaly dva různé hashovací kódy.
 */
export function graphHash(doc: unknown): string {
  const text = canonical(doc);
  const words = new Uint32Array(text.length);
  for (let i = 0; i < text.length; i += 1) words[i] = text.charCodeAt(i);
  return hashWords(words).toString(16).padStart(8, '0');
}

/**
 * Aplikuje patch transakčně.
 *
 * Pořadí kontrol je součást kontraktu: nejdřív se operace vůbec musí dát
 * provést, pak musí výsledek projít **tvarem** (`worldIr`), a teprve pak
 * **vazbami** (`validateIrDoc`). Tvar před vazbami proto, že zod umí ukázat
 * přesnou cestu a očekávaný typ, kdežto vazby mluví v doménových pojmech —
 * zamíchat je znamená vracet horší pointer, než jaký byl k mání.
 */
export function applyWorldPatch(doc: VerifiableWorld, operations: readonly Operation[]): PatchResult {
  const hashBefore = graphHash(doc);
  // Hluboká kopie: vstup se nesmí dotknout ani při úspěchu, aby volající mohl
  // starý graf pořád replaynout.
  const draft = structuredClone(doc) as VerifiableWorld;

  const outcomes = applyPatch(draft as unknown as object, [...operations]);
  for (let i = 0; i < outcomes.length; i += 1) {
    const failure = outcomes[i];
    if (failure === null) continue;
    return reject(
      'MALFORMED_OPERATION',
      operations[i].path,
      `an applicable ${operations[i].op} target`,
      `operation ${i} (${operations[i].op} ${operations[i].path}): ${failure.message}`,
    );
  }

  const shape = worldIr.safeParse(draft.ir);
  if (!shape.success) return rejectionFromZod(shape.error, ['ir']);

  const structure = validateIrDoc(draft.ir);
  if (!structure.ok) {
    const issue = structure.issues[0];
    return reject('STRUCTURE', structurePointer(issue), 'a resolvable reference', issue);
  }

  return { verdict: 'COMMITTED', doc: draft, hashBefore, hashAfter: graphHash(draft) };
}
