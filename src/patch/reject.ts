/**
 * Odmítnutí patche — **s přesným místem, ne s tím, že se to nepovedlo**.
 *
 * Autorský nástroj i model dostávají tenhle objekt jako jedinou zpětnou vazbu,
 * takže „patch je neplatný" je bezcenná odpověď: nejde z ní opravit ani dohledat,
 * co se čekalo. Odmítnutí proto vždy nese **JSON Pointer podle RFC 6901** na to
 * konkrétní místo a **očekávaný tvar** toho místa.
 *
 * Pointer se skládá ze stejné cesty, jakou nese samotná operace patche, takže
 * odpověď mluví v souřadnicích dotazu — ne v souřadnicích vnitřní reprezentace.
 */

import type { Operation } from 'rfc6902';
import { z, type ZodError } from 'zod';

export type RejectReason =
  /** Operace se na dokument nedala provést (chybějící rodič, index mimo pole). */
  | 'MALFORMED_OPERATION'
  /** Výsledek neprošel tvarem — `worldIr`. */
  | 'SCHEMA'
  /** Tvar sedí, ale vazby ne: osiřelé indexy, duplicity, nesouhlasné typy. */
  | 'STRUCTURE';

export interface PatchRejection {
  readonly verdict: 'REJECTED';
  readonly reason: RejectReason;
  /** RFC 6901 pointer na místo, které to zlomilo. */
  readonly pointer: string;
  /** Co se na tom místě čekalo. Prázdné nikdy — od toho je celé odmítnutí. */
  readonly expected: string;
  readonly detail: string;
}

/** Escapování podle RFC 6901: `~` je `~0`, `/` je `~1`. V tomhle pořadí. */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function pointerOf(path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return '';
  return path.map((token) => `/${escapeToken(String(token))}`).join('');
}

export function reject(
  reason: RejectReason,
  pointer: string,
  expected: string,
  detail: string,
): PatchRejection {
  return { verdict: 'REJECTED', reason, pointer, expected, detail };
}

/**
 * Odmítnutí ze zod chyby.
 *
 * Bere **první** nález, ne všechny: patch se aplikuje transakčně, takže první
 * důvod, proč se necommitne, je celá odpověď. Vypisovat jich dvacet by svádělo
 * k opravování symptomů odspodu.
 *
 * `prefix` je cesta, na které dokument nese to, co se validovalo — bez ní by
 * pointer mířil do `ir` dokumentu místo do dokumentu samotného, tedy do jiných
 * souřadnic, než ve kterých přišel patch.
 */
export function rejectionFromZod(error: ZodError, prefix: readonly string[]): PatchRejection {
  const issue = error.issues[0];

  // Neznámý klíč zná své jméno, takže pointer smí mířit PŘÍMO na něj místo na
  // objekt, který ho nese — a očekávání je tvar, ne kód chyby.
  if (issue.code === 'unrecognized_keys') {
    const key = issue.keys[0];
    return reject(
      'SCHEMA',
      pointerOf([...prefix, ...issue.path, key]),
      'no property here — this object declares its full shape',
      issue.message,
    );
  }

  const pointer = pointerOf([...prefix, ...issue.path]);
  return reject('SCHEMA', pointer, expectedOf(issue), issue.message);
}

/**
 * Co se na tom místě čekalo, **v pojmech tvaru**.
 *
 * Vracet `issue.code` je levné a k ničemu: `invalid_union` neříká autorovi ani
 * modelu nic o tom, co tam mělo být. Kódy se proto překládají na popis tvaru
 * a `expected` z toho nikdy nevyjde prázdné.
 */
function expectedOf(issue: ZodError['issues'][number]): string {
  if ('expected' in issue && typeof issue.expected === 'string') return issue.expected;
  switch (issue.code) {
    case 'invalid_union':
      return 'one of the declared variants';
    case 'invalid_value':
      return 'values' in issue ? `one of ${issue.values.map((v) => String(v)).join(', ')}` : 'a declared value';
    case 'too_big':
      return 'maximum' in issue ? `at most ${String(issue.maximum)}` : 'a smaller value';
    case 'too_small':
      return 'minimum' in issue ? `at least ${String(issue.minimum)}` : 'a larger value';
    case 'invalid_format':
      return 'format' in issue ? `a value matching ${String(issue.format)}` : 'a valid format';
    default:
      return issue.code;
  }
}

