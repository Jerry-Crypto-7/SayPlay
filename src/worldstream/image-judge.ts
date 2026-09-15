/**
 * **Obrazový soudce** — „vypadá to dobře" přeložené do pěti čísel.
 *
 * Do 28. 8. 2026 se vzhled tohohle projektu měřil **jedinou** vlastností:
 * odstupem jasu figury od pozadí aspoň 40 (`src/kit/palettes.ts`), a to nad
 * čtyřmi ručně napsanými rodinami. Jedno číslo nad čtyřmi světy neumí říct,
 * jestli je obraz plochý, mrtvý nebo bez ohniska — a hlavně se do něj nedá
 * nic přidat, takže se vizuální zlepšení nekumulovalo. Každá další oprava
 * vzhledu byla názor proti názoru.
 *
 * ## Pět vlastností a co každá chytá
 *
 * 1. **Rozptyl jasu** — má obraz tmy, středy i světla? Scéna nasvícená jedním
 *    plochým světlem má všechno v jednom pásmu a čte se jako výkres.
 * 2. **Jednoznačnost a poloha ohniska** — je v obraze jedno místo, kam se oko
 *    dívá? Dvě stejně silná místa se perou a divák neví, co je hlavní.
 * 3. **Čitelnost siluety** — kolik hran je v okolí ohniska. Objekt, který
 *    splývá s pozadím, je na snímku přítomný a přesto neviditelný.
 * 4. **Počet odstínů** — kolik barev v obraze doopravdy je. Jedna barva se
 *    čte jako monochrom, ne jako svět.
 * 5. **Podíl mrtvé plochy** — kolik obrazu se vůbec nehýbe. Tohle je ta
 *    vlastnost, kterou dnešní produkt propadá: plochá mlha a jedno pozadí.
 *
 * ## Proč čistá funkce nad polem pixelů
 *
 * Žádný `three`, žádný prohlížeč, žádné plátno. Soudce se tak pustí jednotkově
 * nad syntetickým obrazem (a jenom tam se dá dokázat, že soudí správně —
 * u vyrenderované scény nikdo neví, jaká je pravda) **i** nad snímkem, který
 * z prohlížeče přinese Playwright. Dvě implementace by daly dvě různé pravdy
 * o tomtéž snímku.
 *
 * ## Jas je BT.709, a je to jediná definice v repu
 *
 * Tytéž váhy jako `e2e/render-quality.spec.ts` a `luminanceOf` v kitu. Druhá
 * definice jasu by znamenala, že brána nad snímkem a brána nad paletou soudí
 * dvě různé veličiny se stejným jménem.
 *
 * ## Prahy
 *
 * Všechny v `IMAGE_THRESHOLDS`, ani jeden rozsetý po asercích. Když se
 * o vzhledu rozhodne jinak, mění se jedno místo — a je vidět, že se změnil
 * práh, ne měřidlo.
 */

/** Váhy BT.709. Zelená se do dojmu ze světlosti promítá zhruba sedmkrát silněji než modrá. */
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/**
 * Mřížka, na kterou se obraz dělí.
 *
 * 16×9 kopíruje poměr stran snímku, takže buňka je zhruba čtvercová. Na
 * obdélníkové mřížce by „mrtvá plocha" znamenala něco jiného nahoře než po
 * stranách, protože by se počítala z různě velkých kusů obrazu.
 */
export const JUDGE_GRID = { columns: 16, rows: 9 } as const;

/**
 * Odstínových košů. Dvanáct po 30° — jemnější dělení by dvě sousední barvy
 * počítalo jako dvě.
 *
 * **Exportované kvůli `look-repair.ts`**, který musí počítat odstíny vzhledu
 * v týchž koších jako soudce obraz. Dvě různá dělení by znamenala, že oprava
 * míří vedle prahu, který má splnit.
 */
export const HUE_BUCKETS = 12;

/** Pásem jasu. Pět, protože přesně tolik jich žádá brána atmosféry v T3. */
const LUMINANCE_BANDS = 5;

