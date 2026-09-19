import {uniformInt} from 'pure-rand/distribution/uniformInt';
import {xoroshiro128plus} from 'pure-rand/generator/xoroshiro128plus';
import type {IntentRole,PlannedObject,PlannerEmission} from '@/model/worldstream-intent';

/**
 * **Hmoty ze slov věty — okamžitý odhad, než plánovač odpoví** (P21 T4).
 *
 * Plánovač trvá desítky vteřin (19. 9. 2026: 75 s) a do jeho odpovědi porotce
 * neviděl nic. Tenhle soubor postaví z věty emisi ve tvaru `PlannerEmission`
 * **bez modelu**: uzavřený slovník ~150 anglických podstatných jmen objektů
 * a míst, číslovky `one`…`twelve` i číslice, množné číslo. Výsledek jde do
 * existujícího `buildMassingPreview` s vlastní značkou `WORD_MASSING_NOTICE`,
 * a náhled plánovače ho pak **nahradí celý** — identita `word-…` nikdy
 * nepřežije (pin v `sessions.test.ts`).
 *
 * ## Co to není
 *
 * Není to rozpoznávač vět ani druhý plánovač. Nečte vztahy, nehádá velikosti
 * nad rámec role a **neví nic o tom, co ve větě není**: „A room that reacts"
 * dá jednu místnost, „Something cozy" nedá nic a vrátí `null`. Podíl vět
 * s aspoň jednou hmotou nad korpusem měří `word-massing.measure.ts`.
 *
 * ## Slovník a jeho vynechávky
 *
 * Slovník je z citátů `oracles.json` a druhů `asset-demand.json`, tedy ze
 * slov, která korpus doopravdy používá. Chybí v něm schválně slova, která se
 * ve větě častěji píší jako sloveso nebo částice než jako věc — `can`
 * („can open"), `well` („as well"), `light` („light the fire"), `safe`,
 * `exit`, `front`, `line`, `pad`, `floor`. Blok, který ve větě nestojí, je
 * horší než chybějící blok: hláška říká, že jsou to slova, ne že jsou to
 * slovesa.
 *
 * ## Determinismus
 *
 * Kulisy (`architecture`, `terrain`) jdou první v pořadí věty — v hmotovém
 * náhledu jsou to desky, na kterých mřížka stojí. Ostatní objekty se míchají
 * Fisher–Yatesem nad `pure-rand` ze `sessionSeed`, takže dvě relace s toutéž
 * větou dostanou jinou mřížku a táž relace vždycky tutéž. `Math.random` tu
 * není; semínko je vstup relace.
 */

/** Role slova ve slovníku → role v emisi. */
type WordRole = 'place' | 'prop' | 'hero' | 'terrain';

const ROLE_OF: Record<WordRole, IntentRole> = {place: 'architecture', prop: 'prop', hero: 'hero', terrain: 'terrain'};

/** Význam roste s tím, kolik hmoty slovo obvykle nese; `buildMassingPreview` z něj dělá měřítko. */
const IMPORTANCE_OF: Record<WordRole, 1 | 2> = {place: 2, terrain: 2, hero: 2, prop: 1};

function words(role: WordRole, list: string): [string, WordRole][] {
  return list.split(/\s+/).filter((word) => word.length > 0).map((word) => [word, role]);
}

/** Jednotné číslo → role. Klíč je lemma, na které se převádí i množné číslo. */
const LEXICON: ReadonlyMap<string, WordRole> = new Map([
  ...words('place', `cabin room kitchen hall hallway corridor courtyard tower castle cathedral church chapel temple palace
    house cottage hut barn farmhouse garage warehouse hangar lobby office library museum gallery classroom school hospital
    pharmacy shop market supermarket cafe cafeteria tavern inn station airport stadium arena dormitory studio
    workshop lighthouse watchtower bridge pier harbor dock tunnel cave chamber cell dome greenhouse treehouse tent camp
    campsite balcony terrace alcove staircase ramp platform bunker laboratory lab city village town plaza theater cinema
    prison bank factory mill windmill aqueduct observatory booth maze bakery bathroom bedroom attic basement cellar
    hayloft airlock`),
  ...words('terrain', `garden park orchard farm field forest beach lake pond pool river stream hill mountain volcano island
    desert meadow swamp glacier canyon valley cliff shore runway road path track street sandbox`),
  ...words('prop', `table chair stool bench sofa couch desk bed hammock shelf bookshelf cabinet counter workbench stove oven
    sink fireplace kiln cauldron kettle cup bottle plate bowl loaf candle lamp lantern torch bulb beacon sign signpost banner
    flag door gate window hatch trapdoor ladder rope hook chest crate box barrel bucket bin key book spellbook logbook letter
    mirror statue pedestal column pillar arch wall fence railing guardrail fountain tree plant flower mushroom log rock
    boulder crystal ball cube sphere pyramid cylinder pendulum seesaw swing domino lever switch button valve pipe
    gauge panel screen television telescope machine engine generator battery crane cannon bell clock wheel turnstile cart
    bicycle car bus train locomotive boat ship plane shuttle pod drone tank throne skull coaster scarecrow beehive aquarium
    sun planet cloud heart mast anvil forge checkpoint pit elevator stall bookcase curtain rug carpet painting portrait piano drum
    guitar computer keyboard printer`),
  ...words('hero', `dragon robot dog cat deer sheep chicken crow parrot fairy monk guard merchant farmer librarian nurse doctor
    blacksmith shepherd cashier customer visitor person child knight wizard ghost monster horse cow pig bird fish wolf bear
    fox rabbit spider snake elephant lion tiger whale octopus unicorn giant troll goblin skeleton zombie alien astronaut
    pirate soldier teacher student kid man woman king queen princess prince witch dwarf elf golem android patient
    listener participant crew`),
]);