/**
 * Pointer pro strukturální nález.
 *
 * `validateIrDoc` mluví v doménových pojmech (`node 3`, `rule r.open`), protože
 * to je čitelnější v testech i v logu. Tady se to překládá zpátky na souřadnice
 * dokumentu — bez toho by strukturální odmítnutí bylo o řád méně přesné než
 * schématické a autorský nástroj by na něj neuměl skočit.
 *
 * Kolekce indexované číslem se trefí přesně; ty adresované jménem (`rule
 * r.open`) se trefí na kolekci, protože pořadí v poli není součástí identity.
 */
const STRUCTURE_POINTERS: readonly (readonly [RegExp, string])[] = [
  [/^node (\d+)/, '/ir/nodes'],
  [/^effect (\d+)/, '/ir/effects'],
  [/^predicate /, '/ir/predicates'],
  [/^rule /, '/ir/rules'],
  [/^duplicate slot id|^duplicate memory slot|^slot |^counter |^timer |^memory slot /, '/ir/slots'],
  [/^duplicate stableId|^entity /, '/ir/entities'],
  [/^entity count|^slot count|^rule count|^distinct memory agents/, '/ir/limits'],
  [/^ambiguous execution order/, '/ir/rules'],
];

export function structurePointer(issue: string): string {
  for (const [pattern, base] of STRUCTURE_POINTERS) {
    const hit = pattern.exec(issue);
    if (hit === null) continue;
    return hit[1] === undefined ? base : `${base}/${hit[1]}`;
  }
  return '/ir';
}

/**
 * RFC 6902 operace. `readonly Operation[]` je jen typ — patch přichází jako JSON.
 *
 * Cesta musí být **skutečný JSON Pointer**, ne jen řetězec: `"ir/rules/0"` bez
 * úvodního lomítka je nejběžnější chyba v ručně i modelem psaném patchi a
 * `rfc6902` na ní **vyhodí** (`Invalid JSON Pointer`), takže bez tohohle by
 * kontrakt „vadná operace je odmítnutí, ne výjimka" platil jen pro chybějící
 * cestu a ne pro špatně napsanou.
 */
export const jsonPointer = z.string().regex(/^(\/[^/]*)*$/, 'must be an RFC 6901 JSON Pointer');

