/**
 * Lexikon návrhu ze slov (P23-B T2): které slovo věty ukazuje na který
 * archetyp, jak se čtou čísla a odkud se berou role.
 *
 * Je to tabulka, ne model. Cíl není rozumět větě, ale dát hráči za pár
 * milisekund hratelný spec, který model potom **opraví** místo aby ho psal
 * od nuly. Každý vzor je proto krátký, anglický a testovaný na zlatém korpusu
 * (`evals/play/golden`) – trefu archetypu drží `__tests__/draft.test.ts`
 * jako pin skutečného čísla, ne jako cíl.
 */

import type { ArchetypeId } from '../registry';

/** Věta o plížení: stráže s výhledem místo slepých hlídek. */
export const STEALTH =
  /\bsneak(?:s|ing|y)?\b|\bstealth(?:y)?\b|\bguards?\b|\bunseen\b|\bundetected\b|\bwithout (?:being )?(?:seen|spotted|caught|noticed|waking)\b|\bhid(?:e|es|ing)\b|\bflashlights?\b/;

/**
 * Červená–zelená (`timer.phases`, P25D T1): hýbat se smíš, jen když se hlídač
 * nedívá. Squid Game i horor „hýbe se, když se nedíváš“ jsou tatáž hra.
 */
export const RED_LIGHT =
  /\bred light\b|\bgreen light\b|\bsquid games?\b|\bwhen (?:you|u) (?:look away|turn away|(?:don'?t|do not|aren'?t|are not) (?:look|watch)(?:ing)?)\b|\bfreddy'?s?\b|\bfnaf\b|\b(?:musical |play(?:ing)? )statues\b|\bstatues? game\b/;

/**
 * Hledání (`collectible.hiddenIn`, P25D T2): předměty leží ve skrýších a
 * objeví se, až je hráč prohledá. Jen mění sběr, archetyp nevybírá.
 */
export const SEARCH = /\bhidden\b|\bhide and seek\b|\bexplor(?:e|es|ing)\b|\bruins?\b|\bsearch(?:es|ing)?\b/;

/** Hledání pod hladinou (s184): relikvie v troskách, cíl je vyplavat. */
export const UNDERWATER = /\bunder ?water\b|\bsunken\b|\bunder the sea\b|\bocean\b|\bsubmarine\b|\bshipwreck\b/;

/**
 * Ošetřování (P25D T5, s169): objednávky `carry.menu` přejmenované na léčbu –
 * hráč vezme lék nebo obvaz a donese ho zvířeti, které ho potřebuje.
 * Skupina 1 = kdo je pacient.
 */
export const CARE =
  /\b(?:vet|vets|veterinar(?:y|ian)|animal hospital|pet clinic)\b|\b(?:heal(?:s|ing)?|cure(?:s|ing)?|treat(?:s|ing)?|nurs(?:e|es|ing)|care for) (?:the |cute |sick |injured |hurt )*(pets?|animals?|patients?|puppies|puppy|kittens?|dogs?|cats?)\b/;

/**
 * Ničení a pukání (P25D T4, s097, s198): `defeat` bez nepřátel – `use` cíl
 * odstraní a přičte, poslední zničený vyhraje. Skupina 1 = „pop“.
 */
export const SMASH = /\b(pop(?:s|ping)? (?:stuff|things|everything|all|bubbles?|balloons?)|bubble ?(?:pop|wrap)|pop(?:ping)? game)\b|\bsmash(?:es|ing)?\b|\bdestroy everything\b|\bwreck(?:s|ing)?\b|\bbreak everything\b/;

/**
 * Vágní klidné věty (P25D T7, s195–s197): sběr bez nepřátel s barevným
 * tématem. `KID_FRIENDLY` vybere barevné téma, jinak útulné.
 */
export const GENTLE = /\b(?:relax(?:ing|ed)?|chill|calm|peaceful|soothing|cozy|cosy|wholesome)\b/;
export const KID_FRIENDLY = /\bcolou?rful\b|\bfor (?:my )?(?:little |baby |younger )?(?:sister|brother|kids?|child|children|daughter|son|toddler)\b/;

