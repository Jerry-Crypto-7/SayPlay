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

import { familyOf } from '../genre/families';
import { vocabVerb } from '../vocab';
import { NUMBER_WORDS, negationScopes, nounPhrase, readCountedNouns, readLives, RED_LIGHT, ROAD, singular, toolsOf, withoutPossessor } from '../draft/lexicon';

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
  /** Sloveso mimo tabulku, přiblížené tabulkou P44C. */
  readonly mapped?: true;
}

const move =(id: MoveId, who: Who = 'bare'): Emit => ({ axis: 'move', id, who, fallback: false });
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
    /\b(?:arrows?|icicles?|mines?|sparks?|(?:(?:hail|snow|thunder|sand|rain|dust) ?)?storms?|blizzards?|tornadoes?|hurricanes?|wind|tide|lava|magma|acid|spikes?|pits?|traps?|lasers?(?! (?:guns?|swords?|pointers?)\b)|laser beams?|poison(?:ous)?|quicksand|thorns?|(?:buzz ?)?saws?|flames?|fireballs?|fires?(?! (?:at|trucks?|fighters?|engines?|stations?|works|ants?)\b)|bombs?|explosions?|landmines?|thin ice|electric (?:floors?|fences?)|toxic (?:waste|sludge))\b/,
  ],
  // „guards the castle“ je sloveso (hlídá), „the guards“ stráže.
  ['guard', /\b(?:guards?(?! (?:its|the|his|her|their|our|my|a|an)\b)|sentr(?:y|ies)|patrols?|watch(?:man|men)|security (?:guards?|cameras?)|searchlights?)\b/],
  ['rival', /\b(?:defenders?|goalkeepers?|rivals?|opponents?|competitors?|other (?:racers|cars|drivers|players|karts|boats|ships|runners|teams?)|enemy (?:cars|racers|karts))\b/],
  ['obstacle', /\b(?:pipes?|cones?|obstacles?|hurdles?|barriers?|asteroids?|meteors?|meteorites?|traffic|boulders?|falling (?:rocks|objects|things|blocks))\b/],
];

const INTERACT = new RegExp(
  [
    String.raw`\blight(?:s|ing)?(?: up)?(?= (?:the |a |an |all |every |each |some |\d+ )?(?:[a-z]+ )?(?:lanterns?|candles?|torches?|lamps?|beacons?|fireworks?|bonfires?|campfires?|fires?)\b)`,
    String.raw`\bignit(?:e|es|ing)\b|\bkindl(?:e|es|ing)\b|\bextinguish(?:es|ing)?\b|\bput(?:s|ting)? out\b|\bdous(?:e|es|ing)\b`,
    String.raw`\brescu(?:e|es|ing)\b|\bsav(?:e|es|ing)\b(?! (?:money|time|up|for|points?|the day|game)\b)|\b(?:free|frees|freeing|releas(?:e|es|ing)) (?=(?:the|a|an|all|every|each|some|\d+)\b)`,
    // „frees caged birds“, „liberates prisoners“: osvobodit bez členu je pořád sloveso; holé „free“ jen za „to“.
    String.raw`\b(?:frees|freeing|releas(?:es|ing)|liberat(?:e|es|ing)|uncag(?:e|es|ing)|unchain(?:s|ing)?)\b(?= [a-z])|(?<=\bto )(?:free|release)\b(?= [a-z])`,
    String.raw`\b(?:press(?:es|ing)?|push(?:es|ing)?|toggl(?:e|es|ing)|flip(?:s|ping)?|pull(?:s|ing)?|hit(?:s|ting)?)(?= (?:[a-z]+ ){0,3}?(?:switch(?:es)?|levers?|buttons?)\b)`,
    String.raw`\bactivat(?:e|es|ing)\b|\bturn(?:s|ing)? on\b|\bunlock(?:s|ing)?\b|\bopen(?:s|ing)?(?= (?:the |a |an |all |every |some )?(?:[a-z]+ )?(?:doors?|chests?|gates?|presents?|locks?|boxes|safes?)\b)`,
    String.raw`\bwak(?:e|es|ing) up\b|\bpop(?:s|ping)?\b(?! (?:music|songs?|stars?)\b)|\bsmash(?:es|ing)?\b|\bwreck(?:s)?\b|\bwrecking\b(?! balls?\b)|\bbreak(?:s|ing)? (?=(?:the|a|an|all|every|some|\d+)\b)`,
  ].join('|'),
);

/** „run a restaurant“ je vedení podniku, ne běh. */
const RUN_A_PLACE = '(?! (?:a|an|the|my|your|his|her|their) (?:[a-z]+ )?(?:restaurant|shop|store|business|caf[eé]|bakery|farm|hotel|zoo|company|kitchen|supermarket|empire|factory|bar|club)\\b)';

// Bare fire is ambiguous. The hit is accepted only in command/coordination
// position below, so "avoid lava and fire" still names a hazard.
const BARE_FIRE = row(/\bfir(?:e|es|ing)\b(?=$|[,.!?;]|\s+(?:and|but|while|then)\b)/, [act('shoot')]);

/**
 * Slovo věty → kusy os. Pořadí řádků rozhoduje jen u položek na stejném místě věty.
 * Slovesa a vzory sdílí s `VERBS` v `genre/classify.ts`; tady se ale nevybírá – každý zásah platí.
 */
