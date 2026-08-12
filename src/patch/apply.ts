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
import { z } from 'zod';

import { validateIrDoc, worldIr } from '../ir/schema';
import { hashWords } from '../sim/hash';
import { TIERS } from '../verify/tiers';
import type { VerifiableWorld } from '../verify/witness';
import { reject, rejectionFromZod, structurePointer, type PatchRejection } from './reject';

/**
 * Obálka světa — všechno, co patch umí zasáhnout **mimo** `ir`.
 *
 * `worldIr` popisuje jen graf, takže bez tohohle projde jako platný patch, který
 * smaže `space.sockets` (runtime pak spadne na `TypeError`, ne na definovaný
 * `runtimeFault`), přepíše `space.blocked` na řetězec (certifikát se vydá nad
 * geometrií, která není geometrie), přidá soket a tím udělá z dřív
 * neproveditelného svědka proveditelný, nebo dosadí nesmyslnou `certification`
 * a tím **natrvalo** shodí verifikaci světa, který předtím vyhrával. To je přesně
 * ten stav, kterému má transakčnost bránit — jen dosažený commitem, ne pádem.
 *
 * Kanonický `WorldDoc` staví až T12; tohle je stráž patch cesty, ne jeho definice.
 * Neznámé klíče v kořeni se proto tolerují — `_note` a `winsAtTick` v fixturách
 * jsou přesně ony a nikdo je nečte.
 */
const cell = z.tuple([z.int(), z.int()]);

const worldEnvelope = z
  .object({
    space: z
      .object({
        sockets: z.record(z.string(), cell),
        zones: z.record(z.string(), z.tuple([z.int(), z.int(), z.int(), z.int()])),
        blocked: z.array(cell),
        tags: z.record(z.string(), z.string()),
      })
      .strict(),
    trace: z.array(
      z
        .object({
          tick: z.int().min(0),
          actor: z.string(),
          actionId: z.string(),
          target: z.string().optional(),
        })
        .strict(),
    ),
    certification: z
      .object({ tier: z.enum(TIERS), horizonTicks: z.int().min(1) })
      .strict()
      .optional(),
  })
  .loose();

/**
 * RFC 6902 operace. `readonly Operation[]` je jen typ — patch přichází jako JSON.
 *
 * Cesta musí být **skutečný JSON Pointer**, ne jen řetězec: `"ir/rules/0"` bez
 * úvodního lomítka je nejběžnější chyba v ručně i modelem psaném patchi a
 * `rfc6902` na ní **vyhodí** (`Invalid JSON Pointer`), takže bez tohohle by
 * kontrakt „vadná operace je odmítnutí, ne výjimka" platil jen pro chybějící
 * cestu a ne pro špatně napsanou.
 */
const jsonPointer = z.string().regex(/^(\/[^/]*)*$/, 'must be an RFC 6901 JSON Pointer');