/** Přechod po leknínech (P25D T6, s034). */
export const LILY_PADS = /\blily ?pads?\b|\bstepping stones? (?:across|over) (?:a |the )?(?:pond|river|stream|water)\b/;

/** Přechod silnice (P25D T6, s036): auta přeskakují mezi pruhy. */
export const ROAD = /\bcrossy road\b|\bfrogger\b|\bcross(?:es|ing)? (?:the |an? )?(?:endless |busy |big )?(?:road|street|highway|traffic)\b/;

/** Pohyblivé zdi (`hazard_zone.pulse.alternate`, P25D T3, s076). */
export const MOVING_WALLS = /\b(?:walls?|hedges?) (?:that |which )?(?:move|moves|moving|shift|shifts|shifting|slide|slides|sliding)\b|\b(?:moving|shifting|sliding) (?:walls?|maze|labyrinth)\b/;

/** Hlídač červené–zelené, když ho věta jmenuje; skupina 1 = popisek. */
export const WATCHER = /\b((?:creepy |giant |haunted |old |evil )?(?:doll|statue|animatronic|mannequin|puppet|clown))s?\b/;

/** Hádanka pořadí: spínače jdou zapnout jen v daném pořadí (`switch.ordered`). */
export const ORDER_PUZZLE = /\bin (?:the )?(?:right|correct|exact) order\b/;

/** Obsluha zákazníků (`carry.menu`): vaření, restaurace, obchod, farma na prodej. */
export const ORDERS =
  /\bcook(?:s|ing)?\b|\bcustomers?\b|\borders\b|\btakes? (?:an? )?orders?\b|\brestaurant\b|\bbarista\b|\bovercooked\b|\bserv(?:e|es|ing)\b|\bdiner\b|\bcaf[eé]\b|\bfood truck\b|\bkitchen\b|\bsupermarket\b|\bcheckout\b|\bcashier\b|\bsell(?:s|ing)?\b|\bharvest(?:s|ing)?\b/;

/** Jídla, která věta objednávek může jmenovat (menu); dort a vejce chybí schválně – to je křehké nesení. */
export const FOODS = ['burger', 'fries', 'pizza', 'sushi', 'coffee', 'latte', 'tea', 'taco', 'salad', 'soup', 'carrot', 'apple', 'bread', 'noodles', 'sandwich', 'milk'] as const;
export const FOOD = new RegExp(`\\b(?:${FOODS.join('|')})s?\\b`);

/** Bedny tlačené na desky (`switch.crateRole`); skupina 1 = podstatné jméno bedny. */
export const PUSH_CRATES = /\bpush(?:es|ing)? (?:the |a )?(?:[a-z]+ )?(box|boxes|crates?|blocks?|boulders?)\b/;

