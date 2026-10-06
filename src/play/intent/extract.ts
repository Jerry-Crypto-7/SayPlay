/**
 * Záměr věty bez modelu (P41 T1): věta → hrdina, prostředí a všechny položky
 * aktér – sloveso – předmět na osách pohyb / akce / cíl / hrozba (`contract.ts`).
 *
 * Na rozdíl od `classifyGenre` (`genre/classify.ts`) nevybírá jedno vítězné sloveso:
 * každý zásah tabulky `ROWS` je položka, takže „a knight jumps over lava and shoots
 * dragons and collects coins“ dá skok, lávu, střelbu i sběr. Tabulka je jediné místo,
 * kde se slovo mění na kus osy; zbytek souboru čte, kdo to dělá (podmět klauze před
 * slovesem) a komu (jmenná fráze za ním).
 *
 * Pravidla nad tabulkou:
 * - kdo honí hrdinu, je hrozba `chaser` a hrdina dostane cíl `escape` („a dog chases you“);
 *   kdo honí někoho jiného, má cíl `catch` („a dog chases a cat“);
 * - zápor vyřadí pohyb, akci i cíl a zapíše je do `negated`; hrozbu jen tehdy, když stojí
 *   hned za „no / without“ („no guards“) – „don't touch the lava“ lávu nevypíná;
 * - sloveso mimo tabulku je položka osy `unknown` („a grandma knits a scarf“ → knit), ne ticho.
 *
 * Čisté a deterministické: žádný model, žádná náhoda, jen regulární výrazy nad větou.
 */

import { NUMBER_WORDS, nounPhrase, readCountedNouns, readLives, RED_LIGHT, ROAD, singular, toolsOf, withoutPossessor } from '../draft/lexicon';

import { type ActionId, HERO, type Intent, type IntentAction, type IntentAxis, type MoveId, type ObjectiveId, type ThreatId } from './contract';

/**
 * Kdo je u položky aktér a kdo předmět:
 * - `doer` – aktér je podmět slovesa, předmět fráze za ním („a dog chases a cat“);
 * - `bare` – aktér podmět, předmět žádný (pohyb: „jumps over lava“ – láva je hrozba, ne předmět skoku);
 * - `reverse` – obráceně: věc za slovesem jde proti podmětu („escape the zombies“ → honí zombie);
 * - `versus` – jako `reverse`, ale jen za „against / vs“ („football against a walrus“; „basketball free throws“ soupeře nemá);
 * - `noun` – aktér je samo slovo věty („lava“, „guards“), předmětem hrdina.
 */
type Who = 'doer' | 'bare' | 'reverse' | 'versus' | 'noun';

/**
 * Kus osy, který řádek vydá. Dva kusy se rozhodnou až podle předmětu:
 * `each` → cíl `collect` u víc kusů („light all the lanterns“), jinak `reach` („rescue the princess“);
 * `avoid` → hrozba podle slova (`THREAT_NOUNS`): láva je `hazard`, stráž `guard`, jinak `obstacle`.
 */
interface Emit {
  readonly axis: IntentAxis;
  readonly id: string;
  readonly who: Who;
  /** Domyšlený kus („defeat“ bez jiné akce = rvačka): podstatný není a padne, když věta na téže ose řekne vlastní. */
  readonly fallback: boolean;
}

const move = (id: MoveId, who: Who = 'bare'): Emit => ({ axis: 'move', id, who, fallback: false });
const act = (id: ActionId, fallback = false): Emit => ({ axis: 'action', id, who: 'doer', fallback });
const goal = (id: ObjectiveId | 'each', who: Who = 'doer'): Emit => ({ axis: 'objective', id, who, fallback: false });
const threat = (id: ThreatId | 'avoid', who: Who): Emit => ({ axis: 'threat', id, who, fallback: false });

interface Row {
  readonly pattern: RegExp;
  readonly emits: readonly Emit[];
  /** Další předložky, za kterými stojí předmět („argue with my boss“). */
  readonly lead?: string;
  /** Předmětem smí být místo („reach the castle“, „escape the maze“); jinak místo předmětem není. */
  readonly keepPlace?: boolean;
  /**
   * Holé jméno těsně před slovem: `target` – je to předmět („a zombie shooter“ střílí zombie, jako `subjectOf`
   * v lexikonu); `modifier` – patří ke slovu, aktér to není („water gun“, „sword fighting“, „knife throwing“).
   */
  readonly before?: 'target' | 'modifier';
  /** Aktér kusu `noun`, když ho vzor sám nejmenuje („without being seen“ → guard). */
  readonly noun?: string;
}

const row = (pattern: RegExp, emits: readonly Emit[], options: Omit<Row, 'pattern' | 'emits'> = {}): Row => ({ pattern, emits, ...options });

const NUMBER = `(?:\\d+|${Object.keys(NUMBER_WORDS).join('|')})`;

/** Hrozby, které věta jmenuje slovem; podle nich se rozhodne i `avoid` („dodge the lava“ je `hazard`). */
const THREAT_NOUNS: readonly (readonly [ThreatId, RegExp])[] = [
  [
    'hazard',
    /\b(?:lava|magma|acid|spikes?|pits?|traps?|lasers?(?! (?:guns?|swords?|pointers?)\b)|laser beams?|poison(?:ous)?|quicksand|thorns?|(?:buzz ?)?saws?|flames?|fireballs?|fires?(?! (?:at|trucks?|fighters?|engines?|stations?|works|ants?)\b)|bombs?|explosions?|landmines?|thin ice|electric (?:floors?|fences?)|toxic (?:waste|sludge))\b/,
  ],
  // „guards the castle“ je sloveso (hlídá), „the guards“ stráže.
  ['guard', /\b(?:guards?(?! (?:its|the|his|her|their|our|my|a|an)\b)|sentr(?:y|ies)|patrols?|watch(?:man|men)|security (?:guards?|cameras?)|searchlights?)\b/],
  ['rival', /\b(?:rivals?|opponents?|competitors?|other (?:racers|cars|drivers|players|karts|boats|runners|teams?)|enemy (?:cars|racers|karts))\b/],
  ['obstacle', /\b(?:obstacles?|hurdles?|barriers?|asteroids?|meteors?|meteorites?|traffic|boulders?|falling (?:rocks|objects|things|blocks))\b/],
];

const INTERACT = new RegExp(
  [
    String.raw`\blight(?:s|ing)?(?: up)?(?= (?:the |a |an |all |every |each |some |\d+ )?(?:[a-z]+ )?(?:lanterns?|candles?|torches?|lamps?|beacons?|fireworks?|bonfires?|campfires?|fires?)\b)`,
    String.raw`\bignit(?:e|es|ing)\b|\bkindl(?:e|es|ing)\b|\bextinguish(?:es|ing)?\b|\bput(?:s|ting)? out\b|\bdous(?:e|es|ing)\b`,
    String.raw`\brescu(?:e|es|ing)\b|\bsav(?:e|es|ing)\b(?! (?:money|time|up|for|points?|the day|game)\b)|\b(?:free|frees|freeing|releas(?:e|es|ing)) (?=(?:the|a|an|all|every|each|some|\d+)\b)`,
    String.raw`\b(?:press(?:es|ing)?|push(?:es|ing)?|toggl(?:e|es|ing)|flip(?:s|ping)?|pull(?:s|ing)?|hit(?:s|ting)?)(?= (?:[a-z]+ ){0,3}?(?:switch(?:es)?|levers?|buttons?)\b)`,
    String.raw`\bactivat(?:e|es|ing)\b|\bturn(?:s|ing)? on\b|\bunlock(?:s|ing)?\b|\bopen(?:s|ing)?(?= (?:the |a |an |all |every |some )?(?:[a-z]+ )?(?:doors?|chests?|gates?|presents?|locks?|boxes|safes?)\b)`,
    String.raw`\bwak(?:e|es|ing) up\b|\bpop(?:s|ping)?\b(?! (?:music|songs?|stars?)\b)|\bsmash(?:es|ing)?\b|\bwreck(?:s)?\b|\bwrecking\b(?! balls?\b)|\bbreak(?:s|ing)? (?=(?:the|a|an|all|every|some|\d+)\b)`,
  ].join('|'),
);

