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
import { GENRE_MODULES } from './index';

export interface GenreChoice {
  readonly genre: GenreId;
  readonly mode: GenreMode;
  readonly score: number;
  /** Co skóre přineslo, anglicky pro panel čtení („main verb "light", cue "light"“). */
  readonly why: string;
}

export interface GenreRanking {
  /** Všech devět režimů, nejlepší první. */
  readonly ranked: readonly GenreChoice[];
  /** První režim hraje náhradu (`availability = 'fallback'`), protože nic jiného neslyšel. */
  readonly fallback: boolean;
  /** Hlavní sloveso věty (základní tvar), `null` když věta žádné z tabulky nemá. */
  readonly verb: string | null;
  /** Zbytek věty za hlavním slovesem – tam začíná jeho předmět („… candles before the ghosts“). */
  readonly after: string | null;
  /** Režim, který hlavní sloveso podle tabulky `VERBS` hraje; `null` když věta žádné z tabulky nemá. Čte ho kontrola věrnosti. */
  readonly pick: { readonly genre: GenreId; readonly mode: GenreMode } | null;
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
  v('light', 'goal', SPATIAL, new RegExp(String.raw`\b(?:light(?:s|ing)?(?: up)?|ignit(?:e|es|ing)|kindl(?:e|es|ing)) ${OBJECT}`)),
  v('extinguish', 'goal', SPATIAL, /\bextinguish(?:es|ing)?\b|\bput(?:s|ting)? out (?:the )?(?:fires?|flames?|blaze)\b|\bdous(?:e|es|ing)\b|\bspray(?:s|ing)? water\b|\bhos(?:e|es|ing) down\b/),
  v('free', 'goal', SPATIAL, new RegExp(String.raw`\brescu(?:e|es|ing)\b|\b(?:free|frees|freeing|releas(?:e|es|ing)) ${OBJECT}`)),
  v('press', 'goal', SPATIAL, /\b(?:press(?:es|ing)?|toggl(?:e|es|ing)|flip(?:s|ping)?|pull(?:s|ing)?) (?:[a-z]+ ){0,3}?(?:switch(?:es)?|levers?|buttons?)\b|\bpress(?:es|ing)? (?:red|blue|green|yellow)\b/),
  v('deliver', 'goal', SPATIAL, /\b(?:carr(?:y|ies|ying)|deliver(?:s|ing)?|bring(?:s|ing)?)\b/),
  // Míření na cíl je Úkol (spec „Pět žánrů“): střelba a házení jako samostatné ovládání končí.
  v('hit', 'goal', SPATIAL, /\b(?:shoot(?:s|ing)?|throw(?:s|ing)?|toss(?:es|ing)?|pop(?:s|ping)?|hit(?:s|ting)?|smash(?:es|ing)?|zap(?:s|ping)?|destroy(?:s|ing)?)\b/),
  // Úkol na místě: jedna stanice, předmět mění stav.
  v('cook', 'goal', STATION, /\b(?:cook(?:s|ing)?|bak(?:e|es|ing)|grill(?:s|ing)?|brew(?:s|ing)?)\b|\bflip(?:s|ping)? (?:the |a |an |some )?(?:[a-z]+ )?(?:pancakes?|burgers?|patt(?:y|ies)|eggs?|crepes?)\b/),
  v('repair', 'goal', STATION, /\b(?:repair(?:s|ing)?|fix(?:es|ing)?|mend(?:s|ing)?)\b/),
  // Skládačky, stavění, péče a obsluha – sloveso na předmětu na jednom místě.
  v('make', 'goal', STATION, /\b(?:stack(?:s|ing)?|merg(?:e|es|ing)|sort(?:s|ing)?|build(?:s|ing)?|connect(?:s|ing)?|unscrew(?:s|ing)?|untangl(?:e|es|ing)|decorat(?:e|es|ing)|design(?:s|ing)?|harvest(?:s|ing)?|heal(?:s|ing)?|serv(?:e|es|ing)|feed(?:s|ing)?|craft(?:s|ing)?|upgrad(?:e|es|ing)|manag(?:e|es|ing)|hir(?:e|es|ing)|dress(?:es|ing)? up|cut(?:s|ting)? the rope)\b/),
  // Souboj.
  v('duel', 'goal', FIGHT, /\bduel(?:s|ing|led|ling)?\b/),
  v('fight', 'goal', FIGHT, /\bfight(?:s|ing)?\b(?! (?:the )?(?:fires?|flames?))|\bbattl(?:e|es|ing)\b|\bwrestl(?:e|es|ing)\b|\bspar(?:s|ring)?\b|\bbrawl(?:s|ing)?\b/),
  v('box', 'goal', FIGHT, /\bboxing\b|\bbox(?:es)? (?:against|with)\b|\bpunch(?:es|ing)?\b|\bkick(?:s|ing)?\b/),
  v('defeat', 'goal', FIGHT, /\bdefeat(?:s|ing)?\b|\bknock(?:s|ing)? out\b|\bbeat(?:s|ing)? up\b|\battack(?:s|ing)?\b/),
  v('defend', 'goal', FIGHT, /\bdefend(?:s|ing)?\b|\bprotect(?:s|ing)?\b/),
  v('land', 'goal', LAND, /\blands\b|\blanding\b|\bland (?:on|at|in|safely|softly|gently|the|a|an|it|its)\b|\bto land\b/),
  // Pohyb vpřed.
  v('slide', 'move', RUNNER, /\bslid(?:e|es|ing)\b/),
  v('ski', 'move', RUNNER, /\bski(?:s|ing)?\b|\bsled(?:s|ding)?\b|\bsledg(?:e|es|ing)\b|\bsnowboard(?:s|ing)?\b|\bsurf(?:s|ing)?\b/),
  v('run', 'move', RUNNER, /\b(?:run|runs|running)\b(?! (?:out|from|away))|\bdash(?:es|ing)?\b|\bsprint(?:s|ing)?\b|\brunner\b/),
  v('jump', 'move', PLATFORMER, /\bjump(?:s|ing)?\b|\bhop(?:s|ping)?\b|\bleap(?:s|ing)?\b|\bbounc(?:e|es|ing)\b|\bplatform(?:er|s)?\b/),
  v('climb', 'move', PLATFORMER, /\bclimb(?:s|ing)?\b|\bcross(?:es|ing)? (?:the |a |an )?(?:[a-z]+ )?(?:islands?|platforms?|stones?|lava|river|gaps?|chasms?|pits?)\b/),
  v('sail', 'move', RACE, /\bsail(?:s|ing)?\b|\brow(?:s|ing)? (?:a |the )?boat\b|\bcruis(?:e|es|ing)\b|\bnavigat(?:e|es|ing)\b/),
  v('fly', 'move', RACE, /\bfl(?:y|ies|ying)\b|\bflap(?:s|ping)?\b|\bglid(?:e|es|ing)\b|\bsoar(?:s|ing)?\b|\bpilot(?:s|ing)?\b/),
  v('drive', 'move', RACE, /\bdriv(?:e|es|ing)\b|\bsteer(?:s|ing)?\b|\brac(?:e|es|ing|er)\b|\bzoom(?:s|ing)?\b/),
  v('ride', 'move', RACE, /\brid(?:e|es|ing)\b/),
  v('walk', 'move', RACE, /\bwalk(?:s|ing)?\b|\bstroll(?:s|ing)?\b|\bwander(?:s|ing)?\b|\btravel(?:s|ling|ing)?\b|\bswim(?:s|ming)?\b/),
  // Sběr – žánr dostane podle zbytku věty.
  v('collect', 'pickup', null, new RegExp(String.raw`\bcollect(?:s|ing)?\b|\bgather(?:s|ing)?\b|\bfind(?:s|ing)?\b|\bpick(?:s|ing)? up\b|\bgrab(?:s|bing)?\b|\beat(?:s|ing)?\b|\bsteal(?:s|ing)?\b|\bcatch(?:es|ing)? (?!${PRONOUN})`)),
  v('search', 'pickup', null, /\bsearch(?:es|ing)?\b|\bexplor(?:e|es|ing)\b/),
  // Útěk a přežití.
  v('chase', 'chase', ESCAPE, new RegExp(String.raw`\bchas(?:e|es|ed|ing)\b|\bhunt(?:s|ed|ing)?\b|\bpursu(?:e|es|ed|ing)\b|\bstalk(?:s|ing)?\b|\b(?:catch(?:es)?|follow(?:s|ing)?) ${PRONOUN}`)),
  v('escape', 'chase', ESCAPE, /\bescap(?:e|es|ed|ing)\b|\bfle(?:e|es|eing)\b|\bfled\b|\b(?:runs?|running) (?:away )?from\b|\boutrun(?:s)?\b/),
  v('survive', 'chase', ESCAPE, /\bsurviv(?:e|es|ing|al)\b|\boutlast(?:s)?\b|\bstay alive\b/),
];