/** Slova, po kterých se archetyp pozná. Každý zásah je jeden bod; remíza jde pořadím `ARCHETYPE_IDS`. */
export const ARCHETYPE_CUES: Readonly<Record<ArchetypeId, readonly RegExp[]>> = {
  collect_exit: [
    /\bcollect(?:s|ing)?\b/,
    /\bgather(?:s|ing)?\b/,
    /\bfind(?:s|ing)?\b/,
    /\bpick(?:s|ing)? up\b/,
    /\bgrab(?:s|bing)?\b/,
    // Plížení (P25B T3) je sběr s hlídkami, které vidí – „steal the diamond and get out“.
    /\bsteal(?:s|ing)?\b/,
    STEALTH,
    RED_LIGHT,
  ],
  chase_escape: [
    /\bchas(?:e|es|ed|ing)\b/,
    /\bhunt(?:s|ed|ing)?\b/,
    /\bescap(?:e|es|ed|ing)\b/,
    /\bfle(?:e|es|d|eing)\b/,
    /\bpursu(?:e|es|ed|ing|er|it)\b/,
    /\bcatch(?:es)?\b/,
  ],
  survival_timer: [/\bsurviv(?:e|es|ed|ing|al)\b/, /\bseconds?\b/, /\bminutes?\b/, /\blast(?:s|ing)?\b/, /\boutlast(?:s)?\b/, /\bstay alive\b/],
  checkpoint_race: [/\brac(?:e|es|ing)\b/, /\bgates\b/, /\bcheckpoints?\b/, /\bin (?:the right )?order\b/, /\blaps?\b/, /\bhoops\b/, /\brings\b/, /\bsprint(?:s|ing)?\b/],
  delivery: [/\bcarry(?:ing)?\b|\bcarries\b/, /\bdeliver(?:s|ed|ing)?\b/, /\bbring(?:s|ing)?\b/, /\bfragile\b/, ORDERS, FOOD, CARE],
  switch_puzzle: [/\bpress(?:es|ing)?\b/, /\bbuttons?\b/, /\bswitch(?:es)?\b/, /\blevers?\b/, /\bnot\b|\bnever\b/, /\bflip(?:s|ping)?\b|\btoggle(?:s|d)?\b|\bpull(?:s|ing)?\b/,
    // P25B T4: „shoď věci v pořadí“ je hádanka pořadí, ne závod – dva body přebijí `checkpoint_race`.
    /\bknock(?:s|ed|ing)? (?:[a-z]+ ){1,3}off\b/,
    ORDER_PUZZLE,
    PUSH_CRATES,
  ],
  hazard_crossing: [
    /\bcross(?:es|ing)?\b/,
    /\blava\b|\bmagma\b|\bacid\b/,
    /\bislands?\b/,
    /\bfloating\b/,
    /\bjump(?:s|ing)?\b|\bhop(?:s|ping)?\b/,
    /\bstepping\b/,
    /\bcracks?\b/,
  ],
  combat_lite: [/\bdefeat(?:s|ed|ing)?\b/, /\bknock(?:s|ed|ing)? out\b/, /\bhit(?:s|ting)?\b/, /\bdestroy(?:s|ed|ing)?\b/, /\btargets?\b/, SMASH],
};

/** Číslovky one..twenty a pár velkých; číslice se čtou přímo. */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
};

const NUMBER_TOKEN = `(\\d+|${Object.keys(NUMBER_WORDS).join('|')})`;

export interface SentenceNumbers {
  /** Sekundy z „N seconds" / „N minutes" / „two-minute"; `null` bez údaje. */
  readonly seconds: number | null;
  /** Ostatní čísla v pořadí výskytu (počty věcí). */
  readonly counts: readonly number[];
}

function toNumber(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
}

export function readNumbers(sentence: string): SentenceNumbers {
  const text = sentence.toLowerCase();
  let seconds: number | null = null;
  const time = new RegExp(`${NUMBER_TOKEN}[ -](seconds?|minutes?)\\b`).exec(text);
  if (time !== null) seconds = toNumber(time[1]) * (time[2].startsWith('minute') ? 60 : 1);
  const counts: number[] = [];
  // „one million" je jedno číslo: násobitel hned za číslovkou ji násobí, nestojí sám.
  const all = new RegExp(`\\b${NUMBER_TOKEN}(?: (hundred|thousand|million))?\\b(?![ -](?:seconds?|minutes?)\\b)`, 'g');
  for (const match of text.matchAll(all)) counts.push(toNumber(match[1]) * (match[2] === undefined ? 1 : NUMBER_WORDS[match[2]]));
  return { seconds, counts };
}

/**
 * Počty s podstatným jménem („five coins“, „10 big rocks“) pro arkádu (P26D T9):
 * číslo, nejvýš jedno přídavné jméno a podstatné jméno v množném čísle.
 */
export function readCountedNouns(sentence: string): readonly { readonly count: number; readonly noun: string }[] {
  const pattern = new RegExp(`\\b${NUMBER_TOKEN} (?:[a-z]+ )?([a-z]+s)\\b`, 'g');
  return [...sentence.toLowerCase().matchAll(pattern)].map((match) => ({ count: toNumber(match[1]), noun: match[2] }));
}

