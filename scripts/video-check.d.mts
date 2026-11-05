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

export declare const MAX_VIDEO_BYTES: number;

export type Probe = { seconds: number; error?: undefined } | { seconds?: undefined; error: string };

/** Délka videa z `ffprobe`, nebo čitelný důvod, proč ji nejde zjistit. */
export declare function ffprobeDuration(file: string, bin?: string): Probe;

/** `0` když scénář nebo video projde, `1` když ne, `2` bez argumentu. */
export declare function main(argv: string[], deps?: { probe?: (file: string) => Probe; sizeOf?: (file: string) => number }): number;
