/**
 * Klasifikátor žánru (P32B T1): věta → pořadí všech žánrů a režimů.
 *
 * Skóre skládá tři zdroje:
 * - **slovesa věty** z tabulky `VERBS` – hlavní sloveso +4, každé další +1;
 * - **narážky modulů** (`GenreModule.cues`) – +1 každému režimu žánru;
 * - **čtení modelem** (`Reading`) – třída hlavního slovesa +2, pronásledovatel +1.
 *
 * Hlavní je sloveso, které nese cíl nebo výhru: úkol (zapal, uhas, uvař, bojuj,
 * přistaň) přebije pohyb (jeď, pluj, skoč), pohyb přebije sběr a sběr útěk.
 * Sběr nemá vlastní žánr: s pohybem vpřed jde s pohybem („slides … collects“
 * je běžec), s pronásledovatelem je útěk, jinak sběr v Aréně.
 *
 * Režim s `availability = 'fallback'` je první jen tehdy, když žádný `ready`
 * režim nic neslyšel; výsledek to pak říká (`fallback: true`). Oprava režiséra
 * bere `ranked` jako pořadí, ve kterém zkouší další žánr.
 */

import type { Reading, VerbClass } from '../read/schema';

import { GENRES, GENRE_MODES, type GenreId, type GenreMode, type GenreModule } from './contract';
import { FAMILIES } from './families';
import { GENRE_MODULES } from './index';

export interface GenreChoice {
  readonly genre: GenreId;
  readonly mode: GenreMode;
  readonly score: number;
  /** Co skóre přineslo, anglicky pro panel čtení („main verb "light", cue "light"“). */
  readonly why: string;
}

export interface GenreRanking {
  /** Všechny režimy všech žánrů, nejlepší první. */
  readonly ranked: readonly GenreChoice[];
  /** První režim hraje náhradu (`availability = 'fallback'`), protože nic jiného neslyšel. */
  readonly fallback: boolean;
  /** Hlavní sloveso věty (základní tvar), `null` když věta žádné z tabulky nemá. */
  readonly verb: string | null;
  /** Zbytek věty za hlavním slovesem – tam začíná jeho předmět („… candles before the ghosts“). */
  readonly after: string | null;
  /** Režim, který hlavní sloveso podle tabulky `VERBS` hraje; `null` když věta žádné z tabulky nemá. Čte ho kontrola věrnosti. */
  readonly pick: { readonly genre: GenreId; readonly mode: GenreMode } | null;
  /** Druhé sloveso hráče, které jede na pohybu hlavního slovesa (P38: skok + střelba); `null` když žádné. */
  readonly ride: 'shoot' | null;
}

export type GenreModules = { readonly [G in GenreId]: GenreModule<G> };

type Pair = { readonly genre: GenreId; readonly mode: GenreMode };
/** Úkol > pohyb > sběr > útěk – pořadí, ve kterém sloveso nese cíl věty. */
type Kind = 'goal' | 'move' | 'pickup' | 'chase';

const pair = (genre: GenreId, mode: GenreMode): Pair => ({ genre, mode });
const RUNNER = pair('runner', 'default');
const PLATFORMER = pair('platformer', 'default');
const ESCAPE = pair('arena', 'escape');
const COLLECT = pair('arena', 'collect');
const FIGHT = pair('arena', 'fight');
const RACE = pair('voyage', 'race');
const LAND = pair('voyage', 'land');
const SPATIAL = pair('quest', 'spatial');
const STATION = pair('quest', 'station');
const SHOOTER = pair('shooter', 'default');
const THROW = pair('throw', 'default');
const STACK = pair('timing', 'stack');
const PRECISION = pair('timing', 'precision');
const BRIDGE = pair('timing', 'bridge');
const RHYTHM = pair('rhythm', 'default');
const DUEL = pair('duel', 'default');
const FLAP = pair('flap', 'default');