/** Rozebrání RFC 6901 pointeru na tokeny. `~1` je `/`, `~0` je `~`. V tomhle pořadí. */
function tokensOf(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Tokeny, které `rfc6902` **přeskakuje** — a proto se tu nesmí objevit vůbec.
 *
 * `Pointer.evaluate` na nich dělá `continue`, takže mu `parent` zůstane o úroveň
 * výš a operace zapíše **jinam, než kam ukazuje**. `remove /ir/rules/prototype/0`
 * tedy nesahá na `rules.prototype`, ale smaže `rules[0]`.
 *
 * Podle RFC 6901 přitom `prototype` je obyčejné jméno členu a `/ir/rules/prototype/0`
 * neadresuje `rules[0]` ani náhodou. Ta neshoda je celý důvod, proč tenhle seznam
 * existuje: kontrolu **nelze** postavit na tom, co udělá knihovna, protože pak
 * schválí všechno, co knihovna udělá. Staví se na tom, co cesta znamená — a když
 * se to od knihovny liší, je to důvod odmítnout, ne se srovnat.
 *
 * Nic legitimního tím nepadne: ve zmrazeném korpusu ani v jedné fixtuře se ty tři
 * řetězce nevyskytují jako klíč ani jednou.
 */
const UNSAFE_TOKENS = new Set(['__proto__', 'constructor', 'prototype']);

export interface PointerFault {
  /** Cesta, která to způsobila — `path`, nebo `from` u `move`/`copy`. */
  readonly pointer: string;
  /** Co se na tom místě čekalo, v pojmech tvaru. Jde rovnou do `expected`. */
  readonly expected: string;
  readonly reason: string;
}

/**
 * Kam operace míří **podle RFC 6901** — nebo proč nikam.
 *
 * Tohle je vlastní, striktní rozbor cesty; `rfc6902` se pak pouští jen na operaci,
 * která jím prošla. Obrácené pořadí (zeptat se knihovny a přizpůsobit se jí) je
 * to, co devět kol brány nezavřelo: knihovna má vlastní představu o tom, co cesta
 * adresuje — přeskakuje tři klíče, pole indexuje přes `parseInt` — a kontrola
 * srovnaná s ní ty představy zdědí i s jejich vadami.
 *
 * `mode` říká, jestli cíl smí teprve vzniknout (`insert` — `add` a cíl `move`
 * i `copy`, tedy místa, kde RFC 6902 §4 povoluje `-` a index rovný délce), nebo
 * jestli už musí existovat (`existing` — `replace`, `remove`, `test` a zdroj
 * `move` i `copy`).
 */
function resolve(pointer: string, doc: unknown, mode: 'insert' | 'existing'): PointerFault | null {
  const tokens = tokensOf(pointer);
  if (tokens.length === 0)
    return {
      pointer,
      expected: 'a pointer to something inside the document',
      reason: 'the document root is not a patch target — a patch edits a graph, it does not swap it',
    };

  let node: unknown = doc;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const last = i === tokens.length - 1;

    if (UNSAFE_TOKENS.has(token))
      return {
        pointer,
        expected: 'an ordinary member name',
        reason: `"${token}" is not addressable — rfc6902 skips it and would mutate the parent instead`,
      };

    if (Array.isArray(node)) {
      // `-` a index rovný délce znamenají „za poslední prvek" a dávají smysl jen
      // na konci cesty a jen tam, kde se přidává.
      const appendable = last && mode === 'insert';
      const expected = appendable ? 'an array index or "-"' : 'an array index';
      if (token === '-') {
        if (appendable) return null;
        return { pointer, expected, reason: '"-" names the position after the last element, which only exists when adding' };
      }
      if (!ARRAY_INDEX.test(token))
        return { pointer, expected, reason: `"${token}" is not an index of the array it targets` };

      const limit = appendable ? node.length : node.length - 1;
      if (Number(token) > limit)
        return {
          pointer,
          expected: `an index at most ${limit}`,
          reason: `index ${token} is out of range for an array of length ${node.length}`,
        };
      if (last) return null;
      node = node[Number(token)];
      continue;
    }

    if (node === null || typeof node !== 'object')
      return {
        pointer,
        expected: 'an object or array to descend into',
        reason: `"${token}" has no container to live in — the path runs through a primitive`,
      };

    // Poslední token na objektu smí teprve vzniknout (`add`), a když nesmí,
    // ohlásí to knihovna přesnou `MissingError` — dublovat ji tady by znamenalo
    // dvě pravidla o téže věci.
    if (last) return null;
    if (!Object.hasOwn(node, token))
      return {
        pointer,
        expected: 'an existing member',
        reason: `"${token}" does not exist, so the path has no parent to write into`,
      };
    node = (node as Record<string, unknown>)[token];
  }
  return null;
}

/**
 * Obě cesty operace, každá ve svém režimu.
 *
 * `move` i `copy` jsou podle RFC 6902 §4.4/§4.5 **čtení/odebrání na `from` plus
 * `add` na `path`**, takže `-` je na jejich `path` legální (knihovna ho řeší
 * `push`) a na `from` ne. Natvrdo svázat `-` s `op === 'add'` znamená odmítnout
 * „zduplikuj tohle pravidlo na konec", což je nejběžnější živá editace, jaká je.
 */
export function pointerFault(draft: unknown, operation: Operation): PointerFault | null {
  const inserts = operation.op === 'add' || operation.op === 'move' || operation.op === 'copy';
  const onPath = resolve(operation.path, draft, inserts ? 'insert' : 'existing');
  if (onPath !== null) return onPath;
  if (operation.op !== 'move' && operation.op !== 'copy') return null;
  const onFrom = resolve(operation.from, draft, 'existing');
  if (onFrom !== null) return onFrom;
  // `copy` nic neodebírá, takže žádné indexy neposouvá.
  return operation.op === 'move' ? movedTwice(draft, operation.from, operation.path) : null;
}