/** Slova, na kterých končí jmenná fráze role. */
const PHRASE_STOP = new Set([
  // Modální a pomocná slovesa – za podmětem („A knight must collect…“), nikdy součást jména.
  'must',
  'can',
  'will',
  'should',
  'has',
  'have',
  'is',
  'are',
  'gets',
  'wants',
  'tries',
  'in',
  'on',
  'at',
  'to',
  'from',
  'of',
  'into',
  'through',
  'across',
  'over',
  'under',
  'behind',
  'before',
  'after',
  'while',
  'until',
  'then',
  'and',
  'but',
  'or',
  'so',
  'that',
  'which',
  'who',
  'with',
  'without',
  'hidden',
  'it',
  'you',
  'me',
  'them',
  'as',
  'by',
  'for',
  'when',
  'where',
  'among',
  'around',
  'between',
]);

const ARTICLES = /^(?:a|an|the|all|every|each|some|its|your|my|our)\s+/;
const NUMBER_PREFIX = new RegExp(`^${NUMBER_TOKEN}\\s+`);

/** Podstatná jména na -ing; ostatní slova na -ing za hlavou fráze jsou sloveso („hamster escaping“). */
const ING_NOUNS = new Set(['king', 'ring', 'thing', 'wing', 'string', 'building', 'ceiling', 'swing', 'sling', 'spring', 'pudding', 'viking', 'dumpling', 'painting', 'clothing', 'earring', 'icing', 'railing', 'duckling', 'sibling', 'clearing']);

const isVerbIng = (word: string): boolean => word.length > 4 && word.endsWith('ing') && !ING_NOUNS.has(word);

/** Prvních nejvýš `max` slov po členu a číslovce, do zarážky, interpunkce nebo slovesa v -ing. */
export function nounPhrase(text: string, max = 3): string | null {
  let rest = text.trim().toLowerCase().replace(ARTICLES, '').replace(NUMBER_PREFIX, '').replace(ARTICLES, '');
  const words: string[] = [];
  for (const raw of rest.split(/\s+/)) {
    const word = raw.replace(/[^a-z-]/g, '');
    const punctuated = /[.,;:!?]$/.test(raw);
    if (word === '' || PHRASE_STOP.has(word) || NUMBER_WORDS[word] !== undefined || (words.length > 0 && isVerbIng(word))) break;
    words.push(word);
    if (punctuated || words.length === max) break;
  }
  rest = words.join(' ');
  return rest === '' ? null : rest;
}

/** Jednotné číslo na -ie, ne -y: `zombies → zombie`, ne `zomby`. */
const IE_NOUNS = new Set(['zombies', 'cookies', 'movies', 'pies', 'ties', 'brownies', 'hippies', 'rookies', 'goalies', 'genies', 'pixies', 'hoodies', 'birdies', 'smoothies', 'veggies', 'doggies', 'selfies', 'magpies']);

/** Množná čísla, která pravidla níž zkazí („wolves“ → „wolve“, „mice“ zůstane). */
const IRREGULAR: Readonly<Record<string, string>> = {
  wolves: 'wolf', elves: 'elf', shelves: 'shelf', calves: 'calf', halves: 'half', knives: 'knife', wives: 'wife', lives: 'life',
  leaves: 'leaf', thieves: 'thief', loaves: 'loaf', scarves: 'scarf', dwarves: 'dwarf', mice: 'mouse', geese: 'goose',
  children: 'child', people: 'person', teeth: 'tooth', feet: 'foot',
  buses: 'bus', viruses: 'virus', octopuses: 'octopus', cactuses: 'cactus', walruses: 'walrus', circuses: 'circus', gases: 'gas', lenses: 'lens',
};

/** Jednotná čísla na -s, která ho neztratí: „cyclops“ není množné číslo „cyclop“. */
const SINGULAR_S = new Set(['cyclops', 'lens', 'gas', 'atlas', 'iris', 'chaos', 'canvas', 'species', 'series', 'tennis', 'news', 'rhinoceros']);

