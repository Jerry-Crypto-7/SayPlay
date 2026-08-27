import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import type { RandomGenerator } from 'pure-rand/types/RandomGenerator';

import type { PaletteName } from '../../kit';
import type { GeomProgram } from '../program';

/**
 * Výtvarná rodina — **vedení, ne nekonečný generátor**.
 *
 * Rodina není náhodný styl: je to trojice rozhodnutí, která se drží napříč
 * semínky — paleta z kitu, silueta (které kategorie kusů scénu nesou) a
 * pravidla proporcí (jak vysoký a jak široký svět vzniká). Semínko mění
 * rozmístění a počty, nikdy ne tuhle trojici. Proto se dvě semínka téže rodiny
 * musí měřením poznat jako **stejná** a dvě rodiny jako **různé** — přesně to
 * měří `e2e/divergence.spec.ts` proti prahu v `threshold.json`.
 *
 * Palety jsou z `src/kit/palettes.ts` a žádná neobsahuje fialovou ani
 * purpurovou (globální pravidlo designu, strojově hlídané v kitu).
 *
 * Typ i pomocníci bydlí zvlášť od `index.ts` schválně: registr rodiny importuje
 * a rodiny importují tenhle soubor, takže mezi nimi nevzniká kruh.
 */
export interface Family {
  readonly id: string;
  readonly title: string;
  readonly palette: PaletteName;
  /** Čím se rodina pozná na siluetě — co scénu nese a co ji doplňuje. */
  readonly silhouette: string;
  /** Pravidla proporcí. Čísla jsou v polích mřížky kitu. */
  readonly proportions: {
    /** Přibližný poloměr, do kterého se svět vejde. */
    readonly footprint: number;
    /** Přibližná výška nejvyššího kusu. */
    readonly height: number;
    /** Kolik kusů rodina staví — hustota, ne strop. */
    readonly pieces: number;
  };
  /** Program pro dané semínko. Táž rodina, jiné rozmístění. */
  readonly compose: (seed: number) => GeomProgram;
}

/**
 * Stream rodiny. Každá rodina losuje z vlastního, takže přidání jednoho losu
 * v jedné rodině nepohne rozmístěním v ostatních.
 */
export function familyStream(seed: number): RandomGenerator {
  return xoroshiro128plus(seed);
}

/** Jediná povolená distribuce nad streamem — ať se `pure-rand` neimportuje po rodinách. */
export function nextInt(stream: RandomGenerator, from: number, to: number): number {
  return uniformInt(stream, from, to);
}
