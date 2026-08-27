/**
 * Metrika odlišnosti dvou vyrenderovaných snímků (P11 T10).
 *
 * **Proč se neporovnává pixel s pixelem.** Dvě semínka téže rodiny rozsypou
 * stromy jinam, takže rozdíl po pixelech je obrovský — a klidně větší než mezi
 * dvěma různými rodinami. Taková metrika by měřila rozmístění, ne výtvarný
 * záměr, a prahem by prošla i rodina, která je od sousední k nerozeznání.
 *
 * Měří se proto dvě věci, které rodina drží napříč semínky:
 *
 * 1. **Paleta** — rozdělení barev přes zakryté pixely, 4×4×4 přihrádky.
 *    Vzdálenost je totální variace, tedy 0 pro shodné rozdělení a 1 pro
 *    rozdělení bez jediné společné přihrádky. Rozmístění s ní nehne.
 * 2. **Profil siluety** — podíl zakrytých řádků v každém sloupci obrazu.
 *    Nese proporce: široká nízká krajina má mělký profil přes celou šířku,
 *    úzká vysoká zástavba hluboký ve výseku. Normalizovat ho nesmí nic, jinak
 *    by „nízké" a „vysoké" splynulo.
 *
 * Celková odlišnost je jejich průměr. Obojí je v rozsahu 0 až 1, takže i
 * výsledek je, a práh v `src/geom/families/threshold.json` se dá číst bez
 * znalosti rozlišení snímku.
 *
 * **Zakrytí se čte z alfa kanálu, ne z barvy.** Pozadí se maže s alfou 0,
 * geometrie kreslí s alfou 1. Kdyby se zakrytí hádalo z barvy, splynul by
 * s pozadím každý kus, který na něj náhodou trefí odstín.
 */

export interface Frame {
  readonly width: number;
  readonly height: number;
  /** RGBA po řádcích. Délka je `width * height * 4`. */
  readonly pixels: Uint8Array;
}

export interface Divergence {
  /** Vzdálenost rozdělení barev, 0 až 1. */
  readonly palette: number;
  /** Vzdálenost profilu siluety, 0 až 1. */
  readonly profile: number;
  /** Průměr obou, 0 až 1. Proti tomuhle číslu stojí práh. */
  readonly total: number;
}

/** Přihrádek na kanál. 4 × 4 × 4 = 64 přihrádek celkem. */
const BINS_PER_CHANNEL = 4;

function assertFrame(frame: Frame, where: string): void {
  const expected = frame.width * frame.height * 4;
  if (frame.pixels.length !== expected) {
    throw new Error(`${where}: snímek má ${frame.pixels.length} bajtů, čekalo se ${expected}`);
  }
}

/** Podíl pixelů, které něco zakrývá. Prázdný snímek nemá o čem vypovídat. */
export function coverage(frame: Frame): number {
  assertFrame(frame, 'coverage');
  let covered = 0;
  for (let index = 3; index < frame.pixels.length; index += 4) {
    if (frame.pixels[index] > 127) covered += 1;
  }
  return covered / (frame.width * frame.height);
}

/** Rozdělení barev přes zakryté pixely. Součet je 1, nebo 0 u prázdného snímku. */
export function paletteSignature(frame: Frame): readonly number[] {
  assertFrame(frame, 'paletteSignature');
  const bins = new Array<number>(BINS_PER_CHANNEL ** 3).fill(0);
  let covered = 0;

  for (let index = 0; index < frame.pixels.length; index += 4) {
    if (frame.pixels[index + 3] <= 127) continue;
    let bin = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      bin =
        bin * BINS_PER_CHANNEL +
        Math.min(BINS_PER_CHANNEL - 1, (frame.pixels[index + channel] * BINS_PER_CHANNEL) >> 8);
    }
    bins[bin] += 1;
    covered += 1;
  }

  return covered === 0 ? bins : bins.map((count) => count / covered);
}

/** Podíl zakrytých řádků v každém sloupci. Délka je šířka snímku. */
export function silhouetteProfile(frame: Frame): readonly number[] {
  assertFrame(frame, 'silhouetteProfile');
  const profile = new Array<number>(frame.width).fill(0);

  for (let row = 0; row < frame.height; row += 1) {
    for (let column = 0; column < frame.width; column += 1) {
      if (frame.pixels[(row * frame.width + column) * 4 + 3] > 127) profile[column] += 1;
    }
  }

  return profile.map((count) => count / frame.height);
}

/** Totální variace dvou rozdělení: 0 pro shodná, 1 pro zcela nesouhlasná. */
function totalVariation(first: readonly number[], second: readonly number[]): number {
  return first.reduce((sum, value, index) => sum + Math.abs(value - second[index]), 0) / 2;
}

function meanAbsolute(first: readonly number[], second: readonly number[]): number {
  return first.reduce((sum, value, index) => sum + Math.abs(value - second[index]), 0) / first.length;
}

export function divergence(first: Frame, second: Frame): Divergence {
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error('snímky nemají stejné rozlišení, odlišnost by měřila rozměr');
  }

  const palette = totalVariation(paletteSignature(first), paletteSignature(second));
  const profile = meanAbsolute(silhouetteProfile(first), silhouetteProfile(second));

  return { palette, profile, total: (palette + profile) / 2 };
}

export interface Pair {
  readonly first: string;
  readonly second: string;
  readonly divergence: Divergence;
}

/**
 * Všechny neuspořádané dvojice snímků. Volající si je rozdělí na dvojice
 * napříč rodinami a uvnitř jedné podle jmen, se kterými snímky vložil.
 */
export function allPairs(frames: ReadonlyMap<string, Frame>): readonly Pair[] {
  const names = [...frames.keys()];
  const pairs: Pair[] = [];

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      pairs.push({
        first: names[i],
        second: names[j],
        divergence: divergence(frames.get(names[i])!, frames.get(names[j])!),
      });
    }
  }

  return pairs;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('průměr prázdné množiny není číslo');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
