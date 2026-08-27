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
  /**
   * Pole třetí strany jsou nepovinná, protože **první strana je nemá od koho
   * vzít**: vlastní testovací fixtura nemá upstream, licenci ani autora. Brána
   * to nepromíjí — `license-gate` kontrola 1 žádá u `firstParty: true` místo
   * nich `reason` a u všeho ostatního celou sedmičku dál.
   */
  readonly source?: string;
  readonly authorOrProvider?: string;
  readonly license?: string;
  readonly requiredNotices?: readonly string[];
  readonly attribution?: string;
  readonly reviewNote?: string;
  readonly scope?: string;
  /** Není to třetí strana: vlastní data, vlastní kód, vymyšlený identifikátor. */
  readonly firstParty?: boolean;
  /** Proč to není třetí strana. Povinné právě tehdy, když `firstParty` platí. */
  readonly reason?: string;
}

/** Odstraní řádkové i blokové komentáře, obsah řetězců nechá být. */
export declare function stripComments(source: string): string;

/**
 * Hostitelé z URL v kódu, bez loopbacku a jmen vyhrazených pro dokumentaci.
 * Host se bere z rozparsované URL, takže userinfo před `@` skutečný cíl neskryje.
 */
export declare function hostsIn(source: string): Set<string>;

/** URL nesoucí userinfo, s vymazaným údajem. Nález sám o sobě, bez ohledu na host. */
export declare function credentialUrlsIn(source: string): Set<string>;

/** Identifikátory modelů jmenované v kódu, lexikálně podle tvaru jména. */
export declare function modelIdsIn(source: string): Set<string>;

/** Povinné notices pro licenci, včetně složených výrazů `A AND B`. */
export declare function noticesFor(license: string): string[];

/** Vykreslí `DISCLOSURE.md` z položek registru. */
export declare function renderDisclosure(entries: readonly DisclosureEntry[]): string;

/** Návratový kód brány: 0 když prošly všechny kontroly. */
export declare function main(argv: readonly string[]): number;
