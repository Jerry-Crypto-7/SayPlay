/**
 * Typy k `cleanroom-check.mjs`. Skript musí jít spustit holým Nodem bez build
 * kroku, takže je to `.mjs`; testy jsou TypeScript a potřebují jeho kontrakt
 * zapsaný.
 */

export declare const LIST_FILE: string;

/**
 * Direktiva „seznam ještě nikdo nenaplnil". Je to komentář, ne identifikátor —
 * zástupné *jméno* by skener našel sám u sebe a zablokoval každý commit.
 */
export declare const UNPROVISIONED: string;

/** Řádky seznamu bez komentářů a prázdných řádků. */
export declare function parseList(text: string): string[];

/** Nese seznam direktivu `UNPROVISIONED`? */
export declare function isUnprovisioned(text: string): boolean;

/** Shody celých slov; `Reactor` netrefí identifikátor `Actor`. */
export declare function findHits(
  text: string,
  identifiers: readonly string[],
): { identifier: string; line: number }[];

/** Návratový kód kontroly: 0 bez nálezu, 1 při nálezu i při chybějícím seznamu. */
export declare function main(argv?: readonly string[]): number;