const operationSchema = z.union([
  z.object({ op: z.enum(['add', 'replace', 'test']), path: jsonPointer, value: z.unknown() }).loose(),
  z.object({ op: z.literal('remove'), path: jsonPointer }).loose(),
  z.object({ op: z.enum(['move', 'copy']), path: jsonPointer, from: jsonPointer }).loose(),
]);

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

  // Tvar OPERACÍ dřív, než je uvidí knihovna. `readonly Operation[]` platí jen
  // při překladu, patch přichází jako JSON od modelu — a operace bez `path`
  // uvnitř `rfc6902` **vyhodí**, místo aby se vrátila jako odmítnutí.
  for (let i = 0; i < operations.length; i += 1) {
    const parsed = operationSchema.safeParse(operations[i]);
    if (parsed.success) continue;
    const path = (operations[i] as { path?: unknown }).path;
    return reject(
      'MALFORMED_OPERATION',
      // Prázdný pointer je kořen a znamená „nelze zaměřit" — operace, která
      // nemá použitelnou cestu, žádné místo v dokumentu neoznačuje.
      typeof path === 'string' ? path : '',
      'an RFC 6902 operation with op and path',
      `operation ${i}: ${parsed.error.issues[0].message}`,
    );
  }

  // Hluboká kopie: vstup se nesmí dotknout ani při úspěchu, aby volající mohl
  // starý graf pořád replaynout.
  const draft = structuredClone(doc) as VerifiableWorld;

  const outcomes = applyPatch(draft as unknown as object, [...operations]);
  for (let i = 0; i < outcomes.length; i += 1) {
    const failure = outcomes[i];
    if (failure === null) continue;
    const operation = operations[i];
    // `MissingError` z `rfc6902` nese **přesnou** cestu, na které to selhalo —
    // u `move`/`copy` je to typicky `from`, ne `path`. Hádat ji porovnáváním
    // řetězců je horší než nehádat: `/ir/nodes/1` je podřetězcem `/ir/nodes/12`,
    // takže by index 1 přebil skutečně rozbitý index 12.
    const failedPath = (failure as { path?: unknown }).path;
    const pointer = typeof failedPath === 'string' ? failedPath : operation.path;
    return reject(
      'MALFORMED_OPERATION',
      pointer,
      // `test` neselhal na tvaru cíle, ale na jeho hodnotě — a očekávání je pak
      // ta hodnota, ne „použitelný cíl".
      operation.op === 'test'
        ? `the value ${JSON.stringify((operation as { value?: unknown }).value)}`
        : `an applicable ${operation.op} target`,
      `operation ${i} (${operation.op} ${operation.path}): ${failure.message}`,
    );
  }

  const envelope = worldEnvelope.safeParse(draft);
  if (!envelope.success) return rejectionFromZod(envelope.error, []);

  const shape = worldIr.safeParse(draft.ir);
  if (!shape.success) return rejectionFromZod(shape.error, ['ir']);

  const structure = validateIrDoc(draft.ir);
  if (!structure.ok) {
    const issue = structure.issues[0];
    return reject('STRUCTURE', structurePointer(issue), 'a resolvable reference', issue);
  }

  const layout = layoutFits(draft);
  if (layout !== null) return layout;

  return { verdict: 'COMMITTED', doc: draft, hashBefore, hashAfter: graphHash(draft) };
}

/**
 * Sedí layout do mřížky, kterou deklaruje graf?
 *
 * Tuhle otázku **nemá kdo jiný položit**: `worldIr` vidí jen `ir`, obálka vidí
 * `space` bez `limits`, a `validateIrDoc` `space` nevidí vůbec. Mezi nimi propadne
 * soket mimo mřížku i zmenšená mřížka pod stávajícím soketem — obojí je běžná
 * živá editace a obojí commitne dokument, na kterém `createRuntime` **vyhodí
 * výjimku** (`slot e:hero:x has an initial value outside its bounds`). Výjimka
 * není definovaný přechod, takže takový svět nejde ani replaynout, ani nahlásit
 * jako `runtimeFault` — a certifikát nad ním by neměl co znamenat.
 *
 * Meze jsou úmyslně tytéž, jaké dosazuje `createRuntime` do slotů entit:
 * `0 … gridWidth` včetně. Kdyby se rozešly, kontrola by hlídala jiný svět než
 * ten, který se pak staví.
 */
function layoutFits(draft: VerifiableWorld): PatchRejection | null {
  const { gridWidth, gridHeight } = draft.ir.limits;
  for (const [name, cell] of Object.entries(draft.space.sockets)) {
    if (cell[0] >= 0 && cell[0] <= gridWidth && cell[1] >= 0 && cell[1] <= gridHeight) continue;
    return reject(
      'STRUCTURE',
      `/space/sockets/${name}`,
      `a cell inside 0..${gridWidth} x 0..${gridHeight}`,
      `socket ${name} at [${cell[0]}, ${cell[1]}] lies outside the declared grid`,
    );
  }
  return null;
}