/**
 * Hrubé jednotné číslo pro `label`: `coins → coin`, `dummies → dummy`, `boxes → box`, `horses → horse`.
 * Slovo na -us („octopus“, „bus“), jednotné číslo na -s („cyclops“) a vlastní jméno z velkého
 * písmene („Thomas“) zůstanou. Druhé volání nic nezmění – draft ho na popisek pouští dvakrát.
 */
export function singular(phrase: string): string {
  const words = phrase.split(' ');
  const last = words[words.length - 1];
  return [...words.slice(0, -1), singularWord(last)].join(' ');
}

function singularWord(word: string): string {
  if (IRREGULAR[word] !== undefined) return IRREGULAR[word];
  if (word.endsWith('us') || SINGULAR_S.has(word) || /^[A-Z]/.test(word)) return word;
  if (IE_NOUNS.has(word)) return word.slice(0, -1);
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  // „horses“, „houses“ ztratí jen -s; -es jen po sykavce, kterou -s samo nenese („glasses“, „boxes“, „torches“).
  if (/(?:sses|xes|ches|shes|zzes)$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** Slovesa, jejichž předmět hráč drží nebo vrhá („sprays water“, „throws snowballs“); tvar -ing i minulý. */
const TOOL_USE = /\b(?:spray|squirt|pour|splash|sprinkle|throw|toss|fling|hurl|lob|swing|wield|cast|us(?=e|ing))(?:s|es|e|ed|d|ing)? (?:the |a |an |some |his |her |its |their )?([a-z][a-z -]*)/;
/** „shoots arrows at goblins“: předmět střelby je nástroj jen s cílem za ním, jinak je terčem („shoot the zombies“). */
const TOOL_AIMED = /\b(?:shoot|fire|launch)(?:s|es|ed|ing)? (?:the |a |an |some |his |her |its |their )?([a-z][a-z -]*?) (?:at|on|into|toward|towards)\b/;

/**
 * Věc, kterou hráč ve větě používá (P32B T7): předmět slovesa nástroje, jednotné
 * číslo. Nepřítel, pronásledovatel ani nástraha to nikdy není – hasič, který
 * „sprays water“, před vodou neutíká. `null` = věta žádný nástroj neříká.
 */
export function toolOf(sentence: string): string | null {
  const text = withoutPossessor(sentence.toLowerCase().replace(/\s+/g, ' ').trim());
  const said = TOOL_USE.exec(text)?.[1] ?? TOOL_AIMED.exec(text)?.[1];
  const phrase = said === undefined ? null : nounPhrase(said, 2);
  return phrase === null ? null : singular(phrase);
}

export interface SentenceRoles {
  readonly player: string | null;
  readonly chaser: string | null;
  readonly collectible: string | null;
  /** Sbíraná věc je ve větě v množném čísle („steal cookies“); „steal a diamond“ = jeden kus. */
  readonly collectibleMany: boolean;
  /** Věta mluví o plížení (`STEALTH`). */
  readonly stealth: boolean;
  readonly item: string | null;
  readonly destination: string | null;
  readonly target: string | null;
  readonly checkpoint: string | null;
  readonly hazard: string | null;
  /**
   * Nepřítel, kterému se hráč vyhýbá: „while dodging ghosts“ → hlídka,
   * „while a ghost hunts you“ → pronásledovatel. `plural` = věta mluví o víc kusech.
   */
  readonly threat: { readonly label: string; readonly mover: 'patrol' | 'chaser'; readonly plural: boolean } | null;
  /** Spínače podle barev; `required` jsou ty před „but not / never". */
  readonly switches: { readonly all: readonly string[]; readonly required: readonly string[] } | null;
  readonly setting: string | null;
}

const COLOURS = ['red', 'blue', 'green', 'yellow', 'orange', 'white', 'black', 'gold', 'golden', 'silver', 'pink'];
const HAZARD_WORDS = /\b(lava|magma|acid|spikes?|fire|flames?|red tiles|red floor tiles|searchlights?|lasers?|ice|thin ice|pits?|holes?|water|electric floor|poison)\b/;

function first(text: string, patterns: readonly RegExp[], max = 3): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) {
      const phrase = nounPhrase(match[1], max);
      if (phrase !== null) return phrase;
    }
  }
  return null;
}

