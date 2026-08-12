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

import type { ZodError } from 'zod';

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
  const pointer = pointerOf([...prefix, ...issue.path]);
  const expected = 'expected' in issue ? String(issue.expected) : issue.code;
  return reject('SCHEMA', pointer, expected, issue.message);
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
  [/^duplicate slot id|^slot |^counter |^timer |^memory slot /, '/ir/slots'],
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
