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

/** Proměnná prostředí, kterou se vědomě obejde nenaplněný seznam. */
export declare const UNPROVISIONED_WAIVER: string;

/** Shody celých slov; `Reactor` netrefí identifikátor `Actor`. */
export declare function findHits(
  text: string,
  identifiers: readonly string[],
): { identifier: string; index: number; line: number }[];

/**
 * Rozhodnutí nad naskenovanou množinou. `blocked` je celý verdikt: nepřečtený
 * soubor zastavuje běh stejně jako nález, protože o jeho obsahu brána neví nic.
 */
export declare function verdict(
  files: readonly { shown: string; text: string | null }[],
  identifiers: readonly string[],
): {
  files: number;
  skipped: string[];
  findings: { identifier: string; index: number; line: number; file: string }[];
  blocked: boolean;
};

/**
 * Návratový kód kontroly: 0 bez nálezu, 1 při nálezu, při chybějícím seznamu,
 * při nepřečteném souboru i nad nenaplněným seznamem bez `UNPROVISIONED_WAIVER`.
 */
export declare function main(argv?: readonly string[]): number;
