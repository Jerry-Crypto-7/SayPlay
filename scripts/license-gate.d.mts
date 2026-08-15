/**
 * Typy k `license-gate.mjs`. Skript musí jít spustit holým Nodem bez build
 * kroku, takže je to `.mjs`; testy jsou TypeScript a potřebují jeho kontrakt
 * zapsaný.
 */

export declare const KINDS: string[];
export declare const REQUIRED_FIELDS: string[];
export declare const ALLOWED: Set<string>;
export declare const ALLOWED_WITH_NOTE: Set<string>;

export declare interface DisclosureEntry {
  readonly name: string;
  readonly kind: string;
  readonly source: string;
  readonly authorOrProvider: string;
  readonly license: string;
  readonly requiredNotices: readonly string[];
  readonly attribution: string;
  readonly reviewNote?: string;
  readonly scope?: string;
}

/** Odstraní řádkové i blokové komentáře, obsah řetězců nechá být. */
export declare function stripComments(source: string): string;

/** Hostitelé z URL v kódu, bez loopbacku a jmen vyhrazených pro dokumentaci. */
export declare function hostsIn(source: string): Set<string>;

/** Povinné notices pro licenci, včetně složených výrazů `A AND B`. */
export declare function noticesFor(license: string): string[];

/** Vykreslí `DISCLOSURE.md` z položek registru. */
export declare function renderDisclosure(entries: readonly DisclosureEntry[]): string;

/** Návratový kód brány: 0 když prošly všechny kontroly. */
export declare function main(argv: readonly string[]): number;