export const IMAGE_THRESHOLDS = {
  /** Kolik z pěti pásem jasu musí být obsazených, jako podíl. 0,6 = tři z pěti. */
  minLuminanceSpread: 0.6,
  /** Pásmo se počítá za obsazené od tohohle podílu pixelů. Pod ním je to šum, ne obsah. */
  bandOccupancy: 0.02,
  /** O kolik musí nejsilnější ohnisko přebít druhé, jako podíl. */
  minFocusClarity: 0.25,
  /** Podíl pixelů s hranou v okolí ohniska. */
  minSilhouette: 0.04,
  /** Nejmenší počet obsazených odstínových košů. */
  minHues: 3,
  /** Kolik obrazu smí být mrtvé plochy. */
  maxDead: 0.55,
  /** Odkud výš se rozdíl jasu dvou sousedů počítá jako hrana, 0–255. */
  edge: 14,
  /** Pod tímhle rozpětím jasu je buňka mrtvá, 0–255. */
  deadRange: 8,
  /** Pod touhle sytostí pixel žádný odstín nenese a do počtu barev se nepočítá. */
  minSaturation: 0.15,
  /**
   * Od jakého podílu vrcholu ještě sousední buňka patří **témuž** ohnisku.
   *
   * Bez tohohle čísla by se soupeřem vrcholu stala vedlejší buňka téhož
   * objektu — velký objekt přes šest buněk by tak vždycky vyšel jako dvě
   * stejně silná ohniska a jednoznačnost by byla nula i u obrazu, kde je
   * ohnisko jediné. Naměřeno na syntetických snímcích v `image-judge.test.ts`.
   */
  focusLink: 0.5,
  /** Od tohohle podílu sytých pixelů se koš počítá za obsazený. */
  hueOccupancy: 0.01,
} as const;

/** Obraz tak, jak ho vydá `canvas.getImageData()` — RGBA po řádcích. */
export interface Pixels {
  readonly data: Uint8ClampedArray | Uint8Array | readonly number[];
  readonly width: number;
  readonly height: number;
}

export interface ImageMeasurement {
  /** Podíl obsazených pásem jasu, 0–1. */
  readonly luminanceSpread: number;
  /** O kolik nejsilnější ohnisko přebíjí druhé, 0–1. Nula znamená, že ohnisko není. */
  readonly focusClarity: number;
  /** Kde ohnisko leží, v podílu šířky a výšky. */
  readonly focusAt: readonly [number, number];
  /** Podíl pixelů s hranou v okolí ohniska, 0–1. */
  readonly silhouette: number;
  /** Kolik z dvanácti odstínových košů je obsazených. */
  readonly hues: number;
  /** Podíl mrtvé plochy, 0–1. */
  readonly dead: number;
}

/** Jména pěti vlastností. Jediný slovník — hlášky i prahy se odkazují sem. */
export const IMAGE_PROPERTIES = [
  'luminanceSpread',
  'focusClarity',
  'silhouette',
  'hues',
  'dead',
] as const;

export type ImageProperty = (typeof IMAGE_PROPERTIES)[number];

export interface ImageJudgement {
  readonly measured: ImageMeasurement;
  /** Které vlastnosti propadly. Prázdné pole znamená, že obraz obstál. */
  readonly failed: readonly ImageProperty[];
  readonly ok: boolean;
}

/**
 * Obraz se soudí, ne odhaduje — a vada vstupu je vada, ne nula.
 *
 * Prázdné pole, plocha nula nebo pole, které na RGBA nesedí, znamená, že se
 * snímek nepořídil. Kdyby se za to vrátila nula, brána by tiše certifikovala
 * ošklivý obraz jako změřený a nikdo by se to nedozvěděl — což je přesně to
 * selhání, kvůli kterému má tenhle soubor `Test level: full`.
 */