function nodeAt(doc: unknown, tokens: readonly string[]): unknown {
  let node: unknown = doc;
  for (const token of tokens) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

/**
 * `move` je jediná operace, kde se dokument **mezi svými dvěma cestami změní**.
 *
 * RFC 6902 §4.4 ho definuje jako *odeber na `from`, pak přidej na `path`* — takže
 * `path` se čte na dokumentu **po** odebrání. `rfc6902` ale vyhodnotí `path`
 * dopředu (`Pointer.evaluate` před `_remove`) a drží si živý odkaz na rodiče.
 *
 * Pro **poslední** token to vyjde nastejno: rodič je odkaz na to pole a klíč se
 * použije až po odebrání, takže `move /arr/0 → /arr/1` udělá přesně to, co RFC
 * říká. Jakmile ale `path` pokračuje **za** ten index, knihovna sestoupila do
 * prvku, který na té pozici byl PŘED odebráním — `move /arr/0 → /arr/2/fresh`
 * zapíše do původního `arr[2]`, zatímco RFC mluví o `arr[3]`. Ověřeno spuštěním.
 *
 * Tohle se nedá „spočítat správně": aplikátor je `rfc6902` a ten to udělá po
 * svém. Jediná poctivá odpověď je operaci odmítnout — je nejednoznačná mezi dvěma
 * čteními a tiše vybrat to knihovní je přesně ta vada, kterou celá tahle cesta
 * řeší. Kdo to potřebuje, napíše `remove` + `add`, což význam nezamlčuje.
 */
function movedTwice(draft: unknown, from: string, path: string): PointerFault | null {
  const fromTokens = tokensOf(from);
  const pathTokens = tokensOf(path);

  // RFC 6902 §4.4 doslova: „The `from` location MUST NOT be a proper prefix of
  // the `path` location." Přesouvat hodnotu do sebe sama nemá výsledek.
  if (pathTokens.length > fromTokens.length && fromTokens.every((token, i) => token === pathTokens[i]))
    return {
      pointer: path,
      expected: 'a target outside the value being moved',
      reason: `RFC 6902 §4.4 forbids moving a value into itself — "${from}" is a prefix of "${path}"`,
    };

  // Indexy posouvá jen odebrání z POLE.
  const parentTokens = fromTokens.slice(0, -1);
  const parent = nodeAt(draft, parentTokens);
  if (!Array.isArray(parent)) return null;

  // Míří `path` do téhož pole?
  if (pathTokens.length <= parentTokens.length) return null;
  for (let i = 0; i < parentTokens.length; i += 1) if (pathTokens[i] !== parentTokens[i]) return null;

  const token = pathTokens[parentTokens.length];
  if (token === '-') return null; // konec je konec i po odebrání
  const index = Number(token);
  const removed = Number(fromTokens[fromTokens.length - 1]);

  if (pathTokens.length > parentTokens.length + 1) {
    if (index < removed) return null; // prvek před odebraným se neposune
    return {
      pointer: path,
      expected: `an index below ${removed}, or a target outside ${`/${parentTokens.join('/')}`}`,
      reason: `after the move removes index ${removed}, "${token}" names a different element than it does now — rfc6902 would write into the one it names now`,
    };
  }

  // Index je poslední token, takže se použije až po odebrání — ale mez je pak
  // délka BEZ odebraného prvku. `rfc6902` na to nehlídá a mlčky připojí na konec.
  const limit = parent.length - 1;
  if (index > limit)
    return {
      pointer: path,
      expected: `an index at most ${limit}`,
      reason: `index ${token} is out of range for the array of length ${limit} that remains once the move removes "${from}"`,
    };
  return null;
}

export const operationSchema = z.union([
  z.object({ op: z.enum(['add', 'replace', 'test']), path: jsonPointer, value: z.unknown() }).loose(),
  z.object({ op: z.literal('remove'), path: jsonPointer }).loose(),
  z.object({ op: z.enum(['move', 'copy']), path: jsonPointer, from: jsonPointer }).loose(),
]);
