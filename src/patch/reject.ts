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
 * Rodič a klíč **přesně tak, jak je vidí `rfc6902`** — je to věrný port jeho
 * `Pointer.evaluate`, ne vlastní rozbor cesty.
 *
 * Ta věrnost je celý point. Knihovna totiž `__proto__`, `constructor` a
 * `prototype` v cestě **přeskočí** (`pointer.js`: `continue`), takže jí `parent`
 * zůstane na hodnotě O ÚROVEŇ VÝŠ. Vlastní rozbor, který do těch klíčů naopak
 * sestoupí, uvidí něco jiného než knihovna — a rozdíl mezi tím, co vidí kontrola,
 * a tím, co udělá aplikace, je přesně ta skulina, kterou se dá kontrola obejít:
 * `/ir/rules/constructor/smuggled` vypadá jako zápis do `Array` funkce, ale
 * knihovna ho provede jako zápis do **pole** `rules`.
 */
function evaluate(doc: unknown, pointer: string): { parent: unknown; key: string } {
  let parent: unknown = null;
  let key = '';
  let value: unknown = doc;
  for (const token of tokensOf(pointer)) {
    parent = value;
    key = token;
    if (token === '__proto__' || token === 'constructor' || token === 'prototype') continue;
    // `(parent || {})[key]` v originále — u falsy rodiče tedy `undefined`.
    value = parent ? (parent as Record<string, unknown>)[token] : undefined;
  }
  return { parent, key };
}

export interface BadArrayTarget {
  /** Cesta, která to způsobila — `path`, nebo `from` u `move`/`copy`. */
  readonly pointer: string;
  readonly token: string;
}

/**
 * Míří operace do POLE tokenem, který není index?
 *
 * `rfc6902` tohle nehlídá a **tiše uhne**, obojím směrem:
 * - `_add` dělá `splice(parseInt(key,10), 0, v)`, takže nečíselný token dá
 *   `splice(NaN, …)` a hodnota přistane na **indexu 0** — `add /rules/smuggled`
 *   nevloží nic pojmenovaného, vloží pravidlo na začátek a přečísluje ostatní.
 * - `_remove` dělá `splice(parseInt(key,10), 1)`, takže `move` s `from`
 *   `/rules/length` **smaže nulté pravidlo**.
 *
 * Výsledek je v obou případech dokonale konzistentní dokument se sedícím hashem,
 * takže ho žádná pozdější kontrola nepozná — jenom to není ten svět, o který si
 * patch řekl. U `/rules` jde navíc o pořadí vyhodnocení, na kterém stojí
 * `priority`, `phase` i „ambiguous execution order" z `validateIrDoc`.
 *
 * Kontrolují se **obě** cesty operace. `from` je u `move` mazání a u `copy` čtení,
 * takže `-` („za poslední prvek") tam nedává smysl ani u jednoho — RFC 6902 §4 ho
 * povoluje jen tam, kde se přidává.
 */
export function badArrayTarget(draft: unknown, operation: Operation): BadArrayTarget | null {
  const targets: { pointer: string; allowDash: boolean }[] = [
    { pointer: operation.path, allowDash: operation.op === 'add' },
  ];
  if (operation.op === 'move' || operation.op === 'copy')
    targets.push({ pointer: operation.from, allowDash: false });

  for (const target of targets) {
    if (target.pointer === '') continue;
    const { parent, key } = evaluate(draft, target.pointer);
    if (!Array.isArray(parent)) continue;
    if (ARRAY_INDEX.test(key)) continue;
    if (key === '-' && target.allowDash) continue;
    return { pointer: target.pointer, token: key };
  }
  return null;
}

export const operationSchema = z.union([
  z.object({ op: z.enum(['add', 'replace', 'test']), path: jsonPointer, value: z.unknown() }).loose(),
  z.object({ op: z.literal('remove'), path: jsonPointer }).loose(),
  z.object({ op: z.enum(['move', 'copy']), path: jsonPointer, from: jsonPointer }).loose(),
]);
