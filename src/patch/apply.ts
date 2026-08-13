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
import { unhashableValues } from '../ir/worlddoc';
import { hashWords } from '../sim/hash';
import { TIERS } from '../verify/tiers';
import type { VerifiableWorld } from '../verify/witness';
import {
  badArrayTarget,
  operationSchema,
  reject,
  rejectionFromZod,
  structurePointer,
  type PatchRejection,
} from './reject';

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
  // **Jeden záchyt kolem celého zbytku** — tentýž kontrakt jako `ir/revision.ts`:
  // patch cesta nikdy nevyhodí, volající vždycky dostane verdikt. Zavírat výjimky
  // po jedné znamená zavřít tu, kterou zrovna někdo našel.
  try {
    return applyChecked(doc, operations);
  } catch (error) {
    return threw('', 'applying the patch', error);
  }
}

function threw(pointer: string, what: string, error: unknown): PatchRejection {
  const message = error instanceof Error ? error.message : String(error);
  return reject('MALFORMED_OPERATION', pointer, 'a patch the system can apply and hash', `${what} threw: ${message}`);
}

function applyChecked(doc: VerifiableWorld, operations: readonly Operation[]): PatchResult {
  // **Nejdřív vstupní dokument, a odděleně od patche.**
  //
  // `graphHash(doc)` je první výpočet v celé funkci, dřív než vůbec existuje
  // nějaká operace — takže svět, který sám o sobě nejde kanonizovat (hloubka,
  // `undefined` v nepovinném poli, prototyp), by shodil hashování a odpověď by
  // vinila patch. Prázdný seznam operací hlášený jako `MALFORMED_OPERATION` je
  // nesmysl, na který se navíc nedá reagovat: volající by patch přeemitoval
  // donekonečna, zatímco vada je v uloženém světě.
  //
  // Odděleně to musí být i proto, že po téhle kontrole je vstup čistý — takže
  // nález v draftu níž je nutně **to, co přinesl patch**, a ne něco, co ve světě
  // leželo předtím.
  const inputIssues = unhashableValues(doc, '');
  if (inputIssues.length > 0)
    return reject(
      'STRUCTURE',
      inputIssues[0].pointer,
      'a target document with a JSON form',
      `the world this patch targets cannot be canonicalized: ${inputIssues[0].detail}`,
    );

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

  // Hodnoty operací **před** aplikací, a tahle kontrola není zdvojení té níž.
  //
  // `rfc6902` si `value` při vkládání kopíruje (`util.js` `clone`), a ta kopie
  // přestavuje každý objekt mimo pole a `Date` na **prostý `{}`** přes `for…in`.
  // `Map` i `Set` tedy do draftu dorazí už zploštěné na `{}` — kontrola nad
  // draftem je od `{}` nerozezná a dva sémanticky různé dokumenty by dostaly
  // jeden `graphHash`. Vidět je lze **jen tady**, dokud jsou ještě v operaci.
  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i] as { value?: unknown };
    if (!('value' in operation)) continue;
    const unusable = unhashableValues(operation.value, `operation ${i} value`);
    if (unusable.length > 0)
      return reject('MALFORMED_OPERATION', operations[i].path, 'a value with a JSON form', unusable[0].detail);
  }

  // Hluboká kopie: vstup se nesmí dotknout ani při úspěchu, aby volající mohl
  // starý graf pořád replaynout.
  const draft = structuredClone(doc) as VerifiableWorld;

  // Po jedné a každá ve svém `try` — `ir/revision.ts` to dělá ze stejného důvodu:
  // `add /ir/limits/gridWidth/x` na čísle uvnitř `rfc6902` **vyhodí**, takže by
  // volající místo odmítnutí dostal pád. Dávkové volání by u toho navíc ztratilo
  // index, tedy i pointer.
  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i];

    // `rfc6902` u pole nehlídá tvar tokenu a tiše uhne na index 0 (`add`) nebo
    // smaže nultý prvek (`move` přes `from`) — viz `badArrayTarget`.
    // `add /ir/rules/smuggled` by jinak přečísloval pravidla a vrátil
    // `COMMITTED`: konzistentní dokument, sedící hash, jiný svět.
    const bad = badArrayTarget(draft, operation);
    if (bad !== null)
      return reject(
        'MALFORMED_OPERATION',
        bad.pointer,
        operation.op === 'add' && bad.pointer === operation.path ? 'an array index or "-"' : 'an array index',
        `operation ${i} (${operation.op} ${operation.path}): "${bad.token}" is not an index of the array it targets`,
      );

    let failure: ReturnType<typeof applyPatch>[number] | undefined;
    try {
      [failure] = applyPatch(draft as unknown as object, [operation]);
    } catch (error) {
      return threw(operation.path, `operation ${i} (${operation.op} ${operation.path})`, error);
    }
    if (failure === null || failure === undefined) continue;
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

  // A teď hotový draft, na SYROVO — dřív, než ho uvidí zod.
  //
  // Kontrola nad operacemi tohle nezastane: **`__proto__` je v CESTĚ, ne
  // v hodnotě**. `add /space/sockets/__proto__` klíč nepřidá, ale přepíše
  // prototyp — `Object.entries` ho nevidí, takže `worldEnvelope`, `layoutFits`
  // i `graphHash` projdou beze změny a patch se commitne s `hashBefore ===
  // hashAfter`, zatímco runtime přes `sockets[name]` vidí soket navíc, který
  // certifikát nepokrývá a kontrola mřížky neviděla.
  //
  // Vstup je v tuhle chvíli už ověřený, takže cokoli se najde tady přinesl patch.
  const unhashable = unhashableValues(draft, '');
  if (unhashable.length > 0)
    return reject('STRUCTURE', unhashable[0].pointer, 'values with a JSON form', unhashable[0].detail);

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
