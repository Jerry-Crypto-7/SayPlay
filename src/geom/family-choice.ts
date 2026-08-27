import { FAMILIES } from './families';

/**
 * Kterou výtvarnou rodinu věta dostane.
 *
 * Do 26. 8. 2026 rozhodovalo **semínko světa**: rodina byla vlastnost mřížky a
 * zdí, ne objednávky. Dvě věty, které si říkají o dvě různé krajiny, tak mohly
 * dostat tutéž — a naopak. Tenhle soubor to obrací: rozhoduje `look`, který
 * emise **už dnes nese** (`src/model/local/shapes.ts`), ne nové pole.
 *
 * ## Proč slova, a ne klíče
 *
 * `look.palette` a `look.atmosphere` **nemají uzavřený slovník** — `lookSchema`
 * (`src/ir/worlddoc.ts:113`) žádá jen to, aby pole existovalo. Naměřeno 27. 8.
 * 2026 nad celým repozitářem: rozpoznávač píše `stone`, `amber`, `neon`,
 * `meadow`, `steel`; zmrazený korpus píše `slate`, `teal`, `green`, `orange`,
 * `blue`; a **živý model píše celé věty** — `bright primary colors with natural
 * wood`, `carnival-red-cream-blue`, `clear playful arena`. Tabulka klíčů by tedy
 * minula většinu skutečných vstupů a spadla na semínko, což je přesně ta vada,
 * kvůli které vlna 3 vznikla.
 *
 * Rozhoduje proto **první slovo, které něco znamená**, ne celý řetězec.
 *
 * ## Dva údaje a kdo z nich vyhrává
 *
 * `palette` říká, z čeho je svět postavený, `atmosphere` říká, jaké je v něm
 * počasí. Když se ty dva rozejdou, **vyhrává počasí**: mlha a déšť mění siluetu
 * víc než materiál — v mlze čte svět jako vysoké tvary mizející nahoru, v dešti
 * jako těžké hmoty u země. Za jasného dne žádná taková síla nepůsobí a
 * rozhoduje materiál.
 *
 * ## Bez použitelného `look` se padá na semínko, ne na konstantu
 *
 * Rozpoznávač trefí 26 z 200 vět (13 %), takže konstantní záloha by 87 %
 * porotců ukázala tutéž krajinu. Semínko aspoň drží rozmanitost, i když ji
 * nevede věta.
 *
 * Soubor **neimportuje `three`**: rozhodnutí je mapování řetězců a musí jít
 * změřit tam, kde renderer není.
 */

/**
 * Počasí → rodina. `clear` a `none` tu schválně **nejsou**: jasno není síla,
 * která by siluetu měnila, a nechává rozhodnout materiál.
 */
const BY_WEATHER: Readonly<Record<string, string>> = {
  /** Mlha, mrholení a sníh vytáhnou siluetu do výšky. */
  fog: 'spires',
  mist: 'spires',
  haze: 'spires',
  snow: 'spires',
  /** Déšť, bouře a kouř ji zatíží k zemi. */
  rain: 'works',
  rainy: 'works',
  storm: 'works',
  stormy: 'works',
  smog: 'works',
  smoke: 'works',
};

/**
 * Materiál → rodina. Slova, ne klíče: hledá se výskyt uvnitř `palette`, takže
 * `carnival-red-cream-blue` rozhodne `cream` a `natural wood` rozhodne `wood`.
 */
const BY_MATERIAL: Readonly<Record<string, string>> = {
  /** Suchý kámen a písek: vodorovné desky a stupně. */
  stone: 'terraces',
  slate: 'terraces',
  sand: 'terraces',
  sandstone: 'terraces',
  dune: 'terraces',
  dunes: 'terraces',
  desert: 'terraces',
  clay: 'terraces',
  brick: 'terraces',
  amber: 'terraces',
  ochre: 'terraces',
  cream: 'terraces',
  beige: 'terraces',
  tan: 'terraces',

  /** Studené, vysoké, umělé. */
  frost: 'spires',
  ice: 'spires',
  icy: 'spires',
  glass: 'spires',
  crystal: 'spires',
  chrome: 'spires',
  silver: 'spires',
  neon: 'spires',
  teal: 'spires',
  cyan: 'spires',
  blue: 'spires',
  cobalt: 'spires',

  /** Zeleň a porost. */
  green: 'grove',
  meadow: 'grove',
  thicket: 'grove',
  moss: 'grove',
  grass: 'grove',
  forest: 'grove',
  wood: 'grove',
  wooden: 'grove',
  leaf: 'grove',
  olive: 'grove',
  jade: 'grove',
  natural: 'grove',

  /** Průmysl a těžké hmoty. */
  steel: 'works',
  iron: 'works',
  rust: 'works',
  rusty: 'works',
  copper: 'works',
  brass: 'works',
  foundry: 'works',
  kiln: 'works',
  coal: 'works',
  ember: 'works',
  orange: 'works',
  industrial: 'works',
};

/** Záloha bez věty: rodina ze semínka světa, aby zůstala rozmanitost. */
export function familyForSeed(seed: number): string {
  return FAMILIES[Math.abs(Math.trunc(seed)) % FAMILIES.length].id;
}

function stringAt(look: unknown, key: string): string {
  const value = (look as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * První slovo řetězce, které tabulka zná. `null`, když žádné — a to je odpověď,
 * ne selhání: rozhodne pak druhý údaj, nebo semínko.
 */
function firstKnownWord(text: string, table: Readonly<Record<string, string>>): string | null {
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const family = table[word];
    if (family !== undefined) return family;
  }
  return null;
}

/**
 * `look` emise → id rodiny. Totální a deterministické: týž `look` dá vždy tutéž
 * rodinu, `look` bez jediného známého slova spadne na semínko.
 */
export function chooseFamily(look: unknown, seed: number): string {
  return (
    firstKnownWord(stringAt(look, 'atmosphere'), BY_WEATHER) ??
    firstKnownWord(stringAt(look, 'palette'), BY_MATERIAL) ??
    familyForSeed(seed)
  );
}