/** Hlava fráze na začátku věty, která jmenuje žánr nebo míru, ne postavu („a platformer where…“, „a lot of“). */
const NOT_A_CHARACTER = new Set([
  'game', 'games', 'shooter', 'runner', 'platformer', 'puzzle', 'racer', 'racing', 'sim', 'simulator', 'clicker', 'style', 'version',
  'level', 'levels', 'obby', 'rpg', 'mode', 'map', 'idle', 'tycoon', 'roguelike', 'fps', 'arcade', 'app', 'story', 'adventure',
  'battle', 'fight', 'duel', 'race', 'course', 'parkour', 'lot', 'bit', 'kind', 'sort', 'type', 'endless', 'infinite', 'hard', 'easy',
  'simple', 'fun', 'cool', 'new', 'little', 'big', 'long', 'short', 'first', 'second', 'third', 'person', 'player',
  'away', 'here', 'there', 'not', 'so', 'very', 'bored', 'gonna', 'going',
  // „The floor is lava“ – povrch, po kterém se hraje, ne hrdina.
  'floor', 'ground',
]);

/** Slova žánru, u kterých podmět končí. */
const GENRE_HEADS = new Set([
  'game', 'games', 'shooter', 'runner', 'platformer', 'puzzle', 'racer', 'racing', 'sim', 'simulator', 'clicker', 'obby', 'rpg',
  'tycoon', 'roguelike', 'fps', 'arcade', 'adventure',
]);
/** Žánry, před kterými stojí hrdina („corgi runner“, „goat simulator“); u ostatních předchozí slovo jmenuje terč nebo místo. */
const PLAYER_GENRES = new Set(['runner', 'platformer', 'racer', 'sim', 'simulator', 'adventure']);

/** Rozhoduje hlava fráze (poslední slovo): „little submarine“ je postava, „hard platformer“ ne. */
const aCharacter = (phrase: string | null): string | null =>
  phrase === null || NOT_A_CHARACTER.has(phrase.split(' ').at(-1) ?? '') ? null : phrase;

/**
 * Podmět před prvním slovesem (P26 T9): „A penguin slides down…“ → penguin,
 * „a squirrel jumping…“ → squirrel. Po členu `a/an` je slovo na -s za
 * jednotnou hlavou sloveso třetí osoby; fráze, která jmenuje žánr, je `null`.
 */