/** „run a restaurant“ je vedení podniku, ne běh. */
const RUN_A_PLACE = '(?! (?:a|an|the|my|your|his|her|their) (?:[a-z]+ )?(?:restaurant|shop|store|business|caf[eé]|bakery|farm|hotel|zoo|company|kitchen|supermarket|empire|factory|bar|club)\\b)';

/**
 * Slovo věty → kusy os. Pořadí řádků rozhoduje jen u položek na stejném místě věty.
 * Slovesa a vzory sdílí s `VERBS` v `genre/classify.ts`; tady se ale nevybírá – každý zásah platí.
 */
const ROWS: readonly Row[] = [
  // Pohyb. Předmět má jen jízda – na čem se jede („rides a horse“); „drive a car“ s autem jako hrdinou předmět ztratí.
  row(
    /\bdriv(?:e|es|ing|en)\b|\bsteer(?:s|ing)?\b(?! clear)|\bzoom(?:s|ing)?\b(?! (?:meetings?|calls?)\b)|\brid(?:e|es|ing)\b|\bgallop(?:s|ing)?\b|\bsail(?:s|ing)?\b|\bpaddl(?:e|es|ing)\b|\bkayak(?:s|ing)?\b|\brow(?:s|ing)? (?=(?:a |the )?(?:[a-z]+ )?boats?\b)|\bdrift(?:s|ing)?\b/,
    [move('drive', 'doer')],
  ),
  // „a fly“, „eats flies“ ani „floating islands“ let nejsou.
  row(
    /(?<!\b(?:a|an|the|eat|eats|eating|catch|catches|catching|fruit|dragon|fire|house) )\bfl(?:y|ies|ying)\b(?! away\b)|\bflew\b|\bglid(?:e|es|ing)\b|\bsoar(?:s|ing)?\b|\bswim(?:s|ming)?\b|\bswam\b|\bdiv(?:e|es|ing)\b|\bhover(?:s|ing)?\b|\bfloat(?:s|ing)? (?=(?:in|through|around|across|over|up|away|down)\b)|\bpiloting\b|\bpilots? (?=(?:a|an|the)\b)/,
    [move('glide')],
  ),
  row(/\bflap(?:s|ping)?\b|\bflutter(?:s|ing)?\b|\bflapp?y\b/, [move('flap')]),
  // „runs from“ je útěk, ne běh.
  row(
    new RegExp(
      String.raw`\b(?:run|runs|running|ran)\b(?! (?:out|from|away)\b)${RUN_A_PLACE}|\bdash(?:es|ing)?\b|\bsprint(?:s|ing)?\b|\brunners?\b|\bski(?:s|ing)?\b|\bsled(?:s|ding)?\b|\bsnowboard(?:s|ing)?\b|\bskateboard(?:s|ing)?\b|\bsurf(?:s|ing)?\b|\bsubway surfers?\b|\bskat(?:e|es|ing)\b|\bslid(?:e|es|ing)\b|\broll(?:s|ing)? (?:down|through|across|along|around)\b`,
    ),
    [move('run')],
  ),
  // „a chicken crosses the road“ (lexikon `ROAD`): přes pruhy s auty.
  row(ROAD, [move('run'), threat('obstacle', 'noun')], { noun: 'traffic' }),
  row(/\bjump(?:s|ing|ed)?\b|\bhop(?:s|ping|ped)?\b|\bleap(?:s|ing|t)?\b|\bbounc(?:e|es|ing)\b|\bclimb(?:s|ing)?\b|\bplatformers?\b|\bplatforms\b|\bparkour\b|\bobby\b|\bmario\b(?! kart)/, [move('jump')]),
  row(
    /\bwalk(?:s|ing)?\b|\bstroll(?:s|ing)?\b|\bwander(?:s|ing)?\b|\bsneak(?:s|ing|y)?\b|\bsnuck\b|\btipto(?:e|es|eing)\b|\bstealth(?:y|ily)?\b|\bexplor(?:e|es|ing)\b|\bmazes?\b|\blabyrinths?\b|\bhide and seek\b|\bhid(?:e|es|ing)\b/,
    [move('walk')],
  ),
  // Kdo nesmí být viděn, před někým se skrývá: plížení i stráž, i když ji věta nejmenuje.
  row(/\b(?:without (?:being |getting )?|(?:don'?t|do not|never|not) (?:be |get )?)(?:seen|spotted|caught|noticed|detected)\b|\bundetected\b|\bunseen\b/, [move('walk'), threat('guard', 'noun')], { noun: 'guard' }),
  // „without waking the cat“: hlídá ten, kdo spí.
  row(/\bwithout waking(?: up)?\b/, [move('walk'), threat('guard', 'reverse')]),
  // Červená–zelená (lexikon `RED_LIGHT`): hýbat se smíš, jen když se hlídač nedívá.
  row(RED_LIGHT, [move('walk'), threat('guard', 'noun')], { noun: 'watcher' }),
  // Agar a had: volně po aréně, roste, kdo jí menší („eat smaller fish and grow“).
  row(/\beat(?:s|ing)? (?:the )?(?:smaller|tiny|little|weaker)\b|\bgrow(?:s|ing)? (?:bigger|larger|huge)\b|\bagar(?:\.io)?\b|\bslither(?:\.io)?\b|\b[a-z]+\.io\b|\bsnake game\b|\bpac-?man\b|\broam(?:s|ing)?\b|\bopen world\b/, [move('roam')]),
  // Míč: pohyb s míčem a výhra gólem; kdo hraje proti, je soupeř („football against a walrus“).
  row(
    /\b(?:football|soccer|basketball|golf|mini ?golf|hockey|table tennis|tennis|volleyball|baseball|rugby|handball|ping ?pong|penalt(?:y|ies))\b/,
    [move('ball'), goal('score', 'bare'), threat('rival', 'versus')],
  ),
  row(/\bkick(?:s|ing)? (?:a |the |his |her |their )?(?:[a-z]+ )?balls?\b|\bdribbl(?:e|es|ing)\b/, [move('ball'), goal('score', 'bare')]),

  // Akce. „shooting stars“ střelba nejsou, „auto shooting wand“ střílí sám.
  row(/(?<!auto[ -])\bshoot(?:s|ing)?\b(?! (?:stars?|hoops|games?|gallery|range)\b)|\bfir(?:e|es|ing) at\b|\bfir(?:e|es|ing)(?= (?:the |a |an |some |\d+ )?(?:[a-z]+ )?(?:cannons?|cannonballs?|missiles?|rockets?|lasers?|arrows?|bullets?|guns?|torpedo(?:es)?|fireballs?)\b)|\bblast(?:s|ing)? (?=(?:the|a|an|all|every|some|\d+)\b)|\baim(?:s|ing)? at\b|\bsnip(?:e|es|ing)\b|\barchery\b|\bcast(?:s|ing)?(?= (?:[a-z]+ ){0,2}spells?\b)|\bzap(?:s|ping)?\b/, [act('shoot')]),
  row(/\bshooters?\b|\bshooting (?:games?|gallery|range)\b|\bfps\b/, [act('shoot')], { before: 'target' }),
  row(/\bguns?\b|\bblasters?\b|\brifles?\b|\bpistols?\b|\bweapons?\b|\bbullets?\b|\bsnipers?\b/, [act('shoot')], { before: 'modifier' }),
  row(
    /\bthrow(?:s|ing|n)?\b(?! (?:a )?punch)|\bthrew\b|\btoss(?:es|ing)?\b|\bfling(?:s|ing)?\b|\bhurl(?:s|ing)?\b|\blob(?:s|bing)?\b|\blaunch(?:es|ing)? (?=(?:a|an|the|some)\b)|\bbowling\b|\bslingshots?\b|\bcatapults?\b|\bangry birds\b/,
    [act('throw')],
    { before: 'modifier' },
  ),
  // „fight fires“ je hašení.
  row(
    /\bfight(?:s|ing)?\b(?! (?:the )?(?:fires?|flames?)\b)|\bfought\b|\bbattl(?:e|es|ing)\b|\bwrestl(?:e|es|ing)\b|\bspar(?:s|ring)?\b|\bbrawl(?:s|ing)?\b|\bpunch(?:es|ing)?\b|\bboxing\b|\bbox(?:es)? (?:against|with)\b|\battack(?:s|ing)?\b|\bstomp(?:s|ing)?\b|(?<!candy )\bcrush(?:es|ing)?\b(?! on\b)|\bsquash(?:es|ing)?\b|\bslash(?:es|ing)?\b|\bkarate\b|\bkung fu\b/,
    [act('fight')],
    { before: 'modifier' },
  ),
  // Porazit je cíl; rvačka jen domyšlená – „shoot and defeat the aliens“ je střelba.
  row(
    /\bdefeat(?:s|ing|ed)?\b|\bkill(?:s|ing)?\b|\bslay(?:s|ing)?\b|\bdestroy(?:s|ing)?\b|\beliminat(?:e|es|ing)\b|\bconquer(?:s|ing)?\b|\bvanquish(?:es|ing)?\b|\bknock(?:s|ing)? out\b|\bbeat(?:s|ing)? up\b|\btak(?:e|es|ing) down\b|\bget(?:s|ting)? rid of\b|\bbeat(?:s|ing)? (?=(?:the|a|an|all|every|each) (?!(?:beat|music|rhythm|clock|record|game|level|high score)\b))/,
    [goal('defeat'), act('fight', true)],
  ),
  row(/\bkick(?:s|ing)?\b/, [act('kick')]),
  row(
    /\bcollect(?:s|ing|ed)?\b|\bgather(?:s|ing)?\b|\bfind(?:s|ing)?\b(?! (?:the |a |an |your |their )?(?:exit|way|door|portal|path)\b)|\bpick(?:s|ing)? up\b|\bgrab(?:s|bing)?\b|\bsteal(?:s|ing)?\b|\bstole\b|\beat(?:s|ing)?\b|\bhoard(?:s|ing)?\b|\bloot(?:s|ing)?\b|\bsearch(?:es|ing)?\b|\b(?:hunt(?:s|ing)?|look(?:s|ing)?) for\b|\b(?:treasure|scavenger|egg) hunts?\b|\bpick(?:s|ing)?(?= (?:[a-z]+ ){0,2}(?:herbs?|flowers?|berries|apples?|fruits?|mushrooms?|cherries|grapes)\b)/,
    [act('collect')],
  ),
  // „collect all the coins“, „find 5 keys“: sebrat všechno je cíl, ne jen akce.
  row(new RegExp(String.raw`\b(?:(?:collect|gather|find|grab|eat|steal)(?:s|ing)?|pick(?:s|ing)? up) (?=(?:all|every|each|${NUMBER})\b)`), [goal('collect')]),
  // Dojít k věci a něco s ní udělat: rozsvítit, osvobodit, zmáčknout, uhasit, prasknout.
  row(INTERACT, [act('interact'), goal('each')]),
  row(/\bcarr(?:y|ies|ying)\b|\bdeliver(?:s|ing)?\b|\bbring(?:s|ing)?\b|\bescort(?:s|ing)?\b|\bserv(?:e|es|ing)\b|\bfetch(?:es|ing)?\b/, [act('deliver'), goal('each')]),
  row(/\bstack(?:s|ing)?\b/, [act('stack'), goal('build')]),
  row(/\bbuild(?:s)?\b|\bbuilding (?=(?:a|an|the|games?|towers?|houses?|bridges?|castles?)\b)|\bconstruct(?:s|ing)?\b/, [goal('build'), act('stack', true)]),
  row(/\bat the (?:right|perfect|exact) (?:time|moment|second)\b|\btiming\b|\btim(?:e|es|ing) (?=(?:your|his|her|their|each|every)\b)|\bstop(?:s|ping)? the (?:moving|swinging|spinning|sliding)\b|\bcut(?:s|ting)? the ropes?\b/, [act('time')]),
  row(/\bdanc(?:e|es|ing)\b|\b(?:to|with|on) the (?:beat|music|rhythm)\b|\bto music\b|\brhythm\b|\bmusic(?:al)? games?\b|\bdrum(?:s|ming)?\b|\bpiano\b|\bguitar\b|\bsing(?:s|ing)?\b|\bkaraoke\b|\bbeat saber\b/, [act('beat')]),
  // Spor jeden na jednoho: předmět je protějšek („argue with my boss“, „play chess with a dragon“).
  row(
    /\bduel(?:s|ing|led|ling)?\b|\bargu(?:e|es|ing)\b|\bnegotiat(?:e|es|ing)\b|\bconvinc(?:e|es|ing)\b|\bpersuad(?:e|es|ing)\b|\bdebat(?:e|es|ing)\b|\bchess\b|\bcheckers\b|\bpoker\b|\b(?:play(?:s|ing)?|game of) cards\b|\btic[- ]tac[- ]toe\b|\brock[ ,-]+paper[ ,-]+scissors\b|\bstaring contest\b|\bshowdown\b|\bquick ?draw\b/,
    [act('duel')],
    { lead: 'with' },
  ),

  // Cíl. „a race car“ je auto, ne závod; „race against X“ jmenuje soupeře.
  row(/\brac(?:e|es|ing|er|ers)\b(?! cars?\b)|\bgrand prix\b|\blaps?\b|\bfinish (?:line|first)\b|\bfirst place\b/, [goal('race'), threat('rival', 'versus')]),
  row(
    /\breach(?:es|ing)? (?=(?:the|a|an|its|his|her|their|your)\b)|\bget(?:s|ting)? (?:back )?to (?=(?:the|a|an|its|his|her|their|your)\b)|\bmak(?:e|es|ing) it (?:to|home|out)\b|\bfind(?:s|ing)? (?=(?:the |a |an |your |their )?(?:exit|door|portal|path)\b)|\bfind(?:s|ing)? (?:the |a |your |their )?way (?:out|home|back)\b|\bget(?:s|ting)? (?:home|out)\b|\bgo(?:es)? home\b|\bto the (?:top|end|exit|finish|goal)\b/,
    [goal('reach')],
    { keepPlace: true },
  ),
  row(
    new RegExp(String.raw`\bsurviv(?:e|es|ed|ing)\b|\boutlast(?:s|ing)?\b|\bstay(?:s|ing)? alive\b|\bdefend(?:s|ing)?\b|\bprotect(?:s|ing)?\b|\btower defen[cs]e\b|\b(?:for|last(?:s|ing)?) ${NUMBER}[ -](?:seconds?|minutes?)\b`),
    [goal('survive')],
    { keepPlace: true },
  ),
  // „a zombie survival game“: zombie je to, co se přežívá.
  row(/\bsurvival\b/, [goal('survive')], { before: 'target' }),
  // Útěk: před kým se utíká, ten honí („a cat runs from a dog“ → honí pes). Z místa („escape the maze“) honič není.
  row(
    /\bescap(?:e|es|ed|ing)\b|\bfle(?:e|es|eing)\b|\bfled\b|\b(?:run|runs|running|ran) (?:away )?from\b|\boutrun(?:s|ning)?\b|\bget(?:s|ting)? away from\b|\brun(?:s|ning)? away\b(?! from)/,
    [goal('escape'), threat('chaser', 'reverse')],
    { keepPlace: true },
  ),
  row(/\b(?:chased|hunted|pursued|followed|stalked) by\b/, [goal('escape'), threat('chaser', 'reverse')]),
  // Honička: podmět honí předmět; když je předmětem hrdina, je z toho hrozba (`chasingTheHero`). „treasure hunt“ je hledání.
  row(
    /\bchas(?:e|es|ed|ing)\b(?! by\b)|(?<!(?:treasure|scavenger|egg) )\bhunt(?:s|ed|ing)?\b(?! (?:by|for)\b)|\bpursu(?:e|es|ing)\b|\bstalk(?:s|ing)?\b|\bcatch(?:es|ing)?\b|\bfollow(?:s|ing)? (?=(?:you|me|us|him|her|them|it|the player)\b)/,
    [goal('catch')],
  ),
  row(/\bscor(?:e|es|ing)\b(?! ?(?:board|counter)s?\b)/, [goal('score')]),
  row(/\blands\b|\blanding\b|\bland (?=(?:on|at|in|safely|softly|gently|the|a|an|it|its)\b)|\bto land\b|\bparallel park|\bpark(?:s|ing)? (?=(?:my|his|her|their|your|our|the|a)\b)/, [goal('land')], { keepPlace: true }),

  // Hrozba: čemu se hrdina vyhýbá, jde proti němu; druh řekne slovo (`THREAT_NOUNS`), jinak je to překážka.
  row(
    /\bdodg(?:e|es|ed|ing)\b|\bavoid(?:s|ed|ing)?\b|\bevad(?:e|es|ed|ing)\b|\bstay(?:s|ing)? away from\b|\b(?:watch|look)(?:s|ing)? out for\b|\bsteer(?:s|ing)? clear of\b|\b(?:sneak|get|slip)(?:s|ping|ting|ing)? past\b|\b(?:jump|hop|leap|vault)(?:s|ing|ed)? over\b/,
    [threat('avoid', 'reverse')],
  ),
  ...THREAT_NOUNS.map(([id, pattern]) => row(pattern, [threat(id, 'noun')])),
];

/** Stroj jako hrdina se hýbe sám od sebe: auto a loď jedou, letadlo a ponorka plují prostorem. */
const DRIVEN = ['car', 'truck', 'bike', 'bicycle', 'motorcycle', 'motorbike', 'kart', 'go-kart', 'boat', 'ship', 'yacht', 'speedboat', 'sailboat', 'jetski', 'canoe', 'kayak', 'raft', 'bus', 'taxi', 'van', 'tractor', 'tank', 'train', 'tram', 'jeep', 'buggy', 'scooter', 'ambulance', 'firetruck', 'limo', 'racecar', 'hovercraft'];
const FLOWN = ['plane', 'airplane', 'aeroplane', 'jet', 'helicopter', 'rocket', 'spaceship', 'spacecraft', 'ufo', 'drone', 'glider', 'blimp', 'submarine'];
const VEHICLE_MOVE: ReadonlyMap<string, MoveId> = new Map([...DRIVEN.map((word) => [word, 'drive'] as const), ...FLOWN.map((word) => [word, 'glide'] as const)]);
const VEHICLE = new RegExp(`\\b(${[...VEHICLE_MOVE.keys()].join('|')})(?:e?s)?\\b`, 'g');

/** Prostředí věty; vyhrává to, které věta řekne dřív, při shodě dřívější řádek. Noc jen tehdy, když místo chybí. */
const SETTINGS: readonly (readonly [string, RegExp])[] = [
  ['ocean', /\boceans?\b|\bseas?\b(?! ?(?:floor|bed)\b)/],
  ['underwater', /\bunder ?water\b|\bunder the sea\b|\bsunken\b|\bshipwrecks?\b|\bcoral reefs?\b|\breefs?\b|\bsea ?(?:floor|bed)\b|\bdeep sea\b/],
  ['space', /\b(?:outer )?space\b(?![ -]?bar)|\bgalax(?:y|ies)\b|\bplanets?\b|\bmoon\b|\bmars\b|\borbit\b|\bcosmos\b/],
  ['city', /\bcit(?:y|ies)\b|\btowns?\b|\bstreets?\b|\bdowntown\b|\bhighways?\b|\brooftops?\b|\bneon\b|\bmetropolis\b/],
  ['forest', /\bforests?\b|\bwoods\b|\bwoodlands?\b/],
  ['jungle', /\bjungles?\b|\brainforests?\b/],
  ['desert', /\bdeserts?\b|\bdunes?\b|\bsahara\b/],
  ['snow', /\bsnowy?\b|\barctic\b|\bglaciers?\b|\bfrozen\b|\bwinter\b|\bpolar\b|\btundra\b|\bnorth pole\b/],
  ['castle', /\bcastles?\b|\bkingdoms?\b|\bdungeons?\b|\bfortress(?:es)?\b|\bmedieval\b/],
  ['volcano', /\bvolcan(?:o|oes|ic)\b/],
  ['cave', /\bcaves?\b|\bcaverns?\b|\bunderground\b/],
  ['beach', /\bbeach(?:es)?\b|\bislands?\b|\bcoast\b|\btropical\b/],
  ['sky', /\bsky\b|\bskies\b|\bclouds?\b/],
  ['mountain', /\bmountains?\b|\bhills?\b|\bcliffs?\b/],
  ['graveyard', /\bgraveyards?\b|\bcemeter(?:y|ies)\b/],
  ['house', /\bhouses?\b|\bhomes?\b|\bbedrooms?\b|\bliving room\b|\bmansion\b|\bapartment\b/],
  ['kitchen', /\bkitchens?\b|\brestaurant\b/],
  ['school', /\bschools?\b|\bclassrooms?\b/],
  ['farm', /\bfarms?\b|\bbarn\b/],
  ['park', /\bparks\b|\b(?:in|at|through|around) (?:a|the) park\b|\bplayground\b/],
  ['river', /\brivers?\b|\blakes?\b|\bponds?\b|\bswamps?\b/],
  ['mall', /\bmalls?\b|\bshopping cent(?:er|re)\b/],
  ['supermarket', /\bsupermarkets?\b|\bgrocery(?: store)?\b|\bmarkets?\b|\bstores?\b|\bshops?\b/],
  ['museum', /\bmuseums?\b/],
  ['hospital', /\bhospitals?\b/],
  ['factory', /\bfactor(?:y|ies)\b|\bwarehouses?\b|\blab(?:orator(?:y|ies))?s?\b/],
  ['office', /\boffices?\b/],
  ['village', /\bvillages?\b/],
  ['prison', /\bprisons?\b|\bjail\b/],
  ['temple', /\btemples?\b|\bruins\b|\bpyramids?\b/],
];
const NIGHT = /\bnight(?:time)?\b|\bmidnight\b/;
/** Místa, která prostředí neurčí, ale předmětem slovesa nejsou („runs through the maze“, „to the finish“). */
const OTHER_PLACES = /^(?:maze|labyrinth|room|track|road|level|world|map|area|arena|field|course|top|end|exit|finish|floor|ground|place|park|home|garden|backyard|yard|stadium|carnival|circus|zoo|library|airport|station|hotel)$/;

const inSetting = (word: string): boolean => SETTINGS.some(([, pattern]) => pattern.test(word));
const isPlace = (word: string): boolean => OTHER_PLACES.test(word) || NIGHT.test(word) || inSetting(word);

/** Hráč sám („you“, „the player“): hrdina věty, nebo `HERO`, když ho věta nejmenuje. */
const PLAYER_WORDS = new Set(['you', 'u', 'i', 'we', 'me', 'us', 'player', 'yourself']);
const OTHER_PRONOUNS = new Set(['he', 'she', 'it', 'they', 'him', 'her', 'them', 'itself', 'himself', 'herself', 'themselves']);
const ARTICLE_WORDS = new Set(['a', 'an', 'the', 'my', 'your', 'his', 'her', 'their', 'our', 'some', 'one', 'this', 'that', 'its']);
/** Částice za slovesem („knock down“, „push off“): jméno s nimi uvnitř není podmět, ale rozkaz. */
const PARTICLES = new Set(['down', 'up', 'out', 'off', 'away', 'back', 'around']);

/** Hlava podmětu, která postavu nejmenuje: žánr, míra, přídavné jméno bez podstatného („a cute racing game“). */
const NOT_AN_ACTOR = new Set([
  'game', 'version', 'mode', 'map', 'world', 'story', 'adventure', 'sim', 'simulator', 'style', 'kind', 'type', 'sort', 'lot', 'bit', 'idea',
  'level', 'endless', 'infinite', 'hard', 'easy', 'simple', 'fun', 'cool', 'new', 'first', 'floor', 'ground', 'place', 'cute', 'funny', 'silly',
  'scary', 'spooky', 'creepy', 'cozy', 'cosy', 'colorful', 'colourful', 'relaxing', 'fast', 'slow', 'epic', 'crazy', 'retro', 'pixel', 'classic',
  'realistic', 'awesome', 'amazing', 'chaotic', 'intense', 'short', 'long', 'quick', 'ultimate', 'super', 'mega', 'extreme', 'wild', 'weird',
  'random', 'big', 'little', 'small', 'tiny', 'huge', 'giant', 'multiplayer', 'mobile', 'casual', 'tough', 'difficult', 'arcade', 'like',
  'no', 'any', 'more', 'other', 'every', 'only', 'just', 'also', 'not', 'very', 'too', 'really',
]);
/** Předmět, který věc ve hře nejmenuje: čas, skóre, míra, citoslovce („race against time“, „survive 60 seconds“, „lol“). */
const NOT_A_THING = new Set([
  'time', 'clock', 'score', 'point', 'stuff', 'thing', 'everything', 'anything', 'something', 'nothing', 'everyone', 'everybody', 'all', 'way',
  'other', 'second', 'minute', 'hour', 'day', 'game', 'level', 'fun', 'lot', 'one', 'round', 'match', 'win', 'royale', 'noon', 'dawn', 'dusk',
  'sunset', 'sunrise', 'midnight', 'lol', 'lmao', 'haha', 'pls', 'plz', 'vibe', 'style', 'mode',
]);
/** Pomocná slovesa za podmětem („a dog tries to catch…“); na nich jméno aktéra končí. */
const AUXILIARIES = new Set(['must', 'can', 'will', 'should', 'has', 'have', 'is', 'are', 'was', 'were', 'gets', 'wants', 'tries', 'needs', 'likes', 'loves', 'keeps', 'starts', 'begins', 'learns', 'decides', 'want', 'need', 'try', 'like', 'love', 'get', 'keep']);
/** Slova, která po podmětu sloveso hry nejsou („is“, „has“, „wants to“) – neznámou položkou se nestanou. */
const LIGHT_VERBS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'does', 'do', 'did', 'gets', 'get', 'got', 'wants', 'want', 'needs', 'need',
  'tries', 'try', 'likes', 'like', 'loves', 'love', 'lives', 'live', 'goes', 'go', 'comes', 'come', 'keeps', 'keep', 'starts', 'start', 'begins',
  'begin', 'becomes', 'become', 'seems', 'seem', 'looks', 'look', 'lets', 'let', 'can', 'could', 'must', 'will', 'would', 'should', 'may', 'might',
  "can't", 'cant', "don't", 'dont', "doesn't", 'doesnt', "won't", 'wont', 'cannot', 'also', 'just', 'always', 'then', 'still', 'never', 'not',
  'says', 'say', 'sees', 'see', 'knows', 'know', 'thinks', 'think', 'feels', 'feel', 'means', 'mean', 'stays', 'stay', 'uses', 'use', 'gonna',
]);
/** Slovo, které hru zadává nebo ovládá, ne popisuje („make a game where…“, „tap to jump“). */
const META_VERBS = new Set(['make', 'create', 'design', 'generate', 'give', 'show', 'write', 'imagine', 'play', 'want', 'need', 'let', 'please', 'add', 'do', 'i', 'we', 'you', 'tap', 'click', 'hold', 'swipe', 'touch', 'drag']);

const headOf = (phrase: string): string => singular(phrase).split(' ').at(-1) ?? phrase;

/** Jmenná fráze z lexikonu, uťatá před členem nebo předložkou uvnitř („a sled down a hill“ → sled). */
const CUT = new Set([...ARTICLE_WORDS, ...PARTICLES, 'against', 'vs', 'versus', 'like', 'than', 'about', 'during', 'near']);
function phraseIn(text: string): string | null {
  const words = nounPhrase(text, 3)?.split(' ') ?? [];
  const cut = words.findIndex((word, index) => index > 0 && CUT.has(word));
  const kept = cut === -1 ? words : words.slice(0, cut);
  return kept.length === 0 || (kept.length === 1 && ARTICLE_WORDS.has(kept[0])) ? null : kept.join(' ');
}

/**
 * Aktér z textu mezi začátkem klauze a slovesem: jednotné číslo hlavy jmenné fráze,
 * `HERO` pro hráče („you“, „the player“), `null`, když tam nikdo není („and shoots“, „he“, rozkaz).
 */
function actorIn(segment: string): string | null {
  // „with zombies chasing u“: honí zombie; „with swords cutting fruit to music“ ale meče k hudbě netančí.
  const trimmed = segment.trim();
  if (/^with\s/.test(trimmed) && /\b[a-z]{2,}ing\b/.test(trimmed)) return null;
  const bare = trimmed.replace(/^with\s+/, '').replace(/^(?:(?:a|an|the|my|your|our|this|that|some|one)(?:\s+|$))+/, '');
  const first = bare.split(' ')[0];
  if (PLAYER_WORDS.has(first)) return HERO;
  // „play chess with…“: rozkaz na začátku věty podmět nemá.
  if (first === '' || OTHER_PRONOUNS.has(first) || META_VERBS.has(first) || LIGHT_VERBS.has(first)) return null;
  const words = nounPhrase(bare, 4)?.split(' ') ?? [];
  // „pull the pins to…“, „knock down towers…“: člen nebo částice uvnitř = sloveso a jeho předmět, ne podmět.
  if (words.some((word, index) => index > 0 && (ARTICLE_WORDS.has(word) || PARTICLES.has(word)))) return null;
  // „a dog needs to“, „a dog chases“: slovo na -s za jednotnou hlavou je sloveso, ne jméno (jako `subjectOf` v lexikonu).
  const kept: string[] = [];
  for (const word of words) {
    const previous = kept.at(-1);
    if (AUXILIARIES.has(word) || (previous !== undefined && /[^s]s$/.test(word) && !previous.endsWith('s'))) break;
    kept.push(word);
  }
  const head = kept.at(-1);
  if (head === undefined) return null;
  if (PLAYER_WORDS.has(head)) return HERO;
  const name = singular(head);
  // „a never-ending runner“, „a fast-paced shooter“: přídavné jméno se spojovníkem postava není.
  return NOT_AN_ACTOR.has(name) || isPlace(name) || /-[a-z]+(?:ing|ed|like|style|themed)$/.test(name) ? null : name;
}

/** Jmenná fráze za slovesem (nebo před ním u `before: 'target'`): hlava v jednotném čísle, víc kusů, rozsah ve větě, předložka. */
interface Thing {
  readonly head: string;
  readonly many: boolean;
  readonly at: number;
  readonly end: number;
  /** Předložka před frází („against“ u soupeře); `null` u přímého předmětu. */
  readonly via: string | null;
}

/** Předložky, za kterými stojí předmět slovesa („shoot at“, „jump over“, „escape from“); cesta a místo („through“, „in“) ne. */
const PREPOSITIONS = 'at|over|past|against|vs|versus|from|onto|into|on|after|for';
/** „a horde of zombies“: předmětem jsou zombie, ne horda. */
const COLLECTIVE = /^(?:(?:a|an|the|huge|giant|big|endless|whole) )*(?:waves?|hordes?|packs?|swarms?|arm(?:y|ies)|bunch(?:es)?|herds?|flocks?|lots?|tons?|piles?|groups?|crowds?|gangs?|fleets?|schools?|stacks?) of /;
const QUANTIFIED = new RegExp(`^(?:all|every|each|many|lots of|${NUMBER})\\b`);
const ONLY_DETERMINERS = /^ ?(?:a|an|the|all|every|each|some|my|your|his|her|their|its|our)(?: (?:a|an|the|all|every|each|some|my|your|his|her|their|its|our))* ?$/;

function thingIn(text: string, from: number, limit: number, lead: string | undefined, tools: readonly string[]): Thing | null {
  const opener = new RegExp(`^ ?(?:(?:up|down|out|away|off|back) )?(?:(${lead === undefined ? PREPOSITIONS : `${PREPOSITIONS}|${lead}`}) )?`).exec(text.slice(from, limit));
  const via = opener?.[1] ?? null;
  let start = from + (opener?.[0].length ?? 0);
  // Slovo tabulky hned za členem předmět neuřízne: „throw a basketball“ – míč je i řádek tabulky. Bez členu („gun fight“) ano.
  const to = ONLY_DETERMINERS.test(text.slice(start, limit)) ? text.length : limit;
  // Zájmena `nounPhrase` zastaví; „chases you“ ale říká, koho se honička týká.
  const pronoun = /^(?:the )?(you|u|me|us|him|her|it|them|player|yourself)\b/.exec(text.slice(start, to));
  if (pronoun !== null) return { head: pronoun[1], many: false, at: start, end: start + pronoun[0].length, via };
  start += COLLECTIVE.exec(text.slice(start, to))?.[0].length ?? 0;
  let phrase = phraseIn(text.slice(start, to));
  if (phrase === null) return null;
  const at = start;
  // „shoots arrows at goblins“: šíp je nástroj (`toolsOf`), předmětem je terč za „at“.
  const aimed = tools.includes(singular(phrase)) ? / (?:at|into|onto|toward|towards) /.exec(text.slice(start, to)) : null;
  if (aimed !== null) {
    start += aimed.index + aimed[0].length;
    phrase = phraseIn(text.slice(start, to)) ?? phrase;
  }
  const last = phrase.split(' ').at(-1) ?? phrase;
  return { head: headOf(phrase), many: QUANTIFIED.test(text.slice(start, to)) || singular(phrase) !== phrase, at, end: text.indexOf(last, start) + last.length, via };
}

interface Hit {
  readonly row: Row;
  readonly at: number;
  readonly end: number;
  readonly said: string;
}

const isNounRow = (entry: Row): boolean => entry.emits.every((emit) => emit.who === 'noun');
const unknownRow = (verb: string): Row => row(/$^/, [{ axis: 'unknown', id: verb, who: 'doer', fallback: false }]);

function hitsOf(text: string): Hit[] {
  return ROWS.flatMap((entry) =>
    [...text.matchAll(new RegExp(entry.pattern.source, 'g'))].map((match) => ({ row: entry, at: match.index, end: match.index + match[0].length, said: match[0].trim() })),
  );
}

/** Hranice klauze: interpunkce a spojky. „who / that / which“ navíc říkají, že podmět stojí před nimi. */
interface Boundary {
  readonly at: number;
  readonly end: number;
  readonly word: string;
}
const BOUNDARY = /[,.;:!?]|\b(?:and|but|or|while|whilst|where|when|whenever|then|so|that|who|which|until|before|after|because|if|unless)\b/g;

/** Kde začíná zápor a kam sahá: „without guns“, „no shooting“, „doesn't jump“ – do konce klauze. */
const NEGATION =
  /(?<!\bsay(?:s|ing)? )\b(?:without|no|not|never|don'?t|doesn'?t|didn'?t|can'?t|cannot|won'?t|isn'?t|aren'?t|shouldn'?t|mustn'?t|do not|does not|did not|can not|must not|should not)\b(?!-)(?! (?:be |being |get |getting )?(?:seen|spotted|caught|noticed|detected|waking)\b)(?! (?:one|matter|more than|longer|way|only|stops?|stopping|give up|gives up|giving up|quits?|quitting)\b)/g;
const NEGATION_END = /[,.;:!?]|\b(?:and|but|while|where|when|then|so|that|who|which|because|until|before|after|instead|with)\b/;
/** Hrozba je vypnutá jen záporem přímo před ní („no guards“, „without any rivals“). */
const NEGATED_NOUN = /\b(?:no|without)(?: (?:any|other|more|the))* $/;

function negationScopes(text: string): (readonly [number, number])[] {
  return [...text.matchAll(NEGATION)].map((match) => {
    const from = match.index + match[0].length;
    const end = NEGATION_END.exec(text.slice(from));
    return [from, end === null ? text.length : from + end.index] as const;
  });
}

/** Přídavná jména na -ing, která sloveso nejsou („a boring game“). */
const ING_ADJECTIVES = new Set(['boring', 'amazing', 'interesting', 'relaxing', 'exciting', 'thrilling', 'challenging', 'calming', 'satisfying', 'annoying', 'frustrating', 'charming', 'stunning', 'terrifying', 'fascinating', 'entertaining', 'addicting', 'engaging', 'rewarding', 'refreshing', 'soothing', 'inspiring', 'amusing', 'neverending', 'everlasting', 'thinking']);
const DETERMINER = new RegExp(`^(?:a|an|the|my|your|his|her|their|its|our|some|all|every|each|${NUMBER})$`);
const PHRASE_BREAK = new Set(['in', 'on', 'at', 'to', 'from', 'of', 'into', 'through', 'across', 'over', 'under', 'with', 'without', 'for', 'by', 'as', 'near', 'inside']);
const PRONOUN_VERB =
  /\b(you|i|we|he|she)(?: (?:can|must|will|should|could|also|just|then|always|now|need to|needs to|have to|has to|get to|gets to|try to|tries to|want to|wants to|like to|likes to|love to|loves to|are able to|is able to|are going to|is going to|gonna))* ([a-z][a-z'-]*)( as\b)?/g;
const GERUND = /\b([a-z]{3,}ing) (?:games?|simulator|sim)\b|\babout ([a-z]{3,}ing)\b/g;
const IMPERATIVE = new RegExp(`^([a-z]+) (?=(?:a|an|the|some|all|every|your|his|her|their|my|its|${NUMBER})\\b)`);

/** „knits“ → knit, „watches“ → watch, „carries“ → carry, „goes“ → go. */
const presentBase = (word: string): string =>
  /(?:ch|sh|ss|x|zz|o)es$/.test(word) ? word.slice(0, -2) : /[^aeiou]ies$/.test(word) ? `${word.slice(0, -3)}y` : word.endsWith('s') ? word.slice(0, -1) : word;

/** „knitting“ → knit, „baking“ → bake, „juggling“ → juggle, „cooking“ → cook. */
function gerundBase(word: string): string {
  const stem = word.slice(0, -3);
  if (/([b-df-hj-np-tv-z])\1$/.test(stem) && !/(?:ll|ss|zz)$/.test(stem)) return stem.slice(0, -1);
  if ((stem.length <= 4 && /[^aeiou][aeiou][bcdgkmnprstvz]$/.test(stem)) || /(?:[^aeiou]c|v|[^aeiou]l)$/.test(stem)) return `${stem}e`;
  return stem;
}

/**
 * Slovesa, která tabulka nezná, jako položky osy `unknown`: podmět + sloveso ve 3. osobě
 * („a grandma knits a scarf“), zájmeno + sloveso („where you knit“), „-ing game“ („a knitting game“),
 * rozkaz na začátku („knit a scarf“) a sloveso se členem za „and“ nebo „who“ („and bakes a cake“).
 * Kandidát padne, když za ním v téže klauzi stojí sloveso z tabulky („plays football“, „helps a dog find bones“).
 */
function unknownHits(text: string, clauses: readonly (readonly [number, number])[], taken: readonly Hit[]): Hit[] {
  const covered = (at: number, end: number): boolean => taken.some((hit) => at < hit.end && hit.at < end);
  const found: { at: number; said: string; verb: string; meta: boolean }[] = [];
  for (const [from, to] of clauses) {
    const words = [...text.slice(from, to).matchAll(/[a-z][a-z'-]*/g)].map((match) => ({ word: match[0], at: from + match.index }));
    const lead = words.length > 0 && ARTICLE_WORDS.has(words[0].word) ? 1 : 0;
    const subjectless = words.length === 0 || PLAYER_WORDS.has(words[lead]?.word ?? '') || OTHER_PRONOUNS.has(words[lead]?.word ?? '');
    for (let index = lead + 1; !subjectless && index < Math.min(words.length, lead + 4); index++) {
      const { word, at } = words[index];
      const previous = words[index - 1];
      // Podmět je jméno: ne předložka, člen, pomocné sloveso ani slovo, které tabulka už čte („shoot balloons with“).
      if (PHRASE_BREAK.has(word) || PHRASE_BREAK.has(previous.word) || LIGHT_VERBS.has(word) || ARTICLE_WORDS.has(previous.word) || covered(previous.at, previous.at + previous.word.length)) break;
      if (/[^s]s$/.test(word) && !previous.word.endsWith('s')) {
        // Bez členu („motorbike stunts on ramps“) je to spíš množné číslo; sloveso pozná až člen za ním („grandma knits a scarf“).
        const next = words[index + 1]?.word;
        if (lead === 1 || (next !== undefined && DETERMINER.test(next))) found.push({ at, said: word, verb: presentBase(word), meta: false });
        break;
      }
    }
    // „… and bakes a cake“, „a black hole that swallows a city“: bez podmětu jen se členem za sebou – „and gems to buy“ sloveso není.
    if (lead === 0 && words.length > 1 && /[^s]s$/.test(words[0].word) && (DETERMINER.test(words[1].word) || /[^s]s$/.test(words[1].word)) && /(?:\b(?:and|who|that|which)|,)\s*$/.test(text.slice(0, from))) {
      found.push({ at: words[0].at, said: words[0].word, verb: presentBase(words[0].word), meta: false });
    }
  }
  for (const match of text.matchAll(PRONOUN_VERB)) {
    if (match[3] !== undefined) continue;
    const said = match[2];
    found.push({ at: match.index + match[0].length - said.length, said, verb: /^(?:he|she)$/.test(match[1]) ? presentBase(said) : said, meta: true });
  }
  for (const match of text.matchAll(GERUND)) {
    const said = match[1] ?? match[2];
    if (!ING_ADJECTIVES.has(said)) found.push({ at: match.index + match[0].indexOf(said), said, verb: gerundBase(said), meta: false });
  }
  const command = IMPERATIVE.exec(text);
  if (command !== null && !ARTICLE_WORDS.has(command[1]) && !PHRASE_BREAK.has(command[1])) found.push({ at: 0, said: command[1], verb: command[1], meta: true });

  const verbHits = taken.filter((hit) => !isNounRow(hit.row));
  const clauseEnd = (at: number): number => clauses.find(([from, to]) => at >= from && at < to)?.[1] ?? text.length;
  const seen = new Set<number>();
  return found
    .filter(({ at, said, verb, meta }) => {
      const end = at + said.length;
      if (seen.has(at) || LIGHT_VERBS.has(said) || LIGHT_VERBS.has(verb) || (meta && META_VERBS.has(verb)) || verb.length < 2 || covered(at, end)) return false;
      if (verbHits.some((hit) => hit.at >= end && hit.at < clauseEnd(at))) return false;
      seen.add(at);
      return true;
    })
    .map(({ at, said, verb }) => ({ row: unknownRow(verb), at, end: at + said.length, said }));
}

/** Hráč věty: „play as a fox“, „you are a knight“, „drive a car through…“ (lexikon `readRoles`). */
const PLAYER_SAID = /\b(?:play(?:s|ing)? as|you(?:'re| are)|youre|i(?:'m| am)|you control|become) (?:an?|the|your) ([a-z][a-z -]*)|^(?:be|drive|ride|fly|pilot|steer|sail) (?:an?|the|your|my) ([a-z][a-z -]*)/;

/** Položka během skládání: pozice ve větě, domyšlenost a zápor. */
interface Draft extends IntentAction {
  readonly at: number;
  readonly fallback: boolean;
  readonly negated: boolean;
}

export function extractIntent(sentence: string): Intent {
  const text = withoutPossessor(sentence.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim());
  const tools = toolsOf(text);
  const scopes = negationScopes(text);
  const inScope = (at: number): boolean => scopes.some(([from, to]) => at >= from && at < to);

  const boundaries: Boundary[] = [...text.matchAll(BOUNDARY)].map((match) => ({ at: match.index, end: match.index + match[0].length, word: match[0] }));
  const clauses = [0, ...boundaries.map((boundary) => boundary.end)].map((from, index) => [from, boundaries[index]?.at ?? text.length] as const);

  const tableHits = hitsOf(text);
  const order = (a: Hit, b: Hit): number => a.at - b.at || ROWS.indexOf(a.row) - ROWS.indexOf(b.row);
  const verbHits = [...tableHits.filter((hit) => !isNounRow(hit.row)), ...unknownHits(text, clauses, tableHits)].sort(order);
  const nounHits = tableHits.filter((hit) => isNounRow(hit.row));

  // Kdo a komu: podmět je text od hranice klauze (nebo od předchozího slovesa a jeho předmětu) po sloveso,
  // předmět fráze za slovesem – „sneaks past guards to steal a fish“ krade kočka, ne stráže.
  const readings: { readonly hit: Hit; readonly actor: string | null; readonly thing: Thing | null }[] = [];
  let reached = 0;
  for (const hit of verbHits) {
    const boundary = boundaries.filter((candidate) => candidate.end <= hit.at).at(-1);
    const from = Math.max(boundary?.end ?? 0, Math.min(reached, hit.at));
    const segment = text.slice(from, hit.at);
    const next = verbHits.find((other) => other.at >= hit.end)?.at ?? text.length;
    const after = thingIn(text, hit.end, next, hit.row.lead, tools);
    // Holé jméno těsně před slovem („water gun“, „sword fighting“), ne podmět ve 3. osobě („dog fights“).
    const bareBefore = /^[a-z-]+ $/.test(segment) && !segment.trim().endsWith('s') && !/[^s]s$/.test(hit.said);
    if (hit.row.before === 'target') {
      const before = phraseIn(segment);
      const target = before === null ? null : { head: headOf(before), many: singular(before) !== before, at: from, end: hit.at, via: null };
      readings.push({ hit, actor: null, thing: target ?? after });
    } else if (hit.row.before === 'modifier' && bareBefore) {
      readings.push({ hit, actor: null, thing: after });
    } else {
      let actor = actorIn(segment);
      // „a knight who shoots“: vztažné zájmeno odkazuje na jméno před sebou.
      if (actor === null && boundary !== undefined && /^(?:who|that|which)$/.test(boundary.word) && boundary.end >= reached) {
        const owner = /([a-z-]+)\s*$/.exec(text.slice(0, boundary.at))?.[1];
        actor = owner === undefined ? null : actorIn(owner);
      }
      readings.push({ hit, actor, thing: after });
    }
    reached = Math.max(reached, hit.end, after?.end ?? 0);
  }

  // Hrdina: koho věta říká hráčem, jinak podmět prvního slovesa (kromě toho, kdo honí „you“), jinak stroj, ve kterém se jede.
  const said = PLAYER_SAID.exec(text);
  const named = said === null ? null : actorIn(said[1] ?? said[2]);
  const first = readings.find((reading) => reading.actor !== null && !(reading.thing !== null && PLAYER_WORDS.has(reading.thing.head)));
  const objectSpans = readings.filter((reading) => reading.thing !== null && !reading.hit.row.emits.some((emit) => emit.axis === 'move'));
  const vehicle = [...text.matchAll(VEHICLE)].find(
    (match) => !inScope(match.index) && !objectSpans.some(({ thing }) => thing !== null && match.index >= thing.at && match.index < thing.end),
  );
  // „where I build my house, drive cars“: kdo mluví sám za sebe, není auto – stroj v množném čísle hrdinou nebude.
  const ridden = vehicle !== undefined && (first?.actor !== HERO || vehicle[0] === vehicle[1]) ? vehicle[1] : null;
  const hero = (named !== HERO ? named : null) ?? (first !== undefined && first.actor !== HERO ? first.actor : null) ?? ridden;
  const heroName = hero ?? HERO;

  const drafts: Draft[] = [];
  let previous: string | null = null;
  for (const { hit, actor: subject, thing } of readings) {
    const actor: string = subject === HERO ? heroName : (subject ?? previous ?? heroName);
    previous = actor;
    const place = thing !== null && isPlace(thing.head);
    const object = objectOf(thing, actor, heroName, hit.row.keepPlace === true);
    const negated = inScope(hit.at);
    for (const emit of hit.row.emits) {
      const verb = emit.id === 'each' ? (thing?.many === true ? 'collect' : 'reach') : emit.id === 'avoid' ? threatOf(object) : emit.id;
      const base = { axis: emit.axis, verb, essential: !emit.fallback, said: hit.said, at: hit.at, fallback: emit.fallback, negated: negated && emit.axis !== 'threat' };
      if (emit.who === 'noun') drafts.push({ ...base, actor: hit.row.noun ?? headOf(hit.said), object: heroName });
      else if (emit.who === 'reverse' || emit.who === 'versus') {
        const opposed = emit.who === 'reverse' || /^(?:against|vs|versus)$/.test(thing?.via ?? '');
        if (object !== null && !place && opposed) drafts.push({ ...base, actor: object, object: actor });
      } else if (emit.who === 'bare') drafts.push({ ...base, actor, object: null });
      else drafts.push({ ...base, actor, object: emit.axis === 'move' && object === actor ? null : object });
    }
  }

  // Hrozby jmenované slovem; co se střílí, hasí nebo sbírá („shoots lasers“, „puts out fires“), hrozbou není.
  const consumed = readings.filter(({ hit, thing }) => thing !== null && hit.row.emits.some((emit) => emit.axis === 'action'));
  for (const hit of nounHits) {
    // Slovo, které tabulka čte jako sloveso („fires cannons“), hrozbou není.
    if (verbHits.some((verb) => hit.at >= verb.at && hit.at < verb.end)) continue;
    if (consumed.some(({ thing }) => thing !== null && hit.at >= thing.at && hit.at < thing.end)) continue;
    // „a lava cave“: láva jako přívlastek prostředí je kulisa.
    const next = /^ ([a-z]+)/.exec(text.slice(hit.end))?.[1];
    const scenery = next !== undefined && inSetting(next);
    for (const emit of hit.row.emits) {
      drafts.push({ axis: emit.axis, verb: emit.id, actor: hit.row.noun ?? headOf(hit.said), object: heroName, essential: !scenery, said: hit.said, at: hit.at, fallback: false, negated: NEGATED_NOUN.test(text.slice(0, hit.at)) });
    }
  }

  // Stroj jako hrdina jede nebo letí, i když to věta neřekne („game in a car“).
  const ride = hero === null ? undefined : VEHICLE_MOVE.get(hero);
  if (hero !== null && ride !== undefined) {
    const word = new RegExp(`\\b${hero}(?:e?s)?\\b`).exec(text);
    drafts.push({ axis: 'move', verb: ride, actor: hero, object: null, essential: true, said: word?.[0] ?? hero, at: word?.index ?? 0, fallback: false, negated: false });
  }

  const items = drafts.flatMap((item) => chasingTheHero(item, heroName));
  // Zápor: „with no shooting“ vyřadí střelbu celou; „don't shoot the hostages“ vedle „shoot zombies“ jen ten jeden terč.
  const kept = items.filter((item) => !item.negated);
  const refused = items.filter((item) => item.negated && !(item.object !== null && kept.some((other) => other.verb === item.verb)));
  const negated = [...new Set(refused.map((item) => item.verb))];
  const live = kept.filter((item) => !negated.includes(item.verb));
  const settled = live.filter((item) => !item.fallback || !live.some((other) => !other.fallback && other.axis === item.axis));

  return {
    sentence,
    hero,
    setting: settingOf(text),
    items: unique(settled.sort((a, b) => a.at - b.at)).map(({ actor, verb, object, axis, essential, said: word }) => ({ actor, verb, object, axis, essential, said: word })),
    negated,
    counts: countsOf(sentence),
  };
}

/** Předmět položky: hráč je hrdina, „it / them“ hrdina jen u cizího aktéra, místo jen tam, kde smí („reach the castle“). */
function objectOf(thing: Thing | null, actor: string, heroName: string, keepPlace: boolean): string | null {
  if (thing === null) return null;
  const { head } = thing;
  if (PLAYER_WORDS.has(head)) return heroName;
  if (OTHER_PRONOUNS.has(head)) return actor === heroName ? null : heroName;
  if (NOT_A_THING.has(head) || NOT_AN_ACTOR.has(head) || (isPlace(head) && !keepPlace)) return null;
  return head;
}

const threatOf = (word: string | null): ThreatId => THREAT_NOUNS.find(([, pattern]) => word !== null && pattern.test(word))?.[0] ?? 'obstacle';

/** „a dog chases you“: kdo honí hrdinu, je hrozba `chaser` a hrdina má cíl `escape`. Zápor („don't let them catch you“) hrozbu nevypne. */
function chasingTheHero(item: Draft, heroName: string): Draft[] {
  if (item.verb !== 'catch' || item.object !== heroName || item.actor === heroName) return [item];
  return [
    { ...item, axis: 'threat', verb: 'chaser', negated: false },
    { ...item, axis: 'objective', verb: 'escape', actor: heroName, object: item.actor, negated: false },
  ];
}

/** Táž položka jednou; bez předmětu jen tehdy, když ji věta nemá i s předmětem („shooting game where you shoot zombies“). */
function unique(items: readonly Draft[]): Draft[] {
  const key = (item: Draft, object = item.object): string => `${item.axis}|${item.verb}|${item.actor}|${object}`;
  const withObject = new Set(items.filter((item) => item.object !== null).map((item) => key(item, null)));
  const merged = new Map<string, Draft>();
  for (const item of items) {
    if (item.object === null && withObject.has(key(item))) continue;
    const known = merged.get(key(item));
    merged.set(key(item), known === undefined ? item : { ...known, essential: known.essential || item.essential });
  }
  return [...merged.values()];
}

function settingOf(text: string): string | null {
  let best: { readonly at: number; readonly id: string } | null = null;
  for (const [id, pattern] of SETTINGS) {
    const at = pattern.exec(text)?.index;
    if (at !== undefined && (best === null || at < best.at)) best = { at, id };
  }
  return best?.id ?? (NIGHT.test(text) ? 'night' : null);
}

/** Počty s podstatným jménem („10 coins“) a životy, i když je věta řekne jednotným číslem („one life“). */
function countsOf(sentence: string): Intent['counts'] {
  const counted = readCountedNouns(sentence);
  const lives = readLives(sentence);
  return lives === null || counted.some((count) => /^(?:lives|hearts?)$/.test(count.noun)) ? counted : [...counted, { count: lives, noun: 'lives' }];
}