function assertUsable(image: Pixels): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new Error('image-judge: rozměry snímku musí být celá čísla');
  }
  if (image.width <= 0 || image.height <= 0) {
    throw new Error(
      `image-judge: snímek má nulovou plochu (${String(image.width)}×${String(image.height)})`,
    );
  }
  if (image.data.length === 0) {
    throw new Error('image-judge: snímek je prázdný, nedá se z něj soudit nic');
  }
  const expected = image.width * image.height * 4;
  if (image.data.length !== expected) {
    throw new Error(
      `image-judge: pole má ${String(image.data.length)} hodnot, ale ${String(image.width)}×` +
        `${String(image.height)} v RGBA jich žádá ${String(expected)}`,
    );
  }
}

/**
 * Jas jednoho pixelu, 0–255, podle BT.709.
 *
 * Vyvedené ven schválně: je to definice, na které stojí čtyři z pěti
 * vlastností, a jediný způsob, jak ji připnout asercí místo komentářem. Kdyby
 * zůstala uvnitř, dala by se váha zaměnit za prostý průměr kanálů a test by
 * o tom mlčel, protože všechna pásma by se posunula stejně.
 */
export function pixelLuminance(r: number, g: number, b: number): number {
  return LUMA.r * r + LUMA.g * g + LUMA.b * b;
}

function luminanceAt(data: Pixels['data'], at: number): number {
  return pixelLuminance(data[at], data[at + 1], data[at + 2]);
}

/** Odstín 0–360 a sytost 0–1 z kanálů 0–255. Odstín šedé barvy nic neznamená. */
export function hueSaturation(r: number, g: number, b: number): { hue: number; saturation: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  if (span === 0) return { hue: 0, saturation: 0 };

  let hue: number;
  if (max === r) hue = ((g - b) / span) % 6;
  else if (max === g) hue = (b - r) / span + 2;
  else hue = (r - g) / span + 4;

  return { hue: (((hue * 60) % 360) + 360) % 360, saturation: span / max };
}

/**
 * Odstín barvy `#rrggbb` tak, jak ho vidí soudce — nebo `null`, když ji za
 * barvu nepovažuje.
 *
 * **Pozor na dvojče.** `hueOf` v `look-schema.ts` počítá odstín taky, jenže
 * odmítá barvu podle **absolutního** rozpětí kanálů (span < 0,04), zatímco
 * soudce podle **poměrné** sytosti (span / max < 0,15). Na tmavých barvách se
 * ta dvě pravidla rozcházejí: kovová zem `#2b3033` je pro soudce barva
 * (sytost 0,157), pro `hueOf` šedá (rozpětí 0,031). `look-schema.hueOf` je
 * pravda o **zákazu fialové**, tahle funkce je pravda o **prahu odstínů** —
 * a oprava vzhledu musí čerpat odtud, jinak míří vedle prahu, který má splnit.
 */