interface Verb {
  /** Základní tvar – ten se vrací jako `verb` a čte ho kontrola věrnosti. */
  readonly verb: string;
  readonly kind: Kind;
  /** Sběr (`pickup`) žánr nemá, dostane ho podle zbytku věty. */
  readonly pick: Pair | null;
  readonly pattern: RegExp;
}

const OBJECT = String.raw`(?:the|a|an|all|every|each|some|\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)\b`;
const PRONOUN = String.raw`(?:it|you|me|him|her|them|us|the player)\b`;

const v = (verb: string, kind: Kind, pick: Pair | null, pattern: RegExp): Verb => ({ verb, kind, pick, pattern });

const VERBS: readonly Verb[] = [
  // Úkol v prostoru: předměty rozeseté po scéně.
  v('light', 'goal', SPATIAL, new RegExp(String.raw`\b(?:light(?:s|ing)?(?: up)?|ignit(?:e|es|ing)|kindl(?:e|es|ing)) ${OBJECT}|\blight(?:s|ing)?(?: up)?(?= (?:[a-z]+ )?(?:lanterns?|candles?|torches?|lamps?|beacons?|fireworks?|bonfires?|campfires?)\b)`)),
  v('extinguish', 'goal', SPATIAL, /\bextinguish(?:es|ing)?\b|\bput(?:s|ting)? out (?:the )?(?:fires?|flames?|blaze)\b|\bdous(?:e|es|ing)\b|\bspray(?:s|ing)? water\b|\bhos(?:e|es|ing) down\b/),
  v('free', 'goal', SPATIAL, new RegExp(String.raw`\brescu(?:e|es|ing)\b|\b(?:free|frees|freeing|releas(?:e|es|ing)) ${OBJECT}|\bsav(?:e|es|ing)\b(?! (?:money|time|up|for|points?|the day)\b)`)),
  // P37A T4: další slovesa „ke každé věci po scéně dojít“ – vybalit bedny, probudit les, zmrazit vodopád, vyvolat kostlivce.
  v('unpack', 'goal', SPATIAL, /\bunpack(?:s|ing)?\b|\bunbox(?:es|ing)?\b/),
  v('wake', 'goal', SPATIAL, /\bwak(?:e|es|ing) (?:up )?(?:the|a|an|all|every|each|some|his|her|their)\b/),
  v('freeze', 'goal', SPATIAL, /\bfreez(?:e|es|ing) (?:the|a|an|all|every|each|some|\d+)\b/),
  v('raise', 'goal', SPATIAL, /\brais(?:e|es|ing)(?= (?:a |an |the |his |her |their )?(?:[a-z]+ )?(?:army|dead|skeletons?|zombies?|undead)\b)|\bsummon(?:s|ing)?\b/),
  v('press', 'goal', SPATIAL, /\b(?:press(?:es|ing)?|toggl(?:e|es|ing)|flip(?:s|ping)?|pull(?:s|ing)?) (?:[a-z]+ ){0,3}?(?:switch(?:es)?|levers?|buttons?)\b|\bpress(?:es|ing)? (?:red|blue|green|yellow)\b/),
  v('deliver', 'goal', SPATIAL, /\b(?:carr(?:y|ies|ying)|deliver(?:s|ing)?|bring(?:s|ing)?)\b/),
  // Střelba a hod jsou zase vlastní žánry (P36A T10); praskání, rozbíjení a zásah předmětů po scéně zůstávají Úkolem.
  // „auto shooting wand“ (vampire survivors) střílí sám – hráč přežívá a uhýbá, takže rozhodne sloveso pohybu.
  v('shoot', 'goal', SHOOTER, /(?<!auto[ -])\bshoot(?:s|ing|er|ers)?\b(?! stars?)|\bfir(?:e|es|ing) at\b|\bblast(?:s|ing)? (?:the|a|an|all|every|some|\d+)\b|\baim(?:s|ing)? at\b/),
  v('throw', 'goal', THROW, /\bthrow(?:s|ing)?\b(?! punch)|\btoss(?:es|ing)?\b|\bfling(?:s|ing)?\b|\bhurl(?:s|ing)?\b|\blaunch(?:es|ing)?(?= (?:a |an |the |some )?(?:[a-z]+ )?(?:rockets?|balls?|birds?|missiles?|fireworks?|pumpkins?|stones?|rocks?)\b)|\blaunch(?:es|ing)? (?:a|an|the|some)\b|\bbowl(?:s|ing)?\b/),
  v('hit', 'goal', SPATIAL, /\b(?:pop(?:s|ping)?|hit(?:s|ting)?|smash(?:es|ing)?|zap(?:s|ping)?|destroy(?:s|ing)?)\b|\bknock(?:s|ing)? on\b/),
  // Rodiny sloves (P37A T3, T4): úklid, vaření, sekání, řemeslo, zahrada, opravy (dřív sloveso `repair` tady), malování, péče,
  // stříkání, pastevectví, vystoupení a papíry – `families.ts`.
  ...FAMILIES.flatMap((family) => family.members.map((member) => v(member.verb, 'goal', family.pick, member.pattern))),
  // Načasování a rytmus (P36A T11): ťuk ve správnou chvíli. Před `make` – „build the tallest“ začíná na stejném místě jako „build“ a shodu rozhodne pořadí tabulky.
  v('stack', 'goal', STACK, /\bstack(?:s|ing)?\b|\bbuild(?:s|ing)? (?:the |a |an )?(?:tallest|highest|biggest)\b/),
  v('bridge', 'goal', BRIDGE, /\bgrow(?:s|ing)? (?:a |the )?bridge\b|\bstretch(?:es|ing)? (?:a |the )?(?:bridge|stick|pole)\b/),
  v('time', 'goal', PRECISION, /\bat the (?:right|perfect|exact) (?:time|moment|second)\b|\btim(?:e|es|ing) (?:your|his|her|their|each|every)\b|\bstop(?:s|ping)? the (?:moving|swinging|spinning|sliding)\b|\bcut(?:s|ting)? the ropes?\b/),
  v('dance', 'goal', RHYTHM, /\bdanc(?:e|es|ing)\b/),
  v('beat', 'goal', RHYTHM, /\b(?:to|with|on) the (?:beat|music|rhythm)\b|\bto music\b/),
  // Skládačky, stavění, péče a obsluha – sloveso na předmětu na jednom místě.
  v('make', 'goal', STATION, /\b(?:merg(?:e|es|ing)|sort(?:s|ing)?|build(?:s|ing)?|connect(?:s|ing)?|unscrew(?:s|ing)?|untangl(?:e|es|ing)|decorat(?:e|es|ing)|design(?:s|ing)?|harvest(?:s|ing)?|heal(?:s|ing)?|serv(?:e|es|ing)|feed(?:s|ing)?|craft(?:s|ing)?|upgrad(?:e|es|ing)|manag(?:e|es|ing)|hir(?:e|es|ing)|dress(?:es|ing)? up|inflat(?:e|es|ing))\b|\bblow(?:s|ing)? up (?:[a-z]+ )?balloons?\b/),
  // Souboj jeden na jednoho je Souboj (P36A T11); rvačka a box s víc soupeři po scéně zůstávají Arénou.
  v('duel', 'goal', DUEL, /\bduel(?:s|ing|led|ling)?\b/),
  v('play', 'goal', DUEL, /\bplay(?:s|ing)? (?:a game of |a round of )?(?:chess|checkers|draughts|cards|poker|tic[- ]tac[- ]toe)\b/),
  // Spor s protějškem (P37A T4, věty mimo hry): přetahovaná jeden na jednoho – „argue with my wife“, „negotiate a raise with my boss“.
  // Rozhovor bez protivníka („explain quantum physics to my grandma“, „call grandma“) sloveso hry není – hraje ho absurdní přenos (T5).
  v('argue', 'goal', DUEL, /\bargu(?:e|es|ing)\b/),
  v('negotiate', 'goal', DUEL, /\bnegotiat(?:e|es|ing)\b/),
  v('convince', 'goal', DUEL, /\bconvinc(?:e|es|ing)\b|\bpersuad(?:e|es|ing)\b/),
  v('say no', 'goal', DUEL, /\bsay(?:s|ing)? no\b/),
  v('break up', 'goal', DUEL, /\bbreak(?:s|ing)? up with\b|\bbreaking up\b/),
  v('fight', 'goal', FIGHT, /\bfight(?:s|ing)?\b(?! (?:the )?(?:fires?|flames?))|\bbattl(?:e|es|ing)\b|\bwrestl(?:e|es|ing)\b|\bspar(?:s|ring)?\b|\bbrawl(?:s|ing)?\b/),
  v('box', 'goal', FIGHT, /\bboxing\b|\bbox(?:es)? (?:against|with)\b|\bpunch(?:es|ing)?\b|\bkick(?:s|ing)?\b/),
  // „crushes grave robbers“, „stomps through a village“; „candy crush“ je hra, „a crush on“ zamilovanost.
  v('defeat', 'goal', FIGHT, /\bdefeat(?:s|ing)?\b|\bknock(?:s|ing)? out\b|\bbeat(?:s|ing)? up\b|\battack(?:s|ing)?\b|(?<!candy )\bcrush(?:es|ing)?\b(?! on\b)|\bstomp(?:s|ing)?\b|\bsquash(?:es|ing|ed)\b/),
  // „guards its gold hoard“; „the guards“ jsou stráže.
  v('defend', 'goal', FIGHT, /\bdefend(?:s|ing)?\b|\bprotect(?:s|ing)?\b|\bguard(?:s|ing)? (?:its|the|his|her|their|our|my|a|an)\b/),
  v('land', 'goal', LAND, /\blands\b|\blanding\b|\bland (?:on|at|in|safely|softly|gently|the|a|an|it|its)\b|\bto land\b/),
  // Zaparkovat je přistát přesně (P37A T4); „in a windy park“ je místo.
  v('park', 'goal', LAND, /\bparallel park|\bpark(?:s|ing)? (?:my|his|her|their|your|our|the car|a car|the truck|the van|the bus)\b/),
  // Pohyb vpřed.
  v('slide', 'move', RUNNER, /\bslid(?:e|es|ing)\b/),
  v('ski', 'move', RUNNER, /\bski(?:s|ing)?\b|\bsled(?:s|ding)?\b|\bsledg(?:e|es|ing)\b|\bsnowboard(?:s|ing)?\b|\bsurf(?:s|ing)?\b/),
  // „wearing ice skates“ jsou brusle.
  v('skate', 'move', RUNNER, /\bskating\b|\bskat(?:e|es|ed) (?:across|on|down|through|over|around|along|to|past|away)\b|\bgrind(?:s|ing)? (?:the )?rails?\b/),
  v('run', 'move', RUNNER, /\b(?:run|runs|running)\b(?! (?:out|from|away))|\bdash(?:es|ing)?\b|\bsprint(?:s|ing)?\b|\brunner\b/),
  v('jump', 'move', PLATFORMER, /\bjump(?:s|ing|in)?\b|\bhop(?:s|ping)?\b|\bleap(?:s|ing)?\b|\bbounc(?:e|es|ing)\b|\bplatform(?:er|s)?\b/),
  v('climb', 'move', PLATFORMER, /\bclimb(?:s|ing)?\b|\bcross(?:es|ing)? (?:the |a |an )?(?:[a-z]+ )?(?:islands?|platforms?|stones?|lava|river|gaps?|chasms?|pits?)\b/),
  v('sail', 'move', RACE, /\bsail(?:s|ing)?\b|\brow(?:s|ing)? (?:a |the )?(?:[a-z]+ )?boats?\b|\bpaddl(?:e|es|ing)\b|\bcano(?:e|es|eing)\b|\bkayak(?:s|ing)?\b|\bcruis(?:e|es|ing)\b|\bnavigat(?:e|es|ing)\b/),
  v('flap', 'move', FLAP, /\bflap(?:s|ping)?\b|\bflutter(?:s|ing)?\b/),
  // „a phoenix rises from the ashes“: vzlétnout; „rising prices“ pohyb není.
  v('rise', 'move', FLAP, /\bris(?:e|es|ing) (?:from|up|out of|into|above)\b|\bascend(?:s|ing)?\b/),
  v('fly', 'move', RACE, /\bfl(?:y|ies|ying)\b|\bglid(?:e|es|ing)\b|\bsoar(?:s|ing)?\b|\bpilot(?:s|ing)?\b/),
  // „a boring zoom meeting“ je hovor, ne jízda (P37A T5).
  v('drive', 'move', RACE, /\bdriv(?:e|es|ing)\b|\bsteer(?:s|ing)?\b|\brac(?:e|es|ing|er)\b|\bzoom(?:s|ing)?\b(?! (?:meetings?|calls?)\b)/),
  v('ride', 'move', RACE, /\brid(?:e|es|ing)\b|\bgallop(?:s|ing)?\b|\btrot(?:s|ting)?\b/),
  v('walk', 'move', RACE, /\bwalk(?:s|ing)?\b|\bstroll(?:s|ing)?\b|\bwander(?:s|ing)?\b|\btravel(?:s|ling|ing)?\b|\bswim(?:s|ming)?\b/),
  // Sběr – žánr dostane podle zbytku věty.
  v('collect', 'pickup', null, new RegExp(String.raw`\bcollect(?:s|ing)?\b|\bgather(?:s|ing)?\b|\bfind(?:s|ing)?\b|\bpick(?:s|ing)? up\b|\bgrab(?:s|bing)?\b|\beat(?:s|ing)?\b|\bsteal(?:s|ing)?\b|\bcatch(?:es|ing)? (?!${PRONOUN})|\bhoard(?:s|ing)?\b|\bpick(?:s|ing)? (?:[a-z]+ ){0,2}(?:herbs?|flowers?|berries|apples?|fruits?|mushrooms?|cherries|grapes)\b|\bdrag(?:s|ging|ged)\b|\bdrag (?:the|a|an|his|her|their|it|them)\b`)),
  v('search', 'pickup', null, /\bsearch(?:es|ing)?\b|\bexplor(?:e|es|ing)\b|\blook(?:s|ing)? for\b/),
  // Útěk a přežití.
  v('chase', 'chase', ESCAPE, new RegExp(String.raw`\bchas(?:e|es|ed|ing)\b|\bhunt(?:s|ed|ing)?\b|\bpursu(?:e|es|ed|ing)\b|\bstalk(?:s|ing)?\b|\b(?:catch(?:es)?|follow(?:s|ing)?) ${PRONOUN}`)),
  v('escape', 'chase', ESCAPE, /\bescap(?:e|es|ed|ing)\b|\bfle(?:e|es|eing)\b|\bfled\b|\b(?:runs?|running) (?:away )?from\b|\boutrun(?:s)?\b/),
  v('survive', 'chase', ESCAPE, /\bsurviv(?:e|es|ing|al)\b|\boutlast(?:s)?\b|\bstay alive\b/),
  // Čekání a usínání (P37A T4, věty mimo hry) – vlastní slovesa, aby je absurdní přenos (T5) poznal od „survive“.
  v('wait', 'chase', ESCAPE, /\bwait(?:s|ing)? (?:for|in|at|on)\b/),
  v('fall asleep', 'chase', ESCAPE, /\bfall(?:s|ing)? asleep\b/),
  // Vyhnout se (P37A T4): schovat se, proplížit, ignorovat, odmítnout – „hide from my in-laws“, „my cat refusing to take her medicine“.
  v('hide', 'chase', ESCAPE, /\bhid(?:e|es|ing)\b(?! (?:and|&) seek)/),
  v('sneak', 'chase', ESCAPE, /\bsneak(?:s|ing)?\b|\btipto(?:e|es|eing)\b/),
  v('ignore', 'chase', ESCAPE, /\bignor(?:e|es|ing)\b/),
  v('refuse', 'chase', ESCAPE, /\brefus(?:e|es|ing)\b/),
];