/** Množné číslo, které pravidla nezvládnou. */
const IRREGULAR: ReadonlyMap<string, string> = new Map([
  ['people', 'person'], ['children', 'child'], ['men', 'man'], ['women', 'woman'], ['mice', 'mouse'], ['geese', 'goose'],
  ['wolves', 'wolf'], ['shelves', 'shelf'], ['dominoes', 'domino'], ['elves', 'elf'], ['dwarves', 'dwarf'], ['knives', 'knife'],
]);

const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ['one', 1], ['single', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8],
  ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
]);

/** Slova, za kterými číslovka už nepatří k tomuhle podstatnému jménu („two chairs and a table"). */
const BOUNDARY = new Set(['and', 'or', 'with', 'of', 'in', 'on', 'that', 'where', 'which', 'a', 'an', 'the', 'then', 'to', 'at', 'by']);

/**
 * Za zájmenem je tvar na `-s` sloveso, ne množné číslo: „a stone that sinks",
 * „it swings". Za podstatným jménem („the pendulum swings") to rozhodnout
 * nejde, protože „rope bridges" a „tree houses" vypadají stejně — ta věta
 * proto dostane blok navíc a hláška o tom mluví pravdu: jsou to slova.
 */
const PRONOUNS = new Set(['that', 'which', 'who', 'it', 'he', 'she', 'they', 'this', 'i', 'you', 'we']);

/**
 * Nejvíc hmot na jedno slovo a na celou větu.
 *
 * Dvanáct je konec číslovek, které slovník zná; číslice nad ním se
 * **ustřihnou**, ne odmítnou — „99999999 trees" (`adversarial-4`) je pořád
 * zahrada se stromy. Třicet dva je polovina `MAX_MASSES` hmotového náhledu,
 * aby odhad ze slov nikdy nevyplnil celou desku.
 */
const MAX_PER_WORD = 12;
const MAX_OBJECTS = 32;

/** `chairs` → `chair`, `boxes` → `box`, `cherries` → `cherry`; `-ss`/`-us`/`-is` a krátká slova zůstávají. */
function singular(word: string): string {
  const irregular = IRREGULAR.get(word);
  if (irregular !== undefined) return irregular;
  if (/(ss|us|is)$/.test(word) || word.length < 4) return word;
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/ves$/.test(word)) return word.replace(/ves$/, 'f');
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.replace(/es$/, '');
  if (/s$/.test(word)) return word.replace(/s$/, '');
  return word;
}

/** Číslovka nejvýš tři slova před podstatným jménem, ale ne přes hranici jiné věci. */
function countBefore(tokens: readonly string[], index: number, plural: boolean): number {
  for (let back = 1; back <= 3 && index - back >= 0; back += 1) {
    const token = tokens[index - back]!;
    const word = NUMBER_WORDS.get(token);
    if (word !== undefined) return word;
    if (/^\d+$/.test(token)) return Math.min(MAX_PER_WORD, Math.max(1, Number(token)));
    if (BOUNDARY.has(token) || LEXICON.has(singular(token))) break;
  }
  return plural ? 2 : 1;
}

export function wordMassing(sentence: string, options: {sessionSeed: number}): PlannerEmission | null {
  const tokens = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((token) => token.length > 0);

  // Jedno slovo = jeden druh, i když se ve větě opakuje; počet je nejvyšší
  // nalezený. Pořadí `Map` je pořadí prvního výskytu — tedy pořadí věty.
  const found = new Map<string, {role: WordRole; count: number}>();
  for (const [index, token] of tokens.entries()) {
    const lemma = singular(token);
    const role = LEXICON.get(lemma);
    if (role === undefined || (lemma !== token && index > 0 && PRONOUNS.has(tokens[index - 1]!))) continue;
    const count = countBefore(tokens, index, lemma !== token);
    const seen = found.get(lemma);
    if (seen === undefined) found.set(lemma, {role, count});
    else seen.count = Math.max(seen.count, count);
  }
  if (found.size === 0) return null;

  const ground: PlannedObject[] = [];
  const movable: PlannedObject[] = [];
  for (const [lemma, {role, count}] of found) {
    for (let n = 1; n <= count; n += 1) {
      const object: PlannedObject = {stableId: `word-${lemma}-${String(n)}`, label: lemma, synonyms: [], role: ROLE_OF[role], importance: IMPORTANCE_OF[role]};
      (role === 'place' || role === 'terrain' ? ground : movable).push(object);
    }
  }

  // Fisher–Yates nad semínkem relace: táž věta, jiná relace, jiná mřížka.
  const stream = xoroshiro128plus(options.sessionSeed);
  for (let i = movable.length - 1; i > 0; i -= 1) {
    const j = uniformInt(stream, 0, i);
    [movable[i], movable[j]] = [movable[j]!, movable[i]!];
  }
  const objects = [...ground, ...movable].slice(0, MAX_OBJECTS);

  return {
    intent: {
      setting: sentence,
      mood: 'unknown',
      spatialThesis: 'One block per object noun in the sentence; no layout was read.',
      actors: [],
      heroObjects: [...new Set(objects.filter((object) => object.role === 'hero').map((object) => object.label))],
      interactions: [],
      unsupported: [],
    },
    objects,
  };
}
