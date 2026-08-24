/**
 * Typy k `video-check.mjs`. Skript musí jít spustit holým Nodem bez build
 * kroku, takže je to `.mjs`; testy jsou TypeScript a potřebují jeho kontrakt
 * zapsaný.
 */

/** Jeden úsek scénáře: kdy začíná, kdy končí a který beat nese. */
export interface Segment {
  start: number;
  end: number;
  beat: string;
}

export declare const LIMIT_SECONDS: number;
export declare const REQUIRED_BEATS: string[];

/** Sekundy z `m:ss`; `null`, když to není čas. */
export declare function parseTime(text: unknown): number | null;

/** Úseky z tabulky scénáře; řádky bez časového rozsahu se přeskočí. */
export declare function parseSegments(markdown: string): Segment[];

/** Součet délek úseků v sekundách. */
export declare function totalSeconds(segments: Segment[]): number;

/** Důvod, proč úseky nejsou spojitá časová osa; `null`, když jsou. */
export declare function contiguityError(segments: Segment[]): string | null;

/** Povinné beaty, které se ve sloupci `Beat` neobjevily. */
export declare function missingBeats(segments: Segment[]): string[];

/** `m:ss` ze sekund. */
export declare function formatTime(seconds: number): string;

/** `0` když scénář projde, `1` když ne. */
export declare function main(argv: string[]): number;