/**
 * Jména her a věci, které žánr prozradí bez slovesa („like mario kart“, „a
 * match 3 game“): +2, takže rozhodnou jen věty, kde hlavní sloveso chybí.
 * Hlavním slovesem se nestanou – kontrola věrnosti čte jen slovesa.
 */
const NAMES: readonly (readonly [Pair, RegExp])[] = [
  [RUNNER, /\bsubway surfers?\b|\btemple run\b|\bskateboard(?:s|ing)?\b|\bcrossy road\b|\bfrogger\b|\bcross(?:es|ing)? (?:the |an? )?(?:endless |busy |big )?(?:[a-z]+ )?(?:road|street|highway|lake)\b|\broll(?:s|ing)? (?:down|through)\b/],
  [PLATFORMER, /\bmario\b(?! kart)|\bobby\b|\bparkour\b|\bfall guys\b|\bobstacle course\b|\bsonic\b/],
  [RACE, /\bkarts?\b|\bdrift(?:s|ing)?\b|\bmotorbikes?\b|\bbikes?\b|\bcars?\b|\bboats?\b|\bplanes?\b|\bspaceships?\b|\bsubmarines?\b|\btractors?\b|\bstunts?\b|\bramps?\b/],
  [FLAP, /\bflapp?y\b/],
  [RHYTHM, /\bpiano tiles\b|\bbeat saber\b|\bguitar hero\b|\bthe beat\b|\bdrummers?\b|\bdrums?\b|\bsongs?\b|\bmusic(?:al)?\b|\bdisco\b|\bconcert\b|\bkaraoke\b/],
  [DUEL, /\brivals?\b|\bhigh noon\b|\bshowdown\b|\bstand-?off\b|\bquick ?draw\b/],
  [FIGHT, /\bswords?\b|\bninjas?\b|\bgladiators?\b|\bsamurai\b|\btower defen[cs]e\b/],
  [COLLECT, /\bsnake game\b|\bslither\b|\b[a-z]+[ .]io\b|\bagar\b|\bpac-?man\b/],
  [ESCAPE, /\bhorror\b|\bscary\b|\bcreepy\b|\bfive nights\b|\bfreddy'?s?\b|\bhide and seek\b|\bstealth\b|\bsneak(?:s|ing|y)?\b|\bfloor is lava\b/],
  [SHOOTER, /\bshooter\b|\bshooting (?:range|gallery|game)\b|\barchery\b|\bguns?\b|\bkrunker\b|\bsniper\b|\bfps\b/],
  [THROW, /\bgolf\b|\bbowling\b|\bbilliards\b|\bbasketball\b|\bslingshot\b|\bangry birds\b|\bcannon\b|\bcatapult\b|\bragdoll\b|\bknock(?:s|ing)? (?:down|over) (?:the |a |an )?(?:[a-z]+ )?towers?\b/],
  [SPATIAL, /\bsoccer\b|\bfootball\b|\btennis\b/],
  [STATION, /\bmatch[ -]?3\b|\bcandy crush\b|\btetris\b|\bmahjong\b|\bjenga\b|\bsuika\b|\bpuzzle\b|\bidle\b|\bclicker\b|\btycoon\b|\bovercooked\b|\bfarm game\b|\bsalon\b|\bmakeover\b|\bfashion\b|\bclinic\b|\bmatching game\b|\bword game\b|\bfishing\b|\bfactory\b|\bempire\b/],
];

const KIND_ORDER: readonly Kind[] = ['goal', 'move', 'pickup', 'chase'];

/** Třída slovesa ze čtení modelem → režim; `null` = sběr podle zbytku věty. */
const READ_CLASS: Partial<Record<VerbClass, Pair | null>> = {
  runner: RUNNER,
  platform: PLATFORMER,
  steer: RACE,
  flap: FLAP,
  timing: PRECISION,
  rhythm: RHYTHM,
  melee: FIGHT,
  move_free: null,
  manipulate: STATION,
  build_place: STATION,
  aim_shoot: SHOOTER,
  throw: THROW,
};

/** Narážka modulu v libovolném tvaru slovesa: `slide` → slides, sliding; `hop` → hopping. */
function cuePattern(cue: string): RegExp {
  const word = cue.toLowerCase().replace(/[^a-z ]/g, '');
  const forms = word.endsWith('e')
    ? [word, `${word}s`, `${word}d`, `${word.slice(0, -1)}ing`]
    : [word, `${word}s`, `${word}es`, `${word}ed`, `${word}ing`, `${word}${word.at(-1) ?? ''}ing`, `${word}${word.at(-1) ?? ''}ed`];
  return new RegExp(`\\b(?:${forms.join('|')})\\b`);
}

const PAIRS: readonly Pair[] = GENRES.flatMap((genre) => GENRE_MODES[genre].map((mode) => pair(genre, mode)));
const key = (p: Pair): string => `${p.genre}.${p.mode}`;

/**
 * Věta, ve které žádný režim nic neslyšel („a cozy game“, „a squirrel hoards
 * acorns before winter comes“, P36A T11): napřed sběr v Aréně – volná chůze po
 * scéně z věty s věcmi z prostředí sedí skoro každému tématu –, pak ostatní
 * v pořadí žánrů a běžec až poslední. Dřív hrála každá taková věta běžce.
 */
const unheard = (p: Pair): number => (key(p) === key(COLLECT) ? 0 : key(p) === key(RUNNER) ? 2 : 1);

/** „dodging the fishmonger“, „avoid the guards“: sběr s někým, komu se hráč vyhýbá. */
const AVOID = /\bdodg(?:e|es|ing)\b|\bavoid(?:s|ing)?\b/;

/**
 * Hraje režim sloveso? Režim slovesa dává tabulka `VERBS` jako `pick` věty;
 * sběr (`pickup`) žánr nemá, hraje ho každý režim, který má co sbírat. Čte to
 * řetěz věrnosti (P32B T6) u hry žánru, kde sloveso nenese ovládání.
 */
export function verbPlayedBy(forms: readonly string[], genre: string, mode: string, collects: boolean): boolean {
  const words = forms.map((form) => form.toLowerCase());
  // Základní tvar napřed: vzor „box“ chce „boxing“ nebo „box against“, samotné slovo seznamu by minul.
  const entry = VERBS.find((candidate) => words.includes(candidate.verb)) ?? VERBS.find((candidate) => words.some((word) => candidate.pattern.test(word)));
  if (entry === undefined) return false;
  return entry.pick === null ? collects : entry.pick.genre === genre && entry.pick.mode === mode;
}

/** Věta (a čtení modelem, když je) → všechny režimy seřazené od nejlepšího. */
export function classifyGenre(sentence: string, reading: Reading | null, modules: GenreModules = GENRE_MODULES): GenreRanking {
  const text = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
  const scores = new Map<string, { score: number; why: string[] }>(PAIRS.map((p) => [key(p), { score: 0, why: [] }]));
  const add = (p: Pair, points: number, why: string): void => {
    const entry = scores.get(key(p));
    if (entry === undefined) return;
    entry.score += points;
    entry.why.push(why);
  };

  const heard = VERBS.flatMap((entry) => {
    const match = entry.pattern.exec(text);
    return match === null ? [] : [{ ...entry, at: match.index, end: match.index + match[0].length }];
  });
  // P38: „a jumping game where you shoot animals“ – skok nebo běh nese žánr a střelba jede jako doplněk
  // (`ride`, v návrhu `enemyMoves: 'shoot'`); samotná střelba by skákání zahodila.
  const shot = heard.some((entry) => entry.verb === 'shoot');
  const carrier = shot ? heard.find((entry) => entry.kind === 'move' && (entry.pick === PLATFORMER || entry.pick === RUNNER)) : undefined;
  const main = carrier ?? [...heard].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.at - b.at)[0];
  const firstMove = heard.filter((entry) => entry.kind === 'move').sort((a, b) => a.at - b.at)[0];
  // T5b: i to, čemu se hráč vyhýbá („while dodging ghosts“, hrozba ze čtení) – skutečný sběr v Aréně nepřítele nemá, útěk ano.
  const chaser = heard.some((entry) => entry.kind === 'chase') || reading?.roles.some((role) => role.kind === 'chaser' || role.kind === 'threat') === true || AVOID.test(text);
  // Sběr s pohybem vpřed patří pohybu, s pronásledovatelem útěku, jinak sběru v Aréně.
  const pickup = (): Pair => firstMove?.pick ?? (chaser ? ESCAPE : COLLECT);

  for (const entry of heard) {
    const isMain = entry === main;
    add(entry.pick ?? pickup(), isMain ? 4 : 1, isMain ? `main verb "${entry.verb}"` : `verb "${entry.verb}"`);
  }

  for (const [pick, pattern] of NAMES) {
    const match = pattern.exec(text);
    if (match !== null) add(pick, 2, `"${match[0]}"`);
  }
  // „a dragon burns down villages and dodges arrows“ (P36A T11): uhýbání bez slovesa z tabulky je útěk, ne sběr věty bez narážky.
  const dodged = AVOID.exec(text);
  if (dodged !== null) add(ESCAPE, 1, `"${dodged[0]}"`);

  for (const genre of GENRES) {
    for (const cue of modules[genre].cues) {
      if (!cuePattern(cue).test(text)) continue;
      for (const mode of GENRE_MODES[genre]) add(pair(genre, mode), 1, `cue "${cue}"`);
    }
  }

  if (reading !== null) {
    reading.verbs.forEach((verb, index) => {
      const pick = READ_CLASS[verb.class];
      if (pick === undefined) return;
      add(pick ?? pickup(), index === 0 ? 2 : 1, `reading "${verb.word}"`);
    });
    if (reading.roles.some((role) => role.kind === 'chaser')) add(ESCAPE, 1, 'reading: chaser');
  }

  const availability = (p: Pair): 'ready' | 'fallback' => (modules[p.genre] as GenreModule).availability(p.mode as never);
  // Režim, který hraje náhradu, jde za všechny `ready`, které něco slyšely; věta bez narážky dá `ready` v pořadí `unheard`.
  const tier = (p: Pair, score: number): number => (score > 0 ? 0 : 2 + 2 * unheard(p)) + (availability(p) === 'ready' ? 0 : 1);
  const ranked = PAIRS.map((p, index) => {
    const entry = scores.get(key(p)) ?? { score: 0, why: [] };
    return { choice: { genre: p.genre, mode: p.mode, score: entry.score, why: entry.why.join(', ') || 'no cue' }, index };
  })
    .sort((a, b) => tier(a.choice, a.choice.score) - tier(b.choice, b.choice.score) || b.choice.score - a.choice.score || a.index - b.index)
    .map((item) => item.choice);

  return {
    ranked,
    fallback: availability(ranked[0]) === 'fallback',
    verb: main?.verb ?? reading?.verbs[0]?.word ?? null,
    after: main === undefined ? null : text.slice(main.end).trim() || null,
    pick: main === undefined ? null : (main.pick ?? pickup()),
    ride: carrier === undefined ? null : 'shoot',
  };
}