const ROWS: readonly Row[] = [
  // Recognized language need not be a supported mechanic. Preserve these requests
  // on the unknown axis so composition can explicitly report their absence.
  ...([
    ['bake', /\bbak(?:e|es|ing)\b/], ['knit', /\bknit(?:s|ting)?\b/], ['cook', /\bcook(?:s|ing)?\b/],
    ['write', /\bwrit(?:e|es|ing)\b/], ['read', /\bread(?:s|ing)?\b/],
    ['fold', /\bfold(?:s|ing)?\b/], ['paint', /\bpaint(?:s|ing)?\b/],
    ['repair', /\brepair(?:s|ing)?\b/],
    ['defend', /\bdefend(?:s|ing)?\b/], ['protect', /\bprotect(?:s|ing)?\b/],
    ['dig', /\bdig(?:s|ging)?\b/], ['mop', /\bmop(?:s|ping)?\b/], ['sweep', /\bsweep(?:s|ing)?\b/],
    ['sing', /\bsing(?:s|ing)?\b/], ['solve', /\bsolv(?:e|es|ing)\b/],
    ['play', /\bplay(?:s|ing)? (?=(?:the |a |an )?(?:chess|piano|guitar|violin|drums?)\b)/],
    ['film', /\bshoot(?:s|ing)? (?=(?:the |a |an )?(?:movies?|films?)\b)/],
    ['finish', /\bfinish(?:es|ing)? (?=(?:the |my |your |a )?(?:homework|assignment|essay|chores?)\b)/],
    ['meditate', /\bmeditat(?:e|es|ing)\b/],
    ['grow', /\bgrow(?:s|ing)? (?=(?:the |a |an )?(?:tomatoes|vegetables|flowers|plants|crops)\b)/],
  ] as const).map(([id, pattern]) => row(pattern, [{ axis: 'unknown', id, who: 'doer', fallback: false }], id === 'sing' ? { lead: 'to' } : {})),
  row(/\bburn(?:s|ing)? (?=(?:the |a |an )?[a-z]+(?: with fire)\b)|\bbreath(?:e|es|ing) fire at\b/, [act('shoot')], { keepPlace: true }),
  row(/\bdelivery\b/, [act('deliver')], { before: 'target' }),
  row(/\barguments?\b/, [act('duel')]),
  row(/\b(?:get |gets |getting )?married\b/, [{ axis: 'unknown', id: 'marry', who: 'doer', fallback: false }]),
  // Pohyb. Předmět má jen jízda – na čem se jede („rides a horse“); „drive a car“ s autem jako hrdinou předmět ztratí.
  row(
    /\bdriv(?:e|es|ing|en)\b|\bsteer(?:s|ing)?\b(?! clear)|\bzoom(?:s|ing)?\b(?! (?:meetings?|calls?)\b)|\brid(?:e|es|ing)\b|\bgallop(?:s|ing)?\b|\bsail(?:s|ing)?\b|\bpaddl(?:e|es|ing)\b|\bkayak(?:s|ing)?\b|\brow(?:s|ing)? (?=(?:a |the )?(?:[a-z]+ )?boats?\b)|\bdrift(?:s|ing)?\b/,
    [move('drive', 'doer')],
  ),
  // „a fly“, „eats flies“ ani „floating islands“ let nejsou.
  row(
    /(?<!\b(?:a|an|the|eat|eats|eating|catch|catches|catching|fruit|dragon|fire|house) )\bfl(?:y|ies)\b(?! away\b)|(?<=\bdragon )flies\b|\bflying\b|\bflew\b|\bglid(?:e|es|ing)\b|\bsoar(?:s|ing)?\b|\bswim(?:s|ming)?\b|\bswam\b|\bdiv(?:e|es|ing)\b|\bhover(?:s|ing)?\b|\bfloat(?:s|ing)? (?=(?:in|through|around|across|over|up|away|down)\b)|\bpiloting\b|\bpilots? (?=(?:a|an|the)\b)/,
    [move('glide')],
  ),
  row(/\bflap(?:s|ping)?\b|\bflutter(?:s|ing)?\b|\bflapp?y\b/, [move('flap')]),
  row(/\bflight\b(?! (?:of )?(?:stairs|steps)\b)/, [move('glide')]),
  // „runs from“ zachovává běh i útěk; „runs out“ samo běh nepožaduje.
  row(
    new RegExp(
      String.raw`\b(?:run|runs|running|ran)\b(?! out\b)${RUN_A_PLACE}|\bdash(?:es|ing)?\b|\bsprint(?:s|ing)?\b|\brunners?\b|\bski(?:s|ing)?\b|\bsled(?:s|ding)?\b|\bsnowboard(?:s|ing)?\b|\bskateboard(?:s|ing)?\b|\bsurf(?:s|ing)?\b|\bsubway surfers?\b|\bskat(?:e|es|ing)\b|\bslid(?:e|es|ing)\b|\broll(?:s|ing)? (?:down|through|across|along|around)\b`,
    ),
    [move('run')],
  ),
  // „a chicken crosses the road“ (lexikon `ROAD`): přes pruhy s auty.
  row(ROAD, [move('run'), threat('obstacle', 'noun')], { noun: 'traffic' }),
  row(/\bjump(?:s|ing|ed)?\b|\bhop(?:s|ping|ped)?\b|\bleap(?:s|ing|t)?\b|\bbounc(?:e|es|ing)\b|\bclimb(?:s|ing)?\b|\bplatformers?\b|\bplatforms\b|\bparkour\b|\bobby\b|\bmario\b(?! kart)/, [move('jump')]),
  row(
    /\bslip(?:s|ping)? past\b|\bwalk(?:s|ing)?\b|\bstroll(?:s|ing)?\b|\bwander(?:s|ing)?\b|\bsneak(?:s|ing|y)?\b|\bsnuck\b|\btipto(?:e|es|eing)\b|\bstealth(?:y|ily)?\b|\bexplor(?:e|es|ing)\b|\bmazes?\b|\blabyrinths?\b|\bhide and seek\b|\bhid(?:e|es|ing)\b/,
    [move('walk')],
  ),
  // Kdo nesmí být viděn, před někým se skrývá: plížení i stráž, i když ji věta nejmenuje.
  row(/\b(?:without (?:being |getting )?|(?:don'?t|do not|never|not) (?:be |get )?)(?:seen|spotted|caught|noticed|detected)\b|\bundetected\b|\bunseen\b/, [move('walk'), threat('guard', 'noun')], { noun: 'guard' }),
  // „without waking the cat“: hlídá ten, kdo spí.
  row(/\bhid(?:e|es|ing) from\b/, [move('walk'), threat('guard', 'reverse')]),
  row(/\bwithout waking(?: up)?\b/, [move('walk'), threat('guard', 'reverse')]),
  // Červená–zelená (lexikon `RED_LIGHT`): hýbat se smíš, jen když se hlídač nedívá.
  row(RED_LIGHT, [move('walk'), threat('guard', 'noun')], { noun: 'watcher' }),
  // Agar a had: volně po aréně, roste, kdo jí menší („eat smaller fish and grow“).
  row(/\beat(?:s|ing)? (?:the )?(?:smaller|tiny|little|weaker)\b|\bgrow(?:s|ing)? (?:bigger|larger|huge)\b|\bagar(?:\.io)?\b|\bslither(?:\.io)?\b|\b[a-z]+\.io\b|\bsnake game\b|\bpac-?man\b|\broam(?:s|ing)?\b|\bmov(?:e|es|ing) freely\b|\bopen world\b|\bwaddl(?:e|es|ing)\b/, [move('roam')]),
  // Míč: pohyb s míčem a výhra gólem; kdo hraje proti, je soupeř („football against a walrus“).
  row(
    /\b(?:football|soccer|basketball|golf(?:ing)?|mini ?golf|hockey|table tennis|tennis|volleyball|baseball|rugby|handball|ping ?pong|penalt(?:y|ies))\b/,
    [move('ball'), goal('score', 'bare'), threat('rival', 'versus')],
  ),
  // Scoring with an aimed ball does not implement a racket rally.
  row(/\b(?:table tennis|tennis|ping[ -]?pong)\b/, [{ axis: 'unknown', id: 'rally', who: 'bare', fallback: false }]),
  row(/\broll(?:s|ing)? in (?:a|the) ball\b|\bkick(?:s|ing)? (?:a |the |his |her |their )?(?:[a-z]+ )?balls?\b|\bdribbl(?:e|es|ing)\b/, [move('ball'), goal('score', 'bare')]),

  // Akce. „shooting stars“ střelba nejsou, „auto shooting wand“ střílí sám.
  BARE_FIRE,
  row(/(?<!auto[ -])\bshoot(?:s|ing)?\b(?! (?:stars?|hoops|games?|gallery|range)\b)|\bfir(?:e|es|ing) at\b|\bfir(?:e|es|ing)(?= (?:the |a |an |some |\d+ )?(?:[a-z]+ )?(?:cannons?|cannonballs?|missiles?|rockets?|lasers?|arrows?|bullets?|guns?|torpedo(?:es)?|fireballs?)\b)|\bblast(?:s|ing)?\b|\baim(?:s|ing)? at\b|\bsnip(?:e|es|ing)\b|\barchery\b|\bcast(?:s|ing)?(?= (?:[a-z]+ ){0,2}spells?\b)|\bzap(?:s|ping)?\b/, [act('shoot')]),
  row(/\bshooters?\b|\bshooting (?:games?|gallery|range)\b|\bfps\b/, [act('shoot')], { before: 'target' }),
  row(/\bguns?\b|\bcannons?\b|\bblasters?\b|\brifles?\b|\bpistols?\b|\bweapons?\b|\bbullets?\b|\bsnipers?\b/, [act('shoot')], { before: 'modifier' }),
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
    /\bdefeat(?:s|ing|ed)?\b|\bkill(?:s|ing)?\b|\bslay(?:s|ing)?\b|\bdestroy(?:s|ing)?\b|\beliminat(?:e|es|ing)\b|\bconquer(?:s|ing)?\b|\bvanquish(?:es|ing)?\b|\bknock(?:s|ing)? (?:(?:it|him|her|them) )?out\b|\bbeat(?:s|ing)? (?:(?:it|him|her|them) )?up\b|\btak(?:e|es|ing) (?:(?:it|him|her|them) )?down\b|\bget(?:s|ting)? rid of\b|\bbeat(?:s|ing)? (?=(?:the|a|an|all|every|each) (?!(?:beat|music|rhythm|clock|record|game|level|high score)\b))/,
    [goal('defeat'), act('fight', true)],
  ),
  row(/\bkick(?:s|ing)?\b/, [act('kick')]),
  row(
    /\bmunch(?:es|ing)?\b|\btak(?:e|es|ing) (?=(?:the |a |an )?(?:treasure|coins?|gems?|keys?)\b)|\bcollect(?:s|ing|ed)?\b|\bgather(?:s|ing)?\b|\bfind(?:s|ing)?\b(?! (?:the |a |an |your |their )?(?:exit|way|door|portal|path)\b)|\b(?:pick(?:s|ing)?|scoop(?:s|ing)?) up\b|\bgrab(?:s|bing)?\b|\bsteal(?:s|ing)?\b|\bstole\b|\beat(?:s|ing)?\b|\bhoard(?:s|ing)?\b|\bloot(?:s|ing)?\b|\bsearch(?:es|ing)?\b|\b(?:hunt(?:s|ing)?|look(?:s|ing)?) for\b|\b(?:treasure|scavenger|egg) hunts?\b|\bpick(?:s|ing)?(?= (?:[a-z]+ ){0,2}(?:herbs?|flowers?|berries|apples?|fruits?|mushrooms?|cherries|grapes)\b)/,
    [act('collect')],
  ),
  // „collect all the coins“, „find 5 keys“: sebrat všechno je cíl, ne jen akce.
  row(new RegExp(String.raw`\b(?:(?:collect|gather|find|grab|eat|steal)(?:s|ing)?|pick(?:s|ing)? up) (?=(?:all|every|each|${NUMBER})\b)`), [goal('collect')]),
  // Dojít k věci a něco s ní udělat: rozsvítit, osvobodit, zmáčknout, uhasit, prasknout.
  row(INTERACT, [act('interact'), goal('each')]),
  // Hlídkovat je hlídat: „wolves patrol“, „wolves who patrol the canyon“, „a lynx patrols the canyon“.
  // Sloveso patří podmětu; „a guard patrol“ / „border patrol“ zůstává jménem hrozby.
  row(/(?<=\b(?!(?:his|its|this|is|was|has|does|as|us)\b)[a-z-]+s (?:(?:who|that|which) )?)patrol\b|(?<=\b(?:a|an|the) [a-z-]+ )patrols\b|\bpatroll(?:ing|ed)\b/, [{ axis: 'unknown', id: 'guard', who: 'doer', fallback: false }]),
  row(/\bcarr(?:y|ies|ying)\b|\bdeliver(?:s|ing)?\b|\bbring(?:s|ing)?\b|\bescort(?:s|ing)?\b|\bserv(?:e|es|ing)\b|\bfetch(?:es|ing)?\b/, [act('deliver'), goal('each')]),
  row(/\bstack(?:s|ing)?\b/, [act('stack'), goal('build')]),
  row(/\bbuild(?:s)?\b|\bbuilding (?=(?:a|an|the|games?|towers?|houses?|bridges?|castles?)\b)|\bconstruct(?:s|ing)?\b/, [goal('build'), act('stack', true)]),
  row(/\bat the (?:right|perfect|exact) (?:time|moment|second)\b|\btiming\b|\btim(?:e|es|ing) (?=(?:your|his|her|their|each|every)\b)|\bstop(?:s|ping)? the (?:moving|swinging|spinning|sliding)\b|\bcut(?:s|ting)? the ropes?\b/, [act('time')]),
  // Do rytmu se hraje bez předmětu (korpus P41: `beat` má vždy `object: null`); „at a rock concert“ je místo,
  // a rytmická hra s ním by přiznala „Beat isn't here yet“ (P56A T9).
  row(/\bdanc(?:e|es|ing)\b|\b(?:to|with|on) the (?:beat|music|rhythm)\b|\bto music\b|\brhythm\b|\bmusic(?:al)? games?\b|\bdrum(?:s|ming)?\b|\bpiano\b|\bguitar\b|\bsing(?:s|ing)?\b|\bkaraoke\b|\bbeat saber\b/, [{ axis: 'action', id: 'beat', who: 'bare', fallback: false }]),
  // Spor jeden na jednoho: předmět je protějšek („argue with my boss“, „play chess with a dragon“).
  row(
    /\bduel(?:s|ing|led|ling)?\b|\bargu(?:e|es|ing)\b|\bnegotiat(?:e|es|ing)\b|\bconvinc(?:e|es|ing)\b|\bpersuad(?:e|es|ing)\b|\bdebat(?:e|es|ing)\b|\bchess\b|\bcheckers\b|\bpoker\b|\b(?:play(?:s|ing)?|game of) cards\b|\btic[- ]tac[- ]toe\b|\brock[ ,-]+paper[ ,-]+scissors\b|\bstaring contest\b|\bshowdown\b|\bquick ?draw\b/,
    [act('duel')],
    { lead: 'with' },
  ),

  // Cíl. „a race car“ je auto, ne závod; „race against X“ jmenuje soupeře.
  row(/\brac(?:e|es|ing|er|ers)\b(?! cars?\b)|^race(?= cars?\b)|(?<=and )race(?= cars?\b)|\bgrand prix\b|\blaps?\b|\bfinish (?:line|first)\b|\bfirst place\b/, [goal('race'), threat('rival', 'versus')]),
  row(
    /\breach(?:es|ing)? (?=(?:the|a|an|its|his|her|their|your)\b)|(?<=\bto )reach\b(?=\s*(?:[,.;!?]|$))|\bget(?:s|ting)? (?:back )?to (?=(?:the|a|an|its|his|her|their|your)\b)|\bmak(?:e|es|ing) it (?:to|home|out)\b|\bfind(?:s|ing)? (?=(?:the |a |an |your |their )?(?:exit|door|portal|path)\b)|\bfind(?:s|ing)? (?:the |a |your |their )?way (?:out|home|back)\b|\bget(?:s|ting)? (?:home|out)\b|\bgo(?:es)? home\b|\bto the (?:top|end|exit|finish|goal)\b/,
    [goal('reach')],
    { keepPlace: true },
  ),
  row(
    new RegExp(String.raw`\bas long as (?:possible|you can)\b|\bsurviv(?:e|es|ed|ing)\b|\boutlast(?:s|ing)?\b|\bstay(?:s|ing)? alive\b|\bdefend(?:s|ing)?\b|\bprotect(?:s|ing)?\b|\btower defen[cs]e\b|\b(?:for|last(?:s|ing)?) ${NUMBER}[ -](?:seconds?|minutes?)\b`),
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
const DRIVEN = ['car', 'truck', 'bike', 'bicycle', 'motorcycle', 'motorbike', 'kart', 'go-kart', 'boat', 'ship', 'yacht', 'speedboat', 'sailboat', 'jetski', 'canoe', 'kayak', 'raft', 'bus', 'taxi', 'van', 'tractor', 'tank', 'train', 'tram', 'jeep', 'buggy', 'scooter', 'ambulance', 'firetruck', 'limo', 'racecar', 'hovercraft', 'snowmobile'];
const FLOWN = ['plane', 'airplane', 'aeroplane', 'jet', 'helicopter', 'rocket', 'spaceship', 'spacecraft', 'ufo', 'drone', 'glider', 'blimp', 'submarine'];
const VEHICLE_MOVE: ReadonlyMap<string, MoveId> = new Map([...DRIVEN.map((word) => [word, 'drive'] as const), ...FLOWN.map((word) => [word, 'glide'] as const)]);
const TOOL_HEADS = new Set(['gun', 'cannon', 'blaster', 'rifle', 'pistol', 'weapon', 'sword', 'bow', 'slingshot', 'catapult', 'launcher']);
const VEHICLE = new RegExp(`\\b(${[...VEHICLE_MOVE.keys()].map(word => word.endsWith('y') ? `${word.slice(0, -1)}(?:y|ies)` : `${word}(?:e?s)?`).join('|')})\\b`, 'g');

/** Prostředí věty; vyhrává to, které věta řekne dřív, při shodě dřívější řádek. Noc jen tehdy, když místo chybí. */
const SETTINGS: readonly (readonly [string, RegExp])[] = [
  ['ocean', /\boceans?\b|\bseas?\b(?! ?(?:floor|bed)\b)/],
  ['underwater', /\bunder ?water\b|\bunder the sea\b|\bsunken\b|\bshipwrecks?\b|\bcoral reefs?\b|\breefs?\b|\bsea ?(?:floor|bed)\b|\bdeep sea\b/],
  ['space', /\b(?:outer )?space\b(?![ -]?bar)|\bgalax(?:y|ies)\b|\bplanets?\b|\bmoon\b|\bmars\b|\borbit\b|\bcosmos\b/],
  ['city', /\bcit(?:y|ies)\b|\btowns?\b|\bstreets?\b|\bdowntown\b|\bhighways?\b|\brooftops?\b|\bneon\b|\bmetropolis\b/],
  ['forest', /\bforests?\b|\bwoods\b|\bwoodlands?\b/],
  ['jungle', /\bjungles?\b|\brainforests?\b/],
  ['desert', /\bdeserts?\b|\bdunes?\b|\bsahara\b/],
  ['snow', /\bsnowy?\b|\barctic\b|\bglaciers?\b|\bfrozen\b|\bwinter\b|\bpolar\b|\btundra\b|\bnorth pole\b|\bunder (?:the )?ice\b/],
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
const OTHER_PLACES = /^(?:maze|labyrinth|room|track|road|level|world|map|area|arena|field|course|top|end|exit|finish|floor|ground|place|park|home|garden|backyard|yard|stadium|carnival|circus|zoo|library|airport|station|subway|hotel|hangar|valley|canyon|tunnel|cabin|studio|theater|savanna|gate)$/;

const inSetting = (word: string): boolean => SETTINGS.some(([, pattern]) => pattern.test(word));
const isPlace = (word: string): boolean => OTHER_PLACES.test(word) || /^(?:ruin|bunker|fort|compound|courtyard)$/.test(word) || NIGHT.test(word) || inSetting(word);

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
  'top-down', 'side-scrolling', 'first-person', 'third-person', 'twin-stick',
  'combat', 'race', 'no', 'any', 'more', 'other', 'every', 'only', 'just', 'also', 'not', 'very', 'too', 'really',
]);
/** Předmět, který věc ve hře nejmenuje: čas, skóre, míra, citoslovce („race against time“, „survive 60 seconds“, „lol“). */
const NOT_A_THING = new Set([
  'time', 'clock', 'score', 'point', 'stuff', 'thing', 'everything', 'anything', 'something', 'nothing', 'everyone', 'everybody', 'all', 'way',
  'other', 'second', 'minute', 'hour', 'day', 'game', 'level', 'fun', 'lot', 'one', 'round', 'match', 'win', 'royale', 'noon', 'dawn', 'dusk',
  'wave', 'till', 'sunset', 'sunrise', 'midnight', 'lol', 'lmao', 'haha', 'pls', 'plz', 'vibe', 'style', 'mode',
]);
/** Pomocná slovesa za podmětem („a dog tries to catch…“); na nich jméno aktéra končí. */
const AUXILIARIES = new Set(['must', 'can', 'will', 'should', 'has', 'have', 'is', 'are', 'was', 'were', 'gets', 'wants', 'tries', 'needs', 'likes', 'loves', 'keeps', 'starts', 'begins', 'learns', 'decides', 'having', 'just', 'want', 'need', 'try', 'like', 'love', 'get', 'keep']);
/** Slova, která po podmětu sloveso hry nejsou („is“, „has“, „wants to“) – neznámou položkou se nestanou. */
const LIGHT_VERBS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'does', 'do', 'did', 'gets', 'get', 'got', 'wants', 'want', 'needs', 'need',
  'tries', 'try', 'likes', 'like', 'loves', 'love', 'lives', 'live', 'goes', 'go', 'comes', 'come', 'keeps', 'keep', 'starts', 'start', 'begins',
  'begin', 'becomes', 'become', 'seems', 'seem', 'looks', 'look', 'lets', 'let', 'can', 'could', 'must', 'will', 'would', 'should', 'may', 'might',
  "can't", 'cant', "don't", 'dont', "doesn't", 'doesnt', "won't", 'wont', 'cannot', 'also', 'just', 'always', 'then', 'still', 'never', 'not',
  'says', 'say', 'sees', 'see', 'knows', 'know', 'thinks', 'think', 'feels', 'feel', 'means', 'mean', 'stays', 'stay', 'uses', 'use', 'gonna',
]);
/** Slovo, které hru zadává nebo ovládá, ne popisuje („make a game where…“, „tap to jump“). */
const META_VERBS = new Set(['make', 'create', 'design', 'generate', 'give', 'show', 'write', 'explain', 'imagine', 'play', 'want', 'need', 'let', 'please', 'add', 'do', 'i', 'we', 'you', 'tap', 'click', 'hold', 'swipe', 'touch', 'drag', 'keep', 'continue']);

const headOf = (phrase: string): string => {
  const head = phrase.split(' ').at(-1) ?? phrase;
  return ({ snowmen: 'snowman', tomatoes: 'tomato', mars: 'mars', froggy: 'frog' } as Record<string, string>)[head] ?? singular(head);
};

/** Jmenná fráze z lexikonu, uťatá před členem nebo předložkou uvnitř („a sled down a hill“ → sled). */
const CUT = new Set([...ARTICLE_WORDS, ...PARTICLES, 'against', 'vs', 'versus', 'like', 'than', 'about', 'during', 'near', 'past', 'instead', 'till']);
function phraseIn(text: string): string | null {
  // A partitive names its contents, unlike a physical object's ownership
  // ("a loaf of bread" versus "the door of a castle").
  const contents = /^\s*(?:(?:a|an|the|some|each|every|two|three|four|\d+)\s+)?(?:loaf|loaves|slice|slices|piece|pieces|cup|cups|bowl|bowls|bottle|bottles|bag|bags|box|boxes|basket|baskets|handful|handfuls|spoonful|spoonfuls|pound|pounds|kilo|kilos)\s+of\s+(.+)/.exec(text);
  if (contents) return phraseIn(contents[1]);
  // A determiner and material/condition modifiers distinguish the container
  // noun from modal "can" in "a robot can jump".
  const container = /^\s*(?:a|an|the|some|every|each)\s+((?:(?:tin|metal|steel|aluminium|aluminum|empty|full|rusty|crushed)\s+){0,2}can)\b/.exec(text);
  if (container) return container[1];
  const words = nounPhrase(text, 3)?.split(' ') ?? [];
  const cut = words.findIndex((word, index) => index > 0 && CUT.has(word));
  const kept = cut === -1 ? words : words.slice(0, cut);
  return kept.length === 0 || (kept.length === 1 && ARTICLE_WORDS.has(kept[0])) ? null : kept.join(' ');
}

/**
 * Aktér z textu mezi začátkem klauze a slovesem: jednotné číslo hlavy jmenné fráze,
 * `HERO` pro hráče („you“, „the player“), `null`, když tam nikdo není („and shoots“, „he“, rozkaz).
 */
const ACTOR_FRAME = /^(?:(?:make|create|build|give me|i want) (?:a|an|the) (?:game|story|adventure) (?:about|with|featuring) |(?:let|have|send|make|keep|give me) )(?=(?:a|an|the)\s)/;

function actorIn(segment: string): string | null {
  // „with zombies chasing u“: honí zombie; „with swords cutting fruit to music“ ale meče k hudbě netančí.
  const trimmed = segment.trim().replace(ACTOR_FRAME, '');
  if (/^with\s/.test(trimmed) && /\b[a-z]{2,}ing\b/.test(trimmed)) return null;
  const bare = trimmed.replace(/^with\s+/, '').replace(/^(?:(?:a|an|the|my|your|our|this|that|some|one)(?:\s+|$))+/, '');
  const first = bare.split(' ')[0];
  if (PLAYER_WORDS.has(first)) return HERO;
  // „play chess with…“: rozkaz na začátku věty podmět nemá.
  // „where there is shooting…“: existenciální „there“ podmět nemá.
  if (first === '' || first === 'there' || OTHER_PRONOUNS.has(first) || META_VERBS.has(first) || LIGHT_VERBS.has(first)) return null;
  const words = nounPhrase(bare, 4)?.split(' ') ?? [];
  // „pull the pins to…“, „knock down towers…“: člen nebo částice uvnitř = sloveso a jeho předmět, ne podmět.
  if (words.some((word, index) => index > 0 && (ARTICLE_WORDS.has(word) || PARTICLES.has(word)))) return null;
  // „a dog needs to“, „a dog chases“: slovo na -s za jednotnou hlavou je sloveso, ne jméno (jako `subjectOf` v lexikonu).
  // Za „race“ / „racing“ ne: „racing cars“ jsou auta, jako řádek závodu čte „a race car“ (P65 T6b).
  const kept: string[] = [];
  for (const word of words) {
    const previous = kept.at(-1);
    if (AUXILIARIES.has(word) || LIGHT_VERBS.has(word) || (previous !== undefined && /[^s]s$/.test(word) && !previous.endsWith('s') && !/^rac(?:e|ing)$/.test(previous))) break;
    kept.push(word);
  }
  const head = kept.at(-1);
  if (head === undefined) return null;
  if (PLAYER_WORDS.has(head)) return HERO;
  const name = /^(?:horde|pack|swarm|herd|flock)$/.test(head) && kept.length > 1 ? headOf(kept[kept.length - 2]) : headOf(head);
  // „a never-ending runner“, „a fast-paced shooter“: přídavné jméno se spojovníkem postava není.
  const measure = new RegExp(`^${NUMBER}-(?:seconds?|minutes?|hours?|days?|metres?|meters?|miles?|laps?)$`).test(name);
  return measure || NOT_AN_ACTOR.has(name) || NOT_A_THING.has(name) || ING_ADJECTIVES.has(name) || isPlace(name) || /-[a-z]+(?:ing|ed|like|style|themed)$/.test(name) ? null : name;
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
const COLLECTIVE = /^(?:(?:a|an|the|huge|giant|big|endless|whole) )*(?:waves?|hordes?|packs?|swarms?|arm(?:y|ies)|bunch(?:es)?|herds?|flocks?|lots?|tons?|piles?|groups?|crowds?|gangs?|teams?|fleets?|schools?|stacks?) of /;
const QUANTIFIED = new RegExp(`^(?:all|every|each|many|lots of|${NUMBER})\\b`);
const ONLY_DETERMINERS = /^ ?(?:a|an|the|all|every|each|some|my|your|his|her|their|its|our)(?: (?:a|an|the|all|every|each|some|my|your|his|her|their|its|our))* ?$/;

function thingIn(text: string, from: number, limit: number, lead: string | undefined, tools: readonly string[], projectile = false): Thing | null {
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
  const aimed = projectile || tools.includes(singular(phrase)) || /^(?:cannon|star|snowball|arrow|rocket|missile|bullet|fireball)s?$/.test(headOf(phrase)) ? / (?:at|into|onto|toward|towards) /.exec(text.slice(start, to)) : null;
  if (aimed !== null) {
    start += aimed.index + aimed[0].length;
    const target = text.slice(start, to);
    const pronoun = /^(them|him|her|it|you)\b/.exec(target);
    phrase = pronoun?.[1] ?? phraseIn(target) ?? phrase;
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
/** Slovesa s předmětem, která berou jméno před „to“ jako předmět („with moths to catch“). */
const RELATIVE_OBJECT_VERBS = new Set(['collect', 'catch', 'throw', 'deliver', 'reach']);
/**
 * Sloveso mimo tabulku: na osu, kam ho přiblíží tabulka P44C, jinak osa `unknown`.
 * Sloveso ruční rodiny („lassos“ → pastevectví) zůstává `unknown` – rodinu čte žánr z téhle osy.
 * Tabulka čte napřed slovo z věty: tvary umí sama, kdežto `gerundBase` „strafing“ zkrátí na „straf“.
 */
function unknownRow(verb: string, said: string): Row {
  const vocab = familyOf(verb) === null ? (vocabVerb(said) ?? vocabVerb(verb)) : null;
  if (vocab?.axis != null && vocab.id !== null) return row(/$^/, [{ axis: vocab.axis, id: vocab.id, who: 'doer', fallback: false, mapped: true }]);
  return row(/$^/, [{ axis: 'unknown', id: verb, who: 'doer', fallback: false }]);
}

function hitsOf(text: string): Hit[] {
  const hits = ROWS.flatMap((entry) =>
    [...text.matchAll(new RegExp(entry.pattern.source, 'g'))].map((match) => ({ row: entry, at: match.index, end: match.index + match[0].length, said: match[0].trim() })),
  ).filter(hit => !(hit.row.emits.some(emit => emit.id === 'ball')
    && /\b(?:before|after) (?:the |a |an )?$/.test(text.slice(0, hit.at))
    && /^ (?:game|match)\b/.test(text.slice(hit.end))));
  return hits.filter(hit => {
    if (hit.row !== BARE_FIRE) return true;
    const prefix = text.slice(0, hit.at);
    if (!/(?:^|\b(?:and|then|but)\s+|[,;]\s*)(?:(?:do not|don'?t|never|not)\s+)?$/.test(prefix)) return false;
    const prior = hits.filter(other => other.end <= hit.at && !isNounRow(other.row)).sort((a, b) => a.at - b.at).at(-1);
    return !prior?.row.emits.some(emit => emit.id === 'avoid');
  });
}

/** Hranice klauze: interpunkce a spojky. „who / that / which“ navíc říkají, že podmět stojí před nimi. */
interface Boundary {
  readonly at: number;
  readonly end: number;
  readonly word: string;
}
const BOUNDARY = /[,.;:!?]|\b(?:and|but|or|while|whilst|where|when|whenever|then|so|that|who|which|until|before|after|because|if|unless)\b/g;

/** Hrozba je vypnutá jen záporem přímo před ní („no guards“, „without any rivals“). */
const NEGATED_NOUN = /\b(?:no|without)(?: (?:any|other|more|the))* $/;

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
/** `modifies(hit, end)`: table hit that only describes the object of a candidate ending at `end`; it does not outrank the candidate. */
function unknownHits(text: string, clauses: readonly (readonly [number, number])[], taken: readonly Hit[], modifies: (hit: Hit, end: number) => boolean): Hit[] {
  const covered = (at: number, end: number): boolean => taken.some((hit) => at < hit.end && hit.at < end);
  const found: { at: number; said: string; verb: string; meta: boolean }[] = [];
  for (const [clauseFrom, to] of clauses) {
    const frame = ACTOR_FRAME.exec(text.slice(clauseFrom, to));
    const from = clauseFrom + (frame?.[0].length ?? 0);
    const words = [...text.slice(from, to).matchAll(/[a-z][a-z'-]*/g)].map((match) => ({ word: match[0], at: from + match.index }));
    const lead = words.length > 0 && ARTICLE_WORDS.has(words[0].word) ? 1 : 0;
    const subjectless = words.length === 0 || PLAYER_WORDS.has(words[lead]?.word ?? '') || OTHER_PRONOUNS.has(words[lead]?.word ?? '');
    for (let index = lead + 1; !subjectless && index < Math.min(words.length, lead + 4); index++) {
      const { word, at } = words[index];
      const previous = words[index - 1];
      // Podmět je jméno: ne předložka, člen, pomocné sloveso ani slovo, které tabulka už čte („shoot balloons with“).
      if (PHRASE_BREAK.has(word) || PHRASE_BREAK.has(previous.word) || LIGHT_VERBS.has(word) || ARTICLE_WORDS.has(previous.word) || covered(previous.at, previous.at + previous.word.length)) break;
      if (frame !== null && index === lead + 1 && words[index + 1] !== undefined && !PHRASE_BREAK.has(words[index + 1].word) && !NOT_AN_ACTOR.has(word)) {
        found.push({ at, said: word, verb: word.endsWith('ing') ? gerundBase(word) : word, meta: false });
        break;
      }
      if (/[^s]s$/.test(word) && (!previous.word.endsWith('s') || singular(previous.word) === previous.word)) {
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
    if (match[3] !== undefined || /^(?:while|when|where|and|but)$/.test(match[2])) continue;
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
      if (verbHits.some((hit) => hit.at >= end && hit.at < clauseEnd(at) && !modifies(hit, end))) return false;
      seen.add(at);
      return true;
    })
    .map(({ at, said, verb }) => ({ row: unknownRow(verb, said), at, end: at + said.length, said }));
}

/** Hráč věty: „play as a fox“, „you are a knight“, „drive a car through…“ (lexikon `readRoles`). */
const PLAYER_SAID = /\b(?:play(?:s|ing)? as|as|you(?:'re| are)|youre|i(?:'m| am)|you control|become) (?:an?|the|your) ([a-z][a-z -]*)|^(?:be|drive|ride|fly|pilot|steer|sail|race|land) (?:an?|the|your|my) ([a-z][a-z -]*)/;

/** Položka během skládání: pozice ve větě, domyšlenost a zápor. */
interface Draft extends IntentAction {
  readonly at: number;
  readonly fallback: boolean;
  readonly negated: boolean;
}

/** Spojky vedlejší věty, za kterými přichází nový podmět („while sharks bite“); čte je i `heroDoes` (`draft/controls`). */
export const CLAUSE_SUBORDINATORS: ReadonlySet<string> = new Set(['while', 'as', 'when', 'whenever', 'until', 'before', 'after', 'because']);

/**
 * Předmět slovesa je hrdina hry (P52 T3): „enemy turrets fire at a little robot crossing…“, „guards shoot at
 * you“, „hawks grab at a field mouse running…“ – střílí a chňapá holý množný podmět na začátku věty.
 * „kids shoot at the cans“ hrdinovi zůstane: předmět bez děje není hrdina.
 */
const AT_THE_PROTAGONIST = /^ at (?:(?:you|u|me|him|her|them|us)\b|(?:a|an) (?:[a-z]+ ){0,2}[a-z]+ (?:[a-z]+ing|who|that)\b)/;
const DETERMINERS = new Set(['a', 'an', 'the', 'one', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that']);
/** Slovesa záměru, ze kterých má hrdina tlačítko (`INTENT_ABILITY` v `draft/controls`). */
const HERO_BUTTON_VERBS: ReadonlySet<string> = new Set(['shoot', 'fight', 'kick']);
/** Zájmena hrdiny ve vedlejší větě („while he shoots“). */
const HERO_PRONOUNS = new Set(['he', 'she', 'it', 'you', 'u', 'i', 'we', 'they']);

/** `before` = slova věty před slovesem `said` na `at`. */
export function shootsAtTheHero(text: string, at: number, said: string, before: readonly string[]): boolean {
  const prev = before[before.length - 1];
  return prev !== undefined && before.length <= 3 && !DETERMINERS.has(before[0]!) && /s$/.test(prev) && AT_THE_PROTAGONIST.test(text.slice(at + said.length));
}

/**
 * Sloveso na `at` dělá nepřítel (P52 T3): podmět vedlejší věty, který hrdina (`hero`) není („as hunters
 * shoot“, „while the drones blast at him“), nebo `shootsAtTheHero`. Akce nepřítele hrdinovi tlačítko nedá.
 */
export function enemyDoes(text: string, at: number, hero: string | null): boolean {
  const before = text.slice(0, at).match(/[a-z']+/g) ?? [];
  const said = text.slice(at).match(/^[a-z']+/)?.[0] ?? '';
  if (shootsAtTheHero(text, at, said, before)) return true;
  const tail = before.slice(-4);
  let from = tail.length - 1;
  while (from >= 0 && !CLAUSE_SUBORDINATORS.has(tail[from]!)) from--;
  if (from < 0 || from === tail.length - 1) return false;
  const subject = tail.slice(from + 1).filter((word) => !DETERMINERS.has(word));
  const heroHead = hero?.split(' ').pop();
  return subject.length > 0 && subject.every((word) => !HERO_PRONOUNS.has(word) && !/ing$/.test(word) && word !== heroHead && singular(word) !== heroHead);
}

export function extractIntent(sentence: string): Intent {
  const text = withoutPossessor(sentence.toLowerCase().replace(/[’‘]/g, "'").replace(/\bthru\b/g, 'through').replace(/\bfootbal\b/g, 'football').replace(/\bn\b/g, 'and').replace(/\s+/g, ' ').trim());
  // A pseudo-cleft fronts the object: "pearls are what the swimming seal
  // must collect". Normalize that syntax, then reuse ordinary clause parsing.
  const cleft = /^(?:(in|at|inside|near) ([^,]+),\s*)?([a-z][a-z -]*?) (?:is|are) what (?:a|an|the) (?:(swimming|running|jumping|flying|walking|flapping|roaming|gliding) )?([a-z][a-z-]*) (?:(?:must|should|can|will) )?([a-z][a-z-]*)([.!?]?)$/.exec(text);
  if (cleft !== null) {
    const [, preposition, place, object, movement, actor, verb] = cleft;
    const normalized = `${place ? `${preposition} ${place}, ` : ''}a ${actor} ${movement ? `${movement} and ` : ''}${verb} ${object}`;
    return { ...extractIntent(normalized), sentence };
  }
  const tools = toolsOf(text);
  const scopes = negationScopes(text);
  const inScope = (at: number): boolean => scopes.some(([from, to]) => at >= from && at < to);

  const boundaries: Boundary[] = [...text.matchAll(BOUNDARY)].map((match) => ({ at: match.index, end: match.index + match[0].length, word: match[0] }));
  const clauses = [0, ...boundaries.map((boundary) => boundary.end)].map((from, index) => [from, boundaries[index]?.at ?? text.length] as const);

  const tableHits = hitsOf(text);
  const order = (a: Hit, b: Hit): number => a.at - b.at || ROWS.indexOf(a.row) - ROWS.indexOf(b.row);
  // A movement participle before an opponent noun describes that noun, not
  // a second player command: 'fights flying skeletons', 'from swimming sharks'.
  // Keep it covered for unknown-verb detection and inside the preceding object.
  const participle = (hit: Hit): boolean => {
    if (!/ing$/.test(hit.said) || !hit.row.emits.some(emit => emit.axis === 'move')) return false;
    const following = /^ ([a-z-]+)\b/.exec(text.slice(hit.end))?.[1];
    return following !== undefined && !/^(?:a|an|the|through|over|across|around|away|up|down|to|in|on|with|from|and|while)$/.test(following);
  };
  // Directly after an unknown verb too: 'slices flying acorns' cuts acorns, the fox does not fly (P54C).
  const objectModifier = (hit: Hit, verbEnd: number): boolean => hit.at >= verbEnd && participle(hit) && /^\s*(?:(?:a|an|the|some)\s+)?$/.test(text.slice(verbEnd, hit.at));
  const unknown = unknownHits(text, clauses, tableHits, objectModifier);
  const nounModifier = (hit: Hit): boolean => {
    if (!participle(hit)) return false;
    if (unknown.some(verb => objectModifier(hit, verb.end))) return true;
    const prior = tableHits.filter(candidate => candidate.end <= hit.at && !isNounRow(candidate.row)).at(-1);
    if (prior === undefined || boundaries.some(boundary => boundary.at >= prior.end && boundary.end <= hit.at)) return false;
    return /\b(?:from|against|at|past)\s+(?:(?:a|an|the|some)\s+)?$/.test(text.slice(prior.end, hit.at))
      || prior.row.emits.some(emit => emit.who === 'doer' && emit.axis !== 'move') && /^\s*(?:(?:a|an|the|some)\s+)?$/.test(text.slice(prior.end, hit.at));
  };
  const verbHits = [...tableHits.filter((hit) => !isNounRow(hit.row) && !nounModifier(hit)), ...unknown].sort(order);
  const nounHits = tableHits.filter((hit) => isNounRow(hit.row));

  // Kdo a komu: podmět je text od hranice klauze (nebo od předchozího slovesa a jeho předmětu) po sloveso,
  // předmět fráze za slovesem – „sneaks past guards to steal a fish“ krade kočka, ne stráže.
  const readings: { readonly hit: Hit; readonly actor: string | null; readonly thing: Thing | null }[] = [];
  let reached = 0;
  for (const hit of verbHits) {
    const boundary = boundaries.filter((candidate) => candidate.end <= hit.at).at(-1);
    const from = Math.max(boundary?.end ?? 0, Math.min(reached, hit.at));
    const segment = text.slice(from, hit.at);
    const next = hit.row.emits.some(emit => emit.axis === 'unknown') ? text.length : verbHits.find((other) => other.at >= hit.end && !(hit.row.emits.some(emit => emit.id === 'avoid') && other.row.before === 'modifier'))?.at ?? text.length;
    let after = thingIn(text, hit.end, next, hit.row.lead, tools, hit.row.emits.some(emit => emit.id === 'throw' || emit.id === 'shoot'));
    // Reduced relative infinitives attach to the noun before them: coins to
    // collect / a basket of berries to gather / moths to catch / parcels to
    // deliver. The noun is not a new actor.
    const relativeObject = hit.row.emits.some(emit => RELATIVE_OBJECT_VERBS.has(emit.id))
      ? /\bwith\s+([^,.;!?]*?)\s+to\s*$/.exec(text.slice(0, hit.at)) : null;
    if (after === null && relativeObject) {
      const phrase = phraseIn(relativeObject[1]);
      if (phrase) after = { head: headOf(phrase), many: singular(phrase) !== phrase, at: relativeObject.index + relativeObject[0].indexOf(relativeObject[1]), end: hit.at, via: null };
    }
    // Separable phrasal verbs carry their object inside the matched verb span.
    const internal = hit.row.emits.some(emit => emit.id === 'defeat') ? /\b(it|him|her|them)\b/.exec(hit.said) : null;
    if (internal) after = { head: internal[1], many: internal[1] === 'them', at: hit.at + internal.index, end: hit.at + internal.index + internal[0].length, via: null };
    if (hit.row.emits.some(emit => emit.who === 'versus')) {
      // A place modifier may intervene between the sport/race and its opponent.
      // Do not cross a clause boundary or another verb to borrow its target.
      const end = Math.min(next, boundaries.find(candidate => candidate.at >= hit.end)?.at ?? text.length);
      const against = /\b(?:against|vs|versus)\s+/.exec(text.slice(hit.end, end));
      if (against) after = thingIn(text, hit.end + against.index, end, hit.row.lead, tools);
    }
    // Holé jméno těsně před slovem („water gun“, „sword fighting“), ne podmět ve 3. osobě („dog fights“).
    const bareBefore = (/^[a-z-]+ $/.test(segment) || /^(?:a|an|the) (?:snowball|sword|fist|knife|gun) $/.test(segment)) && !segment.trim().endsWith('s') && !/[^s]s$/.test(hit.said);
    if (hit.row.before === 'target') {
      const before = phraseIn(segment);
      const target = before === null ? null : { head: headOf(before), many: singular(before) !== before, at: from, end: hit.at, via: null };
      readings.push({ hit, actor: null, thing: target ?? after });
    } else if (hit.row.before === 'modifier' && (bareBefore || TOOL_HEADS.has(headOf(hit.said)) && /\bwith\s+(?:(?:a|an|the)\s+)?[a-z -]*$/.test(segment))) {
      // „with a water gun“, „with laser blasters“ (P65 T6b): přívlastek zbraně za „with“ střelcem není, se členem i bez něj.
      readings.push({ hit, actor: null, thing: after });
    } else {
      // The relative noun is the object; the doer is a named subject before „with“
      // („a hedgehog scurries … with a tower to reach“), never an imperative („put me …“).
      const subject = relativeObject ? text.slice(from, relativeObject.index) : segment;
      let actor = relativeObject && !/^\s*(?:a|an|the)\s/.test(subject) ? null : actorIn(subject);
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
  const namedPhrase = said === null ? null : phraseIn(said[1] ?? said[2]);
  const named = namedPhrase === null ? null : headOf(namedPhrase);
  const first = readings.find((reading) => reading.actor !== null && !(readings[0]?.actor === null && (readings[0].hit.at === 0 || /^(?:keep|continue)\s+$/.test(text.slice(0, readings[0].hit.at))) && reading.hit.at > (boundaries[0]?.at ?? text.length)) && !(reading.thing !== null && PLAYER_WORDS.has(reading.thing.head)));
  const objectSpans = readings.filter((reading) => reading.thing !== null && !reading.hit.row.emits.some((emit) => emit.axis === 'move' || emit.id === 'race' || emit.id === 'land'));
  const vehicle = [...text.matchAll(VEHICLE)].find(
    (match) => !inScope(match.index)
      // An imperative's subject remains the player; vehicles belonging to a
      // later while/before clause cannot become an implicitly piloted hero.
      // A vehicle driven by the same player in a coordinated clause still can.
      && !(readings[0]?.actor === null && readings[0].hit.at === 0 && readings.some(reading => reading.actor === headOf(match[1]) && reading.hit.at > (boundaries[0]?.at ?? text.length)))
      && !readings.some(reading => reading.actor === headOf(match[1]) && reading.thing !== null && PLAYER_WORDS.has(reading.thing.head) && reading.hit.row.emits.some(emit => emit.id === 'catch'))
      && !objectSpans.some(({ thing }) => thing !== null && match.index >= thing.at && match.index < thing.end),
  );
  // „where I build my house, drive cars“: kdo mluví sám za sebe, není auto – stroj v množném čísle hrdinou nebude.
  const ridden = vehicle !== undefined && !(readings[0]?.hit.at === 0 && readings[0].hit.row.emits.some(emit => emit.axis === 'unknown')) && (first?.actor !== HERO || vehicle[0] === headOf(vehicle[1])) ? headOf(vehicle[1]) : null;
  const gameSubject = /\b(?:a |an |the )?([a-z]+) game\b/.exec(text)?.[1];
  const gameHero = gameSubject === undefined || NOT_AN_ACTOR.has(gameSubject) || tools.includes(gameSubject) || /^(?:mini|sword)$|ing$/.test(gameSubject) || tableHits.some(hit => hit.at <= text.indexOf(gameSubject) && hit.end > text.indexOf(gameSubject)) ? null : actorIn(gameSubject);
  // A nominal relation has participants even without an ordinary subject/verb:
  // "an argument between a cat and a dog", "wizard vs wizard argument".
  const between = /\bargument between (.+?) and (.+?)(?:[,.]|$)/.exec(text);
  const pluralArgument = /\bargument between (?:two|2) (.+?)(?:[,.]|$)/.exec(text);
  const versusArgument = /^(.+?) (?:vs|versus) (.+?) argument\b/.exec(text);
  const marriage = /^(.+?) and (.+?) (?:get |gets |are )?married\b/.exec(text);
  const coordinatedDuel = /^(.+?) and (.+?) (duel(?:s|ing|ling)?|argu(?:e|es|ing))\b/.exec(text);
  // A reciprocal verb joins two noun subjects. Do not steal participants
  // from an earlier action in "a cat runs and a dog duels a fox".
  const pairedDuel = coordinatedDuel !== null && !verbHits.some(hit => hit.at < coordinatedDuel[0].length - coordinatedDuel[3].length) ? coordinatedDuel : null;
  const relation = between ?? versusArgument ?? pairedDuel ?? marriage;
  const relationActor = relation === null ? null : actorIn(relation[1]);
  const relationObject = relation === null ? null : actorIn(relation[2]);
  const pluralPhrase = pluralArgument === null ? null : phraseIn(pluralArgument[1]);
  const pluralActor = pluralPhrase === null ? null : headOf(pluralPhrase);
  const introduced = /^(?:(?:make|create|build|give me|i want) (?:a|an|the) (?:game|story|adventure) (?:about|with|featuring) |(?:let|have|send|make|keep|give me) )((?:a|an|the) [a-z][a-z -]*)/.exec(text);
  const companion = /\b(?:game|race|flight|stroll)\b[^.;!?]*?\bwith ((?:a|an|the) [a-z][a-z -]*)/.exec(text);
  const introducedStart = introduced === null ? 0 : introduced.index + introduced[0].indexOf(introduced[1]);
  const introducedEnd = verbHits.find(hit => hit.at >= introducedStart)?.at ?? text.length;
  const introducedActor = introduced === null ? null : actorIn(text.slice(introducedStart, introducedEnd));
  const companionActor = companion === null ? null : actorIn(companion[1]);
  const caused = introducedActor ?? (companionActor !== null && (TOOL_HEADS.has(companionActor) || tools.some(tool => headOf(tool) === companionActor)) ? null : companionActor)
    ?? /\bmake (?:a|an|the) ([a-z]+) (?=flap|jump|run|swim|fly|walk)/.exec(text)?.[1] ?? null;
  const described = /^(?:a|an|the) (?:dancing|singing|karate|boxing) ([a-z]+)\b/.exec(text)?.[1] ?? null;
  const chased = readings.find(reading => reading.hit.row.emits.some(emit => emit.id === 'catch') && reading.thing !== null);
  const fleeingObject = chased !== undefined && /\b(?:swim|run|fly) away\b.*\bescape\b/.test(text) ? chased.thing?.head ?? null : null;
  const hero = (named !== HERO ? named : null) ?? relationActor ?? pluralActor ?? (caused === HERO ? null : caused) ?? described ?? fleeingObject ?? (first !== undefined && first.actor !== HERO ? first.actor : null) ?? gameHero ?? ridden;
  const heroName = hero ?? HERO;

  const drafts: Draft[] = [];
  let previous: string | null = null;
  for (const { hit, actor: subject, thing } of readings) {
    if (readings.some(reading => reading.hit.at < hit.at && reading.hit.row.emits.some(emit => emit.id === 'avoid') && reading.thing !== null && hit.at >= reading.thing.at && hit.at < reading.thing.end)) continue;
    const actor: string = subject === HERO ? heroName : (subject ?? previous ?? heroName);
    // After "zombies chase you, run" the imperative belongs to the player,
    // not to the subject of the incoming threat.
    previous = thing !== null && PLAYER_WORDS.has(thing.head) && hit.row.emits.some(emit => emit.id === 'catch') ? heroName : actor;
    const place = thing !== null && isPlace(thing.head);
    let object = objectOf(thing, actor, heroName, hit.row.keepPlace === true);
    // Unsupported actions still retain their direct object, including a place
    // being worked on ("sweep the floor", "paint the room"). A game/genre noun
    // in "a knitting game" remains metadata rather than the knitted object.
    if (thing !== null && thing.via === null && hit.row.emits.some(emit => emit.axis === 'unknown')
      && (!NOT_A_THING.has(thing.head) || /^(?:clock|time|score)$/.test(thing.head)) && !PLAYER_WORDS.has(thing.head) && !OTHER_PRONOUNS.has(thing.head)) object = thing.head;
    if (thing !== null && OTHER_PRONOUNS.has(thing.head) && actor === heroName) {
      // Resolve an explicit target pronoun to the last named other participant.
      const antecedent = readings.filter(reading => reading.hit.at < hit.at && reading.thing !== null && !OTHER_PRONOUNS.has(reading.thing.head) && !PLAYER_WORDS.has(reading.thing.head) && reading.thing.head !== heroName).at(-1)?.thing;
      if (antecedent !== undefined && antecedent !== null) object = antecedent.head;
      else {
        const namedThreat = nounHits.filter(candidate => candidate.at < hit.at).at(-1);
        if (namedThreat !== undefined) object = headOf(namedThreat.said);
      }
    }
    const negated = inScope(hit.at);
    // Střelba a úder nepřítele („as hunters shoot“, „turrets fire at a robot crossing“) nejsou akce hrdiny (P52 T3);
    // jen slovesa tlačítek – „until the door unlocks“ zůstává, jak bylo.
    const enemyAction = hit.row.emits.some(emit => emit.axis === 'action' && HERO_BUTTON_VERBS.has(emit.id)) && enemyDoes(text, hit.at, hero);
    for (const emit of hit.row.emits) {
      const verb = emit.id === 'each' ? (thing?.many === true ? 'collect' : 'reach') : emit.id === 'avoid' ? threatOf(object) : emit.id;
      // "Light all lanterns" requests interaction, not picking the lanterns up.
      // The inferred route/quantity goal is guidance, never another essential verb.
      const base = { axis: emit.axis, verb, essential: !emit.fallback && emit.id !== 'each' && !(enemyAction && HERO_BUTTON_VERBS.has(emit.id)), said: hit.said, at: hit.at, fallback: emit.fallback, negated: negated && emit.axis !== 'threat', ...(emit.mapped ? { mapped: true as const } : {}) };
      if (emit.who === 'noun') drafts.push({ ...base, actor: hit.row.noun ?? headOf(hit.said), object: heroName });
      else if (emit.who === 'reverse' || emit.who === 'versus') {
        const opposed = emit.who === 'reverse' || /^(?:against|vs|versus)$/.test(thing?.via ?? '');
        if (object !== null && !place && opposed) drafts.push({ ...base, actor: object, object: actor });
      } else if (emit.who === 'bare') drafts.push({ ...base, actor, object: null });
      else drafts.push({ ...base, actor, object: (emit.axis === 'move' || emit.id === 'race') && object === actor ? null : object });
    }
  }

  // Hrozby jmenované slovem; co se střílí, hasí nebo sbírá („shoots lasers“, „puts out fires“), hrozbou není.
  const consumed = readings.filter(({ hit, thing }) => thing !== null && !inScope(hit.at) && hit.row.emits.some((emit) => emit.axis === 'action'));
  for (const hit of nounHits) {
    // Slovo, které tabulka čte jako sloveso („fires cannons“), hrozbou není.
    if (verbHits.some((verb) => hit.at >= verb.at && hit.at < verb.end)) continue;
    const raceRival = hit.row.emits.some(emit => emit.id === 'rival') && /\brac(?:e|es|ing)\b/.test(text);
    if (!raceRival && consumed.some(({ thing }) => thing !== null && hit.at >= thing.at && hit.at < thing.end)) continue;
    // „a lava cave“: láva jako přívlastek prostředí je kulisa; „laser blasters“ (P65 T6b): přívlastek zbraně hrozbou není.
    const next = /^ ([a-z]+)/.exec(text.slice(hit.end))?.[1];
    if (next !== undefined && TOOL_HEADS.has(headOf(next))) continue;
    const scenery = next !== undefined && inSetting(next);
    for (const emit of hit.row.emits) {
      const avoidedDetection = /^ (?:spotting|seeing|catching|detecting|noticing)\b/.test(text.slice(hit.end));
      drafts.push({ axis: emit.axis, verb: emit.id, actor: hit.row.noun ?? headOf(hit.said), object: heroName, essential: !scenery, said: hit.said, at: hit.at, fallback: false, negated: !avoidedDetection && NEGATED_NOUN.test(text.slice(0, hit.at)) });
    }
  }

  // Stroj jako hrdina jede nebo letí, i když to věta neřekne („game in a car“).
  const ride = hero === null ? undefined : VEHICLE_MOVE.get(hero);
  if (hero !== null && ride !== undefined) {
    const word = new RegExp(`\\b${hero}(?:e?s)?\\b`).exec(text);
    drafts.push({ axis: 'move', verb: ride, actor: hero, object: null, essential: true, said: word?.[0] ?? hero, at: word?.index ?? 0, fallback: false, negated: false });
  }

  // Contextual noun/verb readings. These describe grammar and semantic roles,
  // never a corpus sentence identity or the mechanic eventually selected.
  const push = (axis: IntentAxis, verb: string, actor: string, object: string | null, said: string): void => {
    drafts.push({ axis, verb, actor, object, said, essential: true, at: Math.max(0, text.indexOf(said)), fallback: false, negated: false });
  };
  // A subordinate falling/flying subject is a moving hazard, not scenery.
  // Separate scans keep an action before "falling branches" from becoming
  // the falling subject and consuming the adjective-noun match.
  const incoming = [
    /\b([a-z-]+)\s+(?:are\s+)?(?:fall(?:s|ing)?|drop(?:s|ping)?|rain(?:s|ing)?)\b/g,
    /\bfalling\s+([a-z-]+)\b/g,
    /\bflying\s+(rocks?|stones?|boulders?|bombs?|arrows?|lasers?|missiles?)\b/g,
    /\b(rocks?|stones?|boulders?|bombs?|arrows?|lasers?|missiles?)\s+(?:are\s+)?(?:fly|flies|flying)\b/g,
  ];
  for (const match of incoming.flatMap(pattern => [...text.matchAll(pattern)])) {
    if (verbHits.some(hit => hit.at === match.index)) continue;
    // 'catches falling acorns', 'slices flying fruit': what the hero catches or cuts is its target, not a hazard (P54C).
    if (/\b(?:catch(?:es|ing)?|collect(?:s|ing)?|grab(?:s|bing)?|slic(?:e|es|ing))\s+(?:(?:the|all|some|\d+)\s+)?$/.test(text.slice(0, match.index))) continue;
    const actor = headOf(match[1]);
    if (phraseIn(actor) === null || /^(?:asleep|apart|behind|down|off|over)$/.test(actor) || actor === heroName || PLAYER_WORDS.has(actor) || NOT_A_THING.has(actor) || inScope(match.index)) continue;
    for (let i = drafts.length - 1; i >= 0; i--) if (drafts[i].axis === 'threat' && drafts[i].actor === actor) drafts.splice(i, 1);
    push('threat', 'hazard', actor, heroName, match[0]);
  }
  for (const reading of readings) {
    if (inScope(reading.hit.at)) continue;
    if (reading.hit.row.emits.some(e => e.id === 'race') && reading.actor !== null && reading.actor !== heroName && reading.thing !== null && OTHER_PRONOUNS.has(reading.thing.head)) {
      push('threat', 'rival', reading.actor, heroName, reading.hit.said);
      push('objective', 'race', heroName, null, reading.hit.said);
    }
  }
  const runaway = /\bafter\s+(?:a |an |the )?runaway\s+([a-z-]+)/.exec(text);
  if (runaway && drafts.some(item => item.axis === 'move') && !inScope(runaway.index)) push('objective', 'catch', heroName, headOf(runaway[1]), runaway[0]);
  if (companion !== null && drafts.some(item => item.verb === 'race') && !drafts.some(item => item.axis === 'move') && /^(?:horse|pony|zebra|dog|rabbit|cheetah)$/.test(heroName)) push('move', 'run', heroName, null, heroName);
  const racers = /\brac(?:e|es|ing)\s+(?:against\s+)?(?:other\s+|the other\s+)([a-z-]+(?:\s+[a-z-]+)?)/.exec(text);
  if (racers !== null) {
    const phrase = phraseIn(racers[1]);
    if (phrase !== null) push('threat', 'rival', headOf(phrase), heroName, racers[0]);
  }
  if (drafts.some(item => item.verb === 'ball')) {
    const team = /\b(?:against|versus|vs)\s+(?:a |an |the )?(?:([a-z-]+)\s+team\b|team of\s+([a-z-]+))/.exec(text);
    if (team !== null) {
      const name = headOf(team[1] ?? team[2]);
      for (let i = drafts.length - 1; i >= 0; i--) if (drafts[i].verb === 'rival' && /^(?:a|team)$/.test(drafts[i].actor)) drafts.splice(i, 1);
      push('threat', 'rival', name, heroName, team[0]);
    }
  }
  // Direct race opponents ("a train races a plane") differ from a vehicle
  // being driven by the player ("race a car").
  for (const reading of readings) {
    if (inScope(reading.hit.at)) continue;
    const thing = reading.thing;
    if (reading.hit.row.emits.some(e => e.id === 'race') && thing !== null && thing.head !== heroName && !isPlace(thing.head) && !NOT_A_THING.has(thing.head) && !OTHER_PRONOUNS.has(thing.head) && !PLAYER_WORDS.has(thing.head) && thing.via === null) {
      push('threat', 'rival', thing.head, heroName, reading.hit.said);
    }
    // A movement directed to a named destination also requests reaching it.
    if (reading.hit.row.emits.some(e => e.axis === 'move')) {
      const destination = /^\s+to\s+(?:a |an |the )?([a-z-]+(?:\s+[a-z-]+)?)/.exec(text.slice(reading.hit.end));
      const phrase = destination === null ? null : phraseIn(destination[1]);
      if (phrase !== null && isPlace(headOf(phrase))) push('objective', 'reach', heroName, headOf(phrase), reading.hit.said);
    }
    // Coordinated objects share the avoidance verb, not a new implicit action.
    if (thing !== null && reading.hit.row.emits.some(e => e.id === 'avoid')) {
      const tail = text.slice(thing.end).split(/[,;.]|\b(?:while|but|then)\b/)[0]!;
      const following = /^\s+and\s+(?:a |an |the )?((?:[a-z-]+\s+)?[a-z-]+)/.exec(tail);
      const phrase = following === null ? null : phraseIn(following[1]);
      if (phrase !== null && !verbHits.some(h => h.at >= thing.end && h.at < thing.end + following![0].length)) push('threat', threatOf(headOf(phrase)), headOf(phrase), heroName, reading.hit.said);
    }
  }
  const eliminated = /\buntil\s+(?:every|all(?: the)?)\s+([a-z-]+)\s+(?:is|are)\s+(?:gone|defeated|dead|destroyed|eliminated)\b/.exec(text);
  if (eliminated !== null && drafts.some(item => item.verb === 'shoot' && !item.negated)) {
    const target = headOf(eliminated[1]);
    for (let i = 0; i < drafts.length; i++) if (drafts[i].verb === 'shoot' && drafts[i].object === null && !drafts[i].negated) drafts[i] = { ...drafts[i], object: target };
    push('objective', 'defeat', heroName, target, eliminated[0]);
  }
  if (/\bcombat\b/.test(text) && /\brockets?\b/.test(text)) push('action', 'shoot', heroName, null, 'rockets');
  const obstacleAlias = /\b([a-z]+) as obstacles?\b/.exec(text);
  if (obstacleAlias !== null) {
    for (let i = drafts.length - 1; i >= 0; i--) if (drafts[i].verb === 'obstacle' && drafts[i].actor === 'obstacle') drafts.splice(i, 1);
    push('threat', 'obstacle', headOf(obstacleAlias[1]), heroName, obstacleAlias[1]);
  }
  const chaseNoun = /(?<![a-z-])\b([a-z]+) chase\b/.exec(text);
  if (chaseNoun !== null && !NOT_A_THING.has(headOf(chaseNoun[1]))) push('threat', 'chaser', headOf(chaseNoun[1]), heroName, chaseNoun[0]);
  const rings = /\b(?:fly|flies|flying) through (?:the |some )?(rings?)\b/.exec(text);
  if (rings !== null) push('action', 'collect', heroName, 'ring', rings[0]);
  const ellipsis = /\b(?:don'?t|do not|never) (shoot|kick|collect|throw|fight) [^,;]+[,;] (?:only|just) (.+)/.exec(text);
  if (ellipsis !== null) {
    const target = phraseIn(ellipsis[2]);
    if (target !== null && /^(?:a|an|the|some)\b/.test(ellipsis[2])) push('action', ellipsis[1], heroName, headOf(target), ellipsis[1]);
  }
  for (let i = 0; i < drafts.length; i++) {
    let item = drafts[i];
    // A guard patrol is a patrol made of guards, not a second actor called
    // patrol. Keep bare patrols and other explicitly named groups distinct.
    if (item.axis === 'threat' && item.verb === 'guard' && item.actor === 'patrol' &&
        readings.some(reading => reading.hit.at === item.at && reading.thing !== null && /\bguards? patrols?\b/.test(text.slice(reading.thing.at, reading.thing.end)))) item = { ...item, actor: 'guard' };
    // Kdo hlídá, je hrozba pro hrdinu; hrdina, který sám hlídá, hrozbou pro sebe není.
    if (item.verb === 'guard' && item.axis === 'unknown' && item.actor !== heroName) item = { ...item, axis: 'threat', object: heroName };
    if (item.verb === 'throw') {
      const defendedFrom = /\b(?:defend|protect)(?:s|ing)? .+? from (?:a |an |the )?([a-z -]+?) by throw/.exec(text);
      const opponent = defendedFrom === null ? null : phraseIn(defendedFrom[1]);
      if (opponent !== null) item = { ...item, object: headOf(opponent) };
    }
    if (item.verb === 'rival' && /^(?:rival|opponent|competitor)$/.test(item.actor)) {
      const modifier = /^(?:rivals?|opponents?|competitors?)\s+([a-z-]+)/.exec(text.slice(item.at));
      if (modifier !== null && !CUT.has(modifier[1]) && !/^(?:and|but|or|while|where|when|then|who|which|until)$/.test(modifier[1]) && !verbHits.some(h => h.at === item.at + modifier[0].indexOf(modifier[1]))) item = { ...item, actor: headOf(modifier[1]) };
    }
    if (item.verb === 'plant' && item.object === 'flag') item = { ...item, axis: 'action', verb: 'interact' };
    if (item.verb === 'walk' && /^explor/.test(item.said) && !/\b(?:maze|labyrinth|cave)s?\b/.test(text)) item = { ...item, verb: 'roam' };
    if (item.verb === 'run' && /^roll/.test(item.said) && ride === undefined) item = { ...item, verb: 'ball' };
    if (item.verb === 'build' && /^stack/.test(item.said)) {
      const result = /\binto\s+(?:a |an |the )?([a-z-]+)/.exec(text.slice(item.at));
      if (result !== null) item = { ...item, object: headOf(result[1]) };
    }
    if (item.verb === 'fight' && !item.fallback && item.object === null) {
      // Combat and its coordinated result share a target: "attacks and
      // defeats a dragon". A different actor or negated result cannot supply it.
      const result = readings.find(r => r.hit.at > item.at && r.hit.row.emits.some(emit => emit.id === 'defeat')
        && r.thing !== null && !inScope(r.hit.at)
        && (r.actor === null || r.actor === item.actor || r.actor === HERO && item.actor === heroName)
        && !/\b(?:while|whilst|before|after|because|if|unless)\b|[.;!?]/.test(text.slice(item.at, r.hit.at)));
      if (result?.thing) item = { ...item, verb: result.thing.many ? 'fight' : 'duel', object: result.thing.head };
    }
    if (/^outrun/.test(item.said) && drafts.some(candidate => candidate.verb === 'race')) item = item.axis === 'threat' ? { ...item, verb: 'rival' } : { ...item, verb: 'race', object: null };
    if (item.verb === 'drive') item = { ...item, object: null };
    if (item.verb === 'time' && /^(?:jump|throw|shot|kick)$/.test(item.object ?? '')) item = { ...item, object: null };
    if (item.verb === 'survive') item = { ...item, object: null, ...(/^(?:defend|protect)/.test(item.said) ? { essential: false, fallback: true } : {}) };
    if (item.verb === 'land') {
      const landing = /\bland(?:s|ing)?\b(?:[^,.;]*?)\b(?:on|at) (?:a |an |the )?(?:moving |safe |small )?([a-z]+)/.exec(text);
      if (landing !== null) item = { ...item, object: headOf(landing[1]) };
    }
    if (item.verb === 'fight' && !item.fallback) {
      const reading = readings.find(reading => reading.hit.at === item.at);
      // An explicit single opponent is a one-on-one duel. Plurals, hordes and
      // quantifiers retain the crowd-fighting mechanic.
      if (reading?.thing !== null && reading?.thing !== undefined && !reading.thing.many &&
          /^\s+(?:against\s+)?(?:a|an|the)\s+/.test(text.slice(reading.hit.end, reading.thing.end))) item = { ...item, verb: 'duel' };
    }
    if (item.verb === 'duel') {
      const multiple = /\b(?:two|2) [a-z]+(?: [a-z]+)?\b/.test(text);
      if (relationActor !== null && relationObject !== null) item = { ...item, actor: relationActor, object: relationObject };
      else if (pluralActor !== null) item = { ...item, actor: pluralActor, object: pluralActor };
      else if (multiple && (item.object === null || tools.includes(item.object) || item.object === 'sword')) item = { ...item, object: heroName };
    }
    if (item.verb === 'marry' && relationObject !== null) item = { ...item, actor: heroName, object: relationObject };
    if (described !== null && item.actor !== described && item.axis !== 'threat') item = { ...item, actor: described };
    if (described !== null && item.object === described) item = { ...item, object: null };
    if (item.verb === 'land' && item.object !== null && /^(?:standing|upright|safely|softly)$/.test(item.object)) item = { ...item, object: null };
    if (fleeingObject !== null && item.verb !== 'catch' && item.axis !== 'threat') item = { ...item, actor: heroName };
    if (item.verb === 'score' && /\bscore as many goals\b/.test(text)) item = { ...item, object: 'goal' };
    if (item.verb === 'kick' && /\bkick(?:s|ing)? (?:a|the) can\b/.test(text)) item = { ...item, object: 'can' };
    if (/\bbasketball\b/.test(text) && (item.verb === 'shoot' || item.verb === 'throw')) {
      // A basketball is ammunition in "throw a basketball into a hoop".
      // Preserve that explicit target; only an untargeted sports shot gets ball.
      const targetText = /\b(?:at|into|onto|towards?) (?:a |an |the )?([a-z][a-z -]*)/.exec(text)?.[1];
      const target = targetText === undefined ? null : phraseIn(targetText);
      item = { ...item, verb: 'throw', object: target === null ? 'ball' : headOf(target) };
    }
    // A rhythm/fight fallback cannot certify singing, an instrument or chess.
    if ((item.verb === 'beat' && drafts.some(candidate => candidate.axis === 'unknown' && /^(?:sing|play)$/.test(candidate.verb))) || (item.verb === 'duel' && /\bchess\b/.test(text))) item = { ...item, essential: false, fallback: true };
    if (item.verb === 'shoot' && drafts.some(candidate => candidate.verb === 'film' && candidate.at === item.at)) item = { ...item, essential: false, fallback: true };
    if (item.verb === 'race' && /\bfinish (?:my |your |the )?homework\b/.test(text)) item = { ...item, essential: false, fallback: true };
    drafts[i] = item;
  }
  if (/\bchess with (?:a|an|the) /.test(text)) {
    const opponent = /\bchess with (?:a|an|the) ([a-z]+)/.exec(text)?.[1];
    if (opponent !== undefined) push('threat', 'rival', headOf(opponent), heroName, 'chess');
  }

  const items = drafts.flatMap((item) => chasingTheHero(item, heroName));
  // Zápor: „with no shooting“ vyřadí střelbu celou; „don't shoot the hostages“ vedle „shoot zombies“ jen ten jeden terč.
  const kept = items.filter((item) => !item.negated);
  const refused = items.filter((item) => item.negated && !kept.some((other) => other.verb === item.verb && (item.object !== null || other.at > item.at)));
  const negated = [...new Set(refused.map((item) => item.verb))];
  const live = kept.filter((item) => !negated.includes(item.verb));
  const settled = live.filter((item) => !item.fallback || !live.some((other) => !other.fallback && other.axis === item.axis));

  return {
    sentence,
    hero,
    setting: settingOf(text),
    items: unique(settled.sort((a, b) => a.at - b.at)).map(({ actor, verb, object, axis, essential, said: word, mapped }) => ({ actor, verb, object, axis, essential, said: word, ...(mapped ? { mapped } : {}) })),
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

const threatOf = (word: string | null): ThreatId => THREAT_NOUNS.find(([, pattern]) => word !== null && pattern.test(word))?.[0] ?? (/^(?:shark|snake|snowball|catapult)$/.test(word ?? '') ? 'hazard' : 'obstacle');

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
  // Direct escape arguments name places too; preserve their noun rather than
  // the rendering category (island -> beach, laboratory -> factory).
  const escaped = /\bescap(?:e|es|ed|ing)\s+((?:a|an|the)\s+[a-z][a-z -]*)/.exec(text);
  const escapedPlace = escaped === null ? null : phraseIn(escaped[1]);
  if (escapedPlace !== null && (isPlace(headOf(escapedPlace)) || inSetting(escapedPlace))) return headOf(escapedPlace);
  const traversed = /\b(?:roam(?:s|ing)?|explor(?:e|es|ing))\s+((?:a|an|the)\s+[a-z][a-z -]*)/.exec(text);
  const traversedPlace = traversed === null ? null : phraseIn(traversed[1]);
  if (traversedPlace !== null) return headOf(traversedPlace);
  // Explicit locative noun phrases preserve named places rather than reducing
  // them to a visual category. Bare nouns still use the established lexicon.
  for (const match of text.matchAll(/\b(?:in|inside|outside|through|across|along|around|above|below|on|over|down|up|at)\s+((?:a|an|the)\s+[a-z][a-z -]*)/g)) {
    const phrase = phraseIn(match[1]);
    if (!phrase) continue;
    const words = phrase.split(' ');
    const location = words.find(word => isPlace(headOf(word)) && !/^(?:snowy|frozen|icy|arctic|polar|tropical|medieval|neon|sunken)$/.test(word));
    if (location && !/^(?:finish|end|exit|gate|top|ground|floor|place|level|world|map|area)$/.test(location)) return headOf(location);
    // Articles make an unknown bounded noun phrase a location candidate;
    // goals, weapons and amounts are not inferred as scenery.
    const head = headOf(phrase);
    if (!location && !NOT_A_THING.has(head) && !NOT_AN_ACTOR.has(head) && !toolsOf(text).includes(head)
      && !/\b(?:right|perfect|exact|same)\b/.test(phrase) && !/ing$/.test(head)
      && !/^(?:horse|car|boat|bike|plane|bus|truck|coin|gem|key|ball|enemy|robot|dragon)$/.test(head)) return head;
  }
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
