/**
 * Typy k `effort-sheet.mjs`. Skript běží holým Nodem bez build kroku, takže je
 * to `.mjs`; test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

/** Pro každou větu písmeno → varianta; zamíchané semínkem. */
export declare interface BlindKey {
  readonly seed: number;
  readonly sections: Record<string, Record<string, string>>;
}

export declare function buildKey(variants: readonly string[], sentences: readonly string[], seed: number): BlindKey;

/** Hodnocení podle písmen zpět k variantám; neznámé písmeno je chyba. */
export declare function reveal(key: BlindKey, ratings: Record<string, Record<string, number>>): Record<string, number[]>;

export declare interface SheetSection {
  readonly id: string;
  readonly prompt: string;
  /** `photo: null` = svět nedorazil. */
  readonly entries: readonly { readonly letter: string; readonly photo: string | null }[];
}

/** `sheetId` odděluje rozpracovaná hodnocení různých archů v `localStorage`. */
export declare function renderSheet(sections: readonly SheetSection[], sheetId?: string): string;

export declare interface VariantStats {
  readonly variant: string;
  readonly ratings: readonly number[];
  /** Časy do živého světa, jen u výměn. */
  readonly swapMs: readonly number[];
  /** `silent-fail` + `timeout` + `no-start`. */
  readonly failures: number;
}

export declare const P95_LIMIT_MS: number;
export declare const FAILURE_LIMIT: number;

export declare function percentile(values: readonly number[], p: number): number | null;

/** Vítěz podle pravidla z P16 T4, nebo `null`, když neprojde nikdo. */
export declare function pickWinner(stats: readonly VariantStats[]): string | null;