/**
 * Jména her a věci, které žánr prozradí bez slovesa („like mario kart“, „a
 * match 3 game“): +2, takže rozhodnou jen věty, kde hlavní sloveso chybí.
 * Hlavním slovesem se nestanou – kontrola věrnosti čte jen slovesa.
 */
const NAMES: readonly (readonly [Pair, RegExp])[] = [
  [RUNNER, /\bsubway surfers?\b|\btemple run\b|\bskateboard(?:s|ing)?\b|\bcrossy road\b|\bfrogger\b|\bcross(?:es|ing)? (?:the |an? )?(?:endless |busy |big )?(?:road|street|highway)\b|\broll(?:s|ing)? (?:down|through)\b/],
  [PLATFORMER, /\bmario\b(?! kart)|\bobby\b|\bparkour\b|\bfall guys\b|\bobstacle course\b|\bsonic\b/],
  [RACE, /\bkarts?\b|\bdrift(?:s|ing)?\b|\bmotorbikes?\b|\bbikes?\b|\bcars?\b|\bboats?\b|\bplanes?\b|\bspaceships?\b|\bsubmarines?\b|\btractors?\b|\bflapp?y\b|\bstunts?\b|\bramps?\b/],
  [FIGHT, /\bswords?\b|\bninjas?\b|\bgladiators?\b|\bsamurai\b|\btower defen[cs]e\b/],
  [COLLECT, /\bsnake game\b|\bslither\b|\b[a-z]+[ .]io\b|\bagar\b|\bpac-?man\b/],
  [ESCAPE, /\bhorror\b|\bscary\b|\bcreepy\b|\bfive nights\b|\bfreddy'?s?\b|\bhide and seek\b|\bstealth\b|\bsneak(?:s|ing|y)?\b|\bfloor is lava\b/],
  [SPATIAL, /\bshooter\b|\bgolf\b|\bbowling\b|\bbilliards\b|\barchery\b|\bbasketball\b|\bsoccer\b|\bfootball\b|\btennis\b|\bslingshot\b|\bangry birds\b|\bcannon\b|\bguns?\b|\bkrunker\b|\bbeat saber\b|\bpiano tiles\b|\bthe beat\b/],
  [STATION, /\bmatch[ -]?3\b|\bcandy crush\b|\btetris\b|\bmahjong\b|\bjenga\b|\bsuika\b|\bpuzzle\b|\bidle\b|\bclicker\b|\btycoon\b|\bovercooked\b|\bfarm game\b|\bsalon\b|\bmakeover\b|\bfashion\b|\bclinic\b|\bmatching game\b|\bword game\b|\bfishing\b|\bfactory\b|\bempire\b/],
];

const KIND_ORDER: readonly Kind[] = ['goal', 'move', 'pickup', 'chase'];

/** Třída slovesa ze čtení modelem → režim; `null` = sběr podle zbytku věty. */
const READ_CLASS: Partial<Record<VerbClass, Pair | null>> = {
  runner: RUNNER,
  platform: PLATFORMER,
  steer: RACE,
  flap: RACE,
  melee: FIGHT,
  move_free: null,
  manipulate: STATION,
  build_place: STATION,
  aim_shoot: SPATIAL,
  throw: SPATIAL,
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

/** Věta (a čtení modelem, když je) → všech devět režimů seřazených od nejlepšího. */
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
  const main = [...heard].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.at - b.at)[0];
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
  // Režim, který hraje náhradu, jde za všechny `ready`, které něco slyšely; věta bez narážky dá `ready` v pořadí žánrů.
  const tier = (p: Pair, score: number): number => (score > 0 ? 0 : 2) + (availability(p) === 'ready' ? 0 : 1);
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
  };
}