function subjectOf(text: string): string | null {
  const match = /^(?:a|an|the|my|one) ([a-z0-9][a-z0-9' -]*)/.exec(text);
  if (match === null) return null;
  // „A gold mine where I hire…“, „a match 3 game“ – místo nebo žánr, ne postava.
  if (match[1].split(' ').slice(0, 4).some((word) => word === 'where' || word === 'game' || word === 'games')) return null;
  const phrase = nounPhrase(match[1], 3);
  if (phrase === null) return null;
  const words: string[] = [];
  for (const word of phrase.split(' ')) {
    const previous = words.at(-1);
    if (previous !== undefined && /[^s]s$/.test(word) && !previous.endsWith('s')) break;
    words.push(word);
  }
  // P26D T1: „a corgi runner“ → corgi; „a space shooter“ jmenuje terč, ne hrdinu.
  const genre = words.findIndex((word) => GENRE_HEADS.has(word));
  if (genre >= 0) return PLAYER_GENRES.has(words[genre]) && genre > 0 ? aCharacter(words.slice(0, genre).slice(-2).join(' ')) : null;
  return aCharacter(words.slice(-2).join(' '));
}

/** Slovo po „'s“, před kterým jde o stažené „is“, ne o vlastníka: „the game's over“, „the dog's not“. */
const IS_NEXT = /^(?:a|an|the|my|your|his|her|our|their|this|that|not|no|so|very|too|all|just|still|now|really|always|never|about|over|on|off|out|up|down|back|gone|done|here|there|coming|going|getting)$/;

/**
 * „the farmer's dog“ → „the dog“ (B-R1): dělení na slova by přivlastňovací „'s“
 * rozlomilo a role by byla „s dog“. Stažené tvary zájmen („it's“, „there's“) zůstanou;
 * stažené „is“ po podstatném jménu se rozvine (B-R11): „the game's over“ → „the game is over“,
 * „the floor's lava“ → „the floor is lava“.
 */
export const withoutPossessor = (text: string): string =>
  text.replace(/\b([a-z]+)['’]s\s+(?=([a-z]+))/g, (match, owner: string, next: string) =>
    /^(?:it|that|there|here|what|who|he|she|let|where|how)$/.test(owner)
      ? match
      : IS_NEXT.test(next) || (/^(?:floor|ground)$/.test(owner) && HAZARD_WORDS.test(next))
        ? `${owner} is `
        : '',
  );

export function readRoles(sentence: string): SentenceRoles {
  const text = withoutPossessor(sentence.toLowerCase().replace(/\s+/g, ' ').trim());
  const player =
    aCharacter(first(text, [
      /\b(?:i'?m|i am|you are|you're|youre|ur|play as|playing as|as|you play|you control|control|be|become) (?:a |an |the )([a-z][a-z -]*)/,
      // Vozidlo, které hráč řídí, je jeho postava („fly a paper plane through a house“).
      /^(?:drive|fly|ride|steer|pilot) (?:a |an |the )([a-z][a-z -]*)/,
      /\b(?:i'?m|i am|you are|you're|play as|playing as) ([a-z][a-z -]*)/,
    ], 2)) ?? subjectOf(text);
  const chaser = first(text, [
    /\b([a-z]+(?: [a-z]+)?) (?:hunts|chases|pursues|catches|follows|stalks) (?:it|you|me|them|him|her|the player)\b/,
    /\b(?:hunted|chased|pursued|followed) by (?:a |an |the )?([a-z][a-z -]*)/,
    /\b(?:flees|escapes|escape|flee|run from|runs from|outrun|outruns) (?:from )?(?:a |an |the )?([a-z][a-z -]*)/,
  ], 2);
  const collectible = first(text, [/\b(?:collect|gather|find|pick up|grab|steal)(?:s|ing)? (?:all |every )?(?:of )?(?:the )?((?:\d+ |[a-z]+ )?[a-z][a-z -]*)/], 2);
  const delivery = /\b(?:carry|deliver|bring|take|escort)s? (?:a |an |the )?([a-z][a-z -]*?) (?:from (?:a |an |the )?[a-z][a-z -]*? )?(?:across (?:a |an |the )?[a-z][a-z -]*? )?to (?:a |an |the )?([a-z][a-z -]*)/.exec(text);
  const target = first(text, [
    /\b(?:defeat|destroy|knock out|knock down|hit|smash|beat)s? (?:all |every |the )?(?:of )?(?:the )?((?:\d+ |[a-z]+ )?[a-z][a-z -]*)/,
    // P26 T12: co se střílí a na co se hází, jmenuje terč a nepřítele arkády („shoot the zombies“, „throw balls at ducks“).
    // T7: s „at“ je terčem to za ním, předmět je nástroj („shoots arrows at goblins“).
    /\b(?:throw|toss|aim|fire|shoot|blast|launch)(?:s|es|ing)? (?:[a-z]+ ){0,2}?at (?!(?:night|dawn|dusk|noon|midnight|sunset|sunrise|home|school|sea|once)\b)(?:the |a |an )?([a-z][a-z -]*)/,
    /\b(?:shoot|blast|zap)(?:s|ing)? (?:down )?(?:all |every |the )?([a-z][a-z -]*)/,
    /\bagainst (?:the |a |an )?([a-z][a-z -]*)/,
  ], 2);
  const checkpointMatch = /(?:[a-z]+ )?((?:[a-z]+ )?(?:gates?|hoops?|rings?|checkpoints?|flags?|arches?|posts?))\b/.exec(text);
  // Co hráč stříká nebo hází, není nástraha („sprays water“, „throws water balloons“).
  const tool = toolOf(text)?.split(' ') ?? [];
  const hazardMatch = [...text.matchAll(new RegExp(HAZARD_WORDS.source, 'g'))].find((match) => !tool.includes(singular(match[1]))) ?? null;
  const colours = COLOURS.filter((colour) => new RegExp(`\\b${colour}\\b`).test(text));
  let switches: SentenceRoles['switches'] = null;
  if (colours.length >= 2) {
    const negated = /\b(?:but not|not|never(?: touch)?|except|avoid) ([a-z ,]+)/.exec(text);
    const excluded = negated === null ? [] : colours.filter((colour) => new RegExp(`\\b${colour}\\b`).test(negated[1]));
    const required = colours.filter((colour) => !excluded.includes(colour));
    switches = { all: colours, required: required.length > 0 ? required : colours.slice(0, 1) };
  }
  const setting = first(text, [/\b(?:in|inside|across|through|on|around|at|into) (?:a |an |the )?([a-z][a-z -]*)/]);
  // Vyhýbání se nebezpečné ploše („avoid the lava“) je hazard, ne postava.
  const dodged = first(text, [
    /\b(?:dodg|avoid|evad)(?:e|es|ed|ing)? (?:the |a |an |all |any )?([a-z][a-z -]*)/,
    /\b(?:sneak(?:s|ing)? past|without waking) (?:the |a |an |all |any )?([a-z][a-z -]*)/,
  ], 2);
  const threatNoun = chaser ?? (dodged !== null && !HAZARD_WORDS.test(dodged) ? dodged : null);
  const threat: SentenceRoles['threat'] =
    threatNoun === null ? null : { label: singular(threatNoun), mover: chaser !== null ? 'chaser' : 'patrol', plural: singular(threatNoun) !== threatNoun };
  return {
    player,
    chaser,
    collectible: collectible === null ? null : singular(collectible),
    collectibleMany: collectible !== null && singular(collectible) !== collectible,
    stealth: STEALTH.test(text),
    item: delivery === null ? null : nounPhrase(delivery[1]),
    destination: delivery === null ? null : nounPhrase(delivery[2]),
    target: target === null ? null : singular(target),
    checkpoint: checkpointMatch === null ? null : singular(nounPhrase(checkpointMatch[1]) ?? checkpointMatch[1]),
    hazard: hazardMatch === null ? null : hazardMatch[1],
    threat,
    switches,
    setting,
  };
}

/** Skóre archetypů nad větou – počet zásahů cue; číslovka přidává bod sběru. */
export function scoreArchetypes(sentence: string): Readonly<Record<ArchetypeId, number>> {
  const text = sentence.toLowerCase();
  const numbers = readNumbers(sentence);
  const scores = {} as Record<ArchetypeId, number>;
  for (const id of Object.keys(ARCHETYPE_CUES) as ArchetypeId[]) {
    scores[id] = ARCHETYPE_CUES[id].filter((cue) => cue.test(text)).length;
  }
  if (scores.collect_exit > 0 && numbers.counts.length > 0) scores.collect_exit += 1;
  return scores;
}

/** Opak `singular` pro věty hráči: `dummy → dummies`, `box → boxes`, `gate → gates`. */
export function plural(phrase: string, count: number): string {
  if (count === 1) return phrase;
  const words = phrase.split(' ');
  const last = words[words.length - 1];
  const many = /[^aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies` : /(?:s|x|ch|sh)$/.test(last) ? `${last}es` : `${last}s`;
  return [...words.slice(0, -1), many].join(' ');
}