export function judgedHue(hex: string): number | null {
  const n = Number.parseInt(hex.slice(1), 16);
  const { hue, saturation } = hueSaturation((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  return saturation < IMAGE_THRESHOLDS.minSaturation ? null : hue;
}

/**
 * Do kterého z dvanácti košů barva patří, nebo `null`, když do žádného.
 *
 * Jediná pravda o koších pro celý repozitář — `look-repair.ts` počítá odstíny
 * vzhledu touhle funkcí, aby počítal v týchž koších, ve kterých soudce počítá
 * odstíny obrazu.
 */
export function judgedHueBucket(hex: string): number | null {
  const hue = judgedHue(hex);
  return hue === null ? null : Math.min(HUE_BUCKETS - 1, Math.floor((hue / 360) * HUE_BUCKETS));
}

interface Cell {
  readonly column: number;
  readonly row: number;
  /** Rozpětí jasu uvnitř buňky. Je to míra toho, kolik se v ní děje. */
  readonly range: number;
}

/**
 * Rozpětí jasu po buňkách mřížky.
 *
 * Ohnisko se hledá **podle rozpětí, ne podle jasu**. Kdyby rozhodoval jas, byla
 * by ohniskem vždycky obloha — je to největší světlá plocha obrazu a přitom
 * v ní není nic k vidění. Rozpětí najde místo, kde se světlo láme o tvar, což
 * je přesně to, kam se oko dívá.
 */
function cellsOf(image: Pixels): readonly Cell[] {
  const cells: Cell[] = [];
  const cellWidth = image.width / JUDGE_GRID.columns;
  const cellHeight = image.height / JUDGE_GRID.rows;

  for (let row = 0; row < JUDGE_GRID.rows; row += 1) {
    for (let column = 0; column < JUDGE_GRID.columns; column += 1) {
      const fromX = Math.floor(column * cellWidth);
      const toX = Math.max(fromX + 1, Math.floor((column + 1) * cellWidth));
      const fromY = Math.floor(row * cellHeight);
      const toY = Math.max(fromY + 1, Math.floor((row + 1) * cellHeight));

      let low = 255;
      let high = 0;
      for (let y = fromY; y < Math.min(toY, image.height); y += 1) {
        for (let x = fromX; x < Math.min(toX, image.width); x += 1) {
          const luminance = luminanceAt(image.data, (y * image.width + x) * 4);
          if (luminance < low) low = luminance;
          if (luminance > high) high = luminance;
        }
      }

      cells.push({ column, row, range: Math.max(0, high - low) });
    }
  }

  return cells;
}

/**
 * Nejsilnější ohnisko a o kolik přebíjí druhé.
 *
 * Soupeř se hledá **mimo celý objekt**, ne jen mimo sousední buňku. Rozdíl
 * není akademický: první verze vylučovala okolí 3×3 a objekt přes čtyři sloupce
 * si tak konkuroval sám — vlastní protilehlý roh měl totéž rozpětí, takže
 * jednoznačnost vyšla nula i u obrazu s jediným zřetelným ohniskem.
 *
 * Objekt se proto rozlije: z vrcholu se rozšíří přes všechny sousedy, jejichž
 * rozpětí drží aspoň `focusLink` podíl vrcholu. Co zbude venku, je jiné místo
 * obrazu — a když je stejně silné, obraz má dvě ohniska a žádné hlavní.
 */
function focusOf(cells: readonly Cell[]): { clarity: number; at: readonly [number, number] } {
  const peak = cells.reduce((best, cell) => (cell.range > best.range ? cell : best), cells[0]);
  const at: readonly [number, number] = [
    (peak.column + 0.5) / JUDGE_GRID.columns,
    (peak.row + 0.5) / JUDGE_GRID.rows,
  ];

  // Plochý obraz nemá ohnisko, ne stoprocentní: dělení nulou by z prázdné
  // šedi udělalo nejjednoznačnější obraz, jaký soudce zná.
  if (peak.range === 0) return { clarity: 0, at };

  const indexOf = (column: number, row: number): number => row * JUDGE_GRID.columns + column;
  const linked = peak.range * IMAGE_THRESHOLDS.focusLink;
  const inFocus = new Set<number>([indexOf(peak.column, peak.row)]);
  const queue: Cell[] = [peak];

  while (queue.length > 0) {
    const cell = queue.pop()!;
    for (let row = cell.row - 1; row <= cell.row + 1; row += 1) {
      for (let column = cell.column - 1; column <= cell.column + 1; column += 1) {
        if (row < 0 || column < 0 || row >= JUDGE_GRID.rows || column >= JUDGE_GRID.columns) continue;
        const key = indexOf(column, row);
        if (inFocus.has(key) || cells[key].range < linked) continue;
        inFocus.add(key);
        queue.push(cells[key]);
      }
    }
  }

  const rival = cells.reduce(
    (best, cell, key) => (inFocus.has(key) ? best : Math.max(best, cell.range)),
    0,
  );

  return { clarity: Math.max(0, (peak.range - rival) / peak.range), at };
}

/**
 * Hustota hran v okolí ohniska.
 *
 * „Hlavní objekt" soudce nesegmentuje — nemá jak a segmentace by byla druhý
 * systém, který se dá mýlit sám. Bere se proto **třetina obrazu kolem
 * ohniska**, což je nejlepší dostupná odpověď na otázku „kde ten hlavní objekt
 * je" a je odvozená z čísla, které se stejně počítá.
 */
function silhouetteAt(image: Pixels, at: readonly [number, number]): number {
  const halfWidth = Math.max(1, Math.round(image.width / 6));
  const halfHeight = Math.max(1, Math.round(image.height / 6));
  const centerX = Math.round(at[0] * image.width);
  const centerY = Math.round(at[1] * image.height);

  const fromX = Math.max(0, centerX - halfWidth);
  const toX = Math.min(image.width - 1, centerX + halfWidth);
  const fromY = Math.max(0, centerY - halfHeight);
  const toY = Math.min(image.height - 1, centerY + halfHeight);

  let edges = 0;
  let counted = 0;
  for (let y = fromY; y < toY; y += 1) {
    for (let x = fromX; x < toX; x += 1) {
      const here = luminanceAt(image.data, (y * image.width + x) * 4);
      const right = luminanceAt(image.data, (y * image.width + x + 1) * 4);
      const below = luminanceAt(image.data, ((y + 1) * image.width + x) * 4);
      if (Math.abs(right - here) >= IMAGE_THRESHOLDS.edge) edges += 1;
      else if (Math.abs(below - here) >= IMAGE_THRESHOLDS.edge) edges += 1;
      counted += 1;
    }
  }

  return counted === 0 ? 0 : edges / counted;
}

/** Pět vlastností jednoho snímku. Neprahuje, jen měří. */
export function measureImage(image: Pixels): ImageMeasurement {
  assertUsable(image);

  const pixels = image.width * image.height;
  const bands = new Array<number>(LUMINANCE_BANDS).fill(0);
  const hues = new Array<number>(HUE_BUCKETS).fill(0);
  let saturated = 0;

  for (let at = 0; at < pixels; at += 1) {
    const base = at * 4;
    const luminance = luminanceAt(image.data, base);
    const band = Math.min(LUMINANCE_BANDS - 1, Math.floor((luminance / 256) * LUMINANCE_BANDS));
    bands[band] += 1;

    const { hue, saturation } = hueSaturation(
      image.data[base],
      image.data[base + 1],
      image.data[base + 2],
    );
    if (saturation >= IMAGE_THRESHOLDS.minSaturation) {
      hues[Math.min(HUE_BUCKETS - 1, Math.floor((hue / 360) * HUE_BUCKETS))] += 1;
      saturated += 1;
    }
  }

  const cells = cellsOf(image);
  const focus = focusOf(cells);

  return {
    luminanceSpread:
      bands.filter((count) => count / pixels >= IMAGE_THRESHOLDS.bandOccupancy).length /
      LUMINANCE_BANDS,
    focusClarity: focus.clarity,
    focusAt: focus.at,
    silhouette: silhouetteAt(image, focus.at),
    // Obraz úplně bez sytých pixelů má nula odstínů, ne dvanáct: dělení nulou
    // by monochrom prohlásilo za nejbarevnější snímek, jaký soudce zná.
    hues:
      saturated === 0
        ? 0
        : hues.filter((count) => count / saturated >= IMAGE_THRESHOLDS.hueOccupancy).length,
    dead: cells.filter((cell) => cell.range < IMAGE_THRESHOLDS.deadRange).length / cells.length,
  };
}

/** Změří a řekne, které z pěti vlastností propadly. */
export function judgeImage(image: Pixels): ImageJudgement {
  const measured = measureImage(image);
  const failed: ImageProperty[] = [];

  if (measured.luminanceSpread < IMAGE_THRESHOLDS.minLuminanceSpread) failed.push('luminanceSpread');
  if (measured.focusClarity < IMAGE_THRESHOLDS.minFocusClarity) failed.push('focusClarity');
  if (measured.silhouette < IMAGE_THRESHOLDS.minSilhouette) failed.push('silhouette');
  if (measured.hues < IMAGE_THRESHOLDS.minHues) failed.push('hues');
  if (measured.dead > IMAGE_THRESHOLDS.maxDead) failed.push('dead');

  return { measured, failed, ok: failed.length === 0 };
}
