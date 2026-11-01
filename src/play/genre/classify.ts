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

import { type CastRole, GENRES, GENRE_MODES, type GenreId, type GenreMode, type GenreModule, type ModeAvailability } from './contract';
import { FAMILIES, type VerbFamily } from './families';
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
  /**
   * Co hlavní sloveso dělá se svým předmětem (P39, `after`): střelba ho sestřelí, hod na něj míří,
   * rvačka se s ním bije, úkol k němu jde, sběr ho sebere. `null` = předmět slovesa není věc obsazení
   * (cesta pohybu, místo útěku, kus načasování) nebo věta hlavní sloveso nemá.
   */
  readonly does: CastRole | null;
  /** První režim rozhodlo čtení (P58B T5; u nejistého čtení slovník) – skladatel ho zkusí první (T5a). Bez čtení `false`. */
  readonly decided: boolean;
}

export type GenreModules = { readonly [G in GenreId]: GenreModule<G> };

type Pair = { readonly genre: GenreId; readonly mode: GenreMode };
/**
 * Znak žánru > úkol > pohyb > sběr > útěk – pořadí, ve kterém sloveso nese cíl věty. Znak žánru (`sign`, P66 T12) je
 * sloveso jen s druhou půlkou, která celou hru jmenuje („survives waves of“, „a hole … swallows“, „steals … carries it
 * home“): když ji věta řekne, jmenuje hru přesněji než samotné sloveso úkolu („a hamster with a pea shooter holds out
 * against hordes of cats“ – střílí se, ale hraje se přežití ve vlnách).
 */
type Kind = 'sign' | 'goal' | 'move' | 'pickup' | 'chase';

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
// P54C T13: žánry pruhů, které hrají živě (chytání, bouchání, obrana, krájení).
const CATCH = pair('catch', 'default');
const WHACK = pair('whack', 'default');
const DEFENSE = pair('defense', 'default');
const SLICE = pair('slice', 'default');
// P54C T13b: žánry fáze 3 (přeskákání silnice, dav a brány, slučování, vytlačování z ringu).
const HOP = pair('hop', 'default');
const CROWD = pair('crowd', 'default');
const MERGE = pair('merge', 'default');
const PUSH = pair('push', 'default');
// P66 T12: přežití ve vlnách, díra, krádež, třídění a šipky.
const SURVIVOR = pair('survivor', 'default');
const HOLE = pair('hole', 'default');
const STEAL = pair('steal', 'default');
const SORT = pair('sort', 'default');
const ARROWS = pair('arrows', 'default');
// P68 T11: směna se stavbou obchodu.
const BUILDSHIFT = pair('buildshift', 'default');
// P68 T8: závod s triky (skoky z ramp, bourání do hromad).
const STUNT = pair('stunt', 'default');
// P68 T9: jedna jamka minigolfu.
const MINIGOLF = pair('minigolf', 'default');

interface Verb {
  /** Základní tvar – ten se vrací jako `verb` a čte ho kontrola věrnosti. */
  readonly verb: string;
  readonly kind: Kind;
  /** Sběr (`pickup`) žánr nemá, dostane ho podle zbytku věty. */
  readonly pick: Pair | null;
  readonly pattern: RegExp;
  /** Co sloveso dělá se svým předmětem (P39); `null` = předmět není věc obsazení. */
  readonly does: CastRole | null;
}

const OBJECT = String.raw`(?:the|a|an|all|every|each|some|\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)\b`;
const PRONOUN = String.raw`(?:it|you|me|him|her|them|us|the player)\b`;

// P54C T13: znaky žánrů pruhů. Vzor slovesa shodí jen sloveso a znak čte pohledem dopředu – `after` tak začíná
// za slovesem jako u ostatních řádků („catches|falling honey jars“), návrh z něj čte předmět.
/** Co se chytá: padá, prší, nebo míří do nádoby. */
const CAUGHT = String.raw`(?:falling|dropping|raining|tumbling|plummeting|(?:falls?|drops?) (?:from|out of|down)|from (?:the )?(?:sky|skies|above|ceiling|clouds?|trees?)|in (?:a|an|the|his|her|their|your|its|my) (?:[a-z]+ )?(?:baskets?|buckets?|cups?|nets?|bowls?|jars?|hats?|sacks?|pans?|box|boxes|mouths?|carts?|trays?|bags?|barrels?|pots?|aprons?))\b`;
/** Slovo téže klauze: spojka nebo uhýbání začíná jinou („catches mice and dodges falling branches“ – padá nástraha). Číslovka je slovo („catches 5 falling bananas“). */
const SAME_CLAUSE = String.raw`(?!(?:and|but|or|while|then|avoid\w*|dodg\w*)\b)[a-z0-9']+ `;
const STRIKE = String.raw`(?:hit(?:s|ting)?|smash(?:es|ing)?|squash(?:es|ing)?|tap(?:s|ping)?|pop(?:s|ping)?|zap(?:s|ping)?|swat(?:s|ting)?|bash(?:es|ing)?|smack(?:s|ing)?|thump(?:s|ing)?)`;
/** Co vykukuje: „popping out of graves“, „appear in the windows“, „rising from the tents“. */
const POPS_UP = String.raw`(?:pop(?:s|ping)?|peek(?:s|ing)?|peep(?:s|ing)?|appear(?:s|ing)?|emerg(?:e|es|ing)|ris(?:e|es|ing)|stick(?:s|ing)?) (?:out|up|from|in|of)\b`;
/** Před kým se brání: množné číslo nebo vlna („goblins“, „waves of orcs“, „a pack of wolves“), ne jeden („a hungry cat“, „the boss“). */
const MANY = String.raw`(?:(?:the|all|those|these|every|endless|wave after wave of) )?(?:(?:a |an )?(?:waves?|hordes?|swarms?|armies|army|packs?|gangs?|bands?|flocks?|herds?|groups?|lines?|streams?) of )?(?!(?:its|his|this|us|is|was)\b)(?:[a-z'-]+ ){0,2}?[a-z'-]*[a-rt-z]s\b`;
/** Co letí. */
const FLIGHT = String.raw`(?:flying|tossed|thrown|launched|bouncing|flung|hurled|in the air|into the air|mid-?air|as they (?:fly|soar)|(?:jump|jumps|jumping|leap|leaps|leaping) (?:out|up))\b`;
const NOT_THROUGH = String.raw`(?!(?:through|into|across|down|off|of)\b)`;
// P55 T3: rodiny opisů pruhových žánrů z chyb P54C holdoutu – vždy věc + pohyb, nikdy jedno slovo.
/** Věc sama padá („candy falls from the ceiling“, „toppings drop from above“). */
const FALLS = String.raw`(?:fall(?:s|ing)?|drop(?:s|ping)?|rain(?:s|ing)?|tumbl(?:e|es|ing)) (?:from|out of|down)\b`;
/** Nádoba, kterou hráč posouvá pod padající věci („move a bucket left and right“, „slide my bowl under it“). */
const VESSEL = String.raw`(?:baskets?|buckets?|bowls?|nets?|cups?|carts?|trays?|pans?|sacks?|hats?|plates?|aprons?)`;
/** Úder na to, co vykouklo: zájmeno za úderem („tap them before they vanish“, „smash them quick“). */
const STRIKE_THEM = String.raw`(?:${STRIKE}|whack(?:s|ing)?|bonk(?:s|ing)?|hammer(?:s|ing)?|punch(?:es|ing)?|slap(?:s|ping)?) (?:them|it|'em|each one)\b`;
/** Množné číslo těsně před slovesem – vlna se valí („orcs march“, „skeletons keep coming“), jeden hrdina ne. */
const PLURAL_BEFORE = String.raw`(?<=\b[a-z'-]*[a-rt-z]s )`;
/** Co obrana chrání, kam vlna míří. */
const STRONGHOLD = String.raw`(?:castles?|base|bases|towers?|gates?|walls?|village|town|city|fort|fortress|farm|farmhouse|garden|igloo|camp|house|home|kingdom|lanes?)\b`;
/** Co letí, z druhé strany věty: věc vyhozená před řezem („pumpkins get thrown up and you slice them“). */
const FLUNG = String.raw`(?:thrown|tossed|flung|launched|hurled|(?:jump|jumps|jumping|leap|leaps|leaping|fly|flies|flying|shoot|shoots|shooting|pop|pops|popping) (?:out|up)|in the air|into the air|mid-?air)\b`;
// P54C T13b: znaky žánrů fáze 3, čtené stejně – pohledem dopředu za slovesem (nebo za jménem hry).
/** Přes co se přeskáká: silnice, provoz, koleje („crosses a busy road“, „hops across train tracks“). */
const TRAFFIC = String.raw`(?:roads?|streets?|highways?|freeways?|motorways?|traffic|crossings?|intersections?|(?:train |railway |rail )?tracks|rails|railways?|(?:country|traffic|busy|highway) lanes|lanes of (?:[a-z]+ )?(?:cars|traffic|trucks|vehicles|buses))\b`;
/** Řeka po kládách („cross the river by jumping on floating logs“); „jumps over logs“ je překážka plošinovky. */
const LOGS = String.raw`(?:floating|drifting|river) logs?\b`;
/** Kdo v davu roste: dav, armáda, roj. */
const GROUP = String.raw`(?:crowds?|army|armies|mobs?|hordes?|swarms?|soldiers|troops|followers|stick ?men|minions|squads?|clones)`;
const GROWS = String.raw`(?:grow(?:s|ing)?|multipl(?:y|ies|ying)|doubl(?:e|es|ing))`;
/** Co se slučuje: stejné kusy („matching“, „the same“, „equal“) nebo větší z menších („into a bigger cat“). */
const ALIKE = String.raw`(?:matching|same|identical|equal|alike|twin|(?:into|to make|to form) (?:a |an |the )?(?:bigger|larger|giant|huge)|bigger|larger)\b`;
/** Kam se pouští: nádoba, ve které se slučuje. */
const CONTAINER = String.raw`(?:jars?|box|boxes|baskets?|bowls?|cups?|containers?|buckets?|bottles?|tubes?|glass|tanks?|pots?|crates?)\b`;
/** Odkud se soupeř vystrčí: ring, plošina, ostrov, ker, okraj. */
const RING = String.raw`(?:rings?|arenas?|platforms?|islands?|rafts?|floes?|icebergs?|edges?|stages?|tables?|mats?|dohyo|ledges?|cliffs?|docks?|piers?|circles?)\b`;
// P66 T12: znaky pěti nových žánrů. Každý je sloveso i s druhou půlkou, která hru jmenuje – samotné „survive“,
// „eats“, „steals“, „tap“ dál hrají starý žánr.
/** Proti čemu se přežívá: vlny, hordy, roje („survives endless waves of skeletons“, „the zombie horde“). */
const HORDE = String.raw`(?:waves?|hordes?|swarms?|armies|army|onslaught|wave after wave)\b`;
/** Díra jako podmět („a black hole“, „a hungry hole in the farmyard“), ne místo za předložkou („out of its hole“). */
const HOLE_SUBJECT = String.raw`(?<!\b(?:of|in|into|from|through|down|inside|under|over|to|at|on|near|beside|by|with) )\b(?:a|an|the|one|this|that|my|your|our) (?:[a-z-]+ ){0,2}?(?:hole|sinkhole|pit|vortex|whirlpool)\b`;
/** Kořist nesená domů („carry it home“, „hauls them back“, „brings them to her alley“). */
const CARRY_HOME = String.raw`(?:carr(?:y|ies|ying)|bring(?:s|ing)?|brought|haul(?:s|ing)?|run(?:s|ning)?|ran|drag(?:s|ging)?|sneak(?:s|ing)?|rush(?:es|ing)?|fl(?:y|ies|ying)) (?:it |them |(?:the |their |his |her |its )?(?:[a-z'-]+ ){0,2}?[a-z'-]+ )?(?:all )?(?:back|home|to (?:his|her|their|its|my|your|our) (?:own )?[a-z-]+)\b`;
/** Kam se třídí: nádoba, která věci sedí („on the right shelves“, „into the matching bags“). */
const RIGHT_BIN = String.raw`(?:back )?(?:into|in|on|onto|to) (?:the |their |its |his |her |a )?(?:right|matching|correct|proper) (?:[a-z-]+ )?(?:shel(?:f|ves)|bins?|box(?:es)?|jars?|bags?|baskets?|buckets?|bottles?|tubes?|piles?|drawers?|crates?|racks?|trays?|cups?|slots?|spots?|places?|containers?|bowls?|chests?|carts?|trucks?|pens?|sacks?|tins?|lockers?|cages?)\b`;
/** Kus, který po ťuknutí odjede („so it drives out“, „and it leaves“, „so they fly off“). */
const LEAVES = String.raw`(?:so|and|to make|to let|then) (?:it|they|that one|each one) (?:only )?(?:drives? (?:out|off|away)|leaves?|fl(?:y|ies) (?:off|away|out)|slides? (?:out|off|away)|zooms? (?:off|out|away)|exits?|escapes?|gets? out|moves? out|rolls? (?:out|away)|pulls? out|sails? (?:out|off|away)|swims? (?:out|off|away))\b`;
/** Obchod, do kterého chodí zákazníci (P68 T11) – ne město, farma ani dílna bez pultu. */
const SHOP = String.raw`(?:shops?|stores?|caf[eé]s?|diners?|bakery|bakeries|restaurants?|stands?|stalls?|trucks?|bars?|parlou?rs?|canteens?|joints?|kiosks?|tea ?rooms?)`;
/** Vozidlo závodu s triky (P68 T8) – auto, náklaďák, motorka, traktor, sněžný skútr. */
const VEHICLE = String.raw`(?:cars?|trucks?|vans?|bus(?:es)?|buggy|buggies|scooters?|motorbikes?|motorcycles?|dirt ?bikes?|tractors?|go-?karts?|karts?|taxis?|ambulances?|jeeps?|quads?|snowmobiles?|bulldozers?|lorr(?:y|ies)|pickups?)`;
/** Determinant před obchodem: „a“, „my“, „your own“. */
const OWNER = String.raw`(?:a|an|my|your|the|his|her|their|our)(?: own)?`;

/**
 * Co sloveso dělá se svým předmětem (P39): režim slovesa to říká – střelba sestřelí, hod míří, rvačka a
 * duel se bijí, úkol jde k předmětu, sběr („collect“) ho sebere. Obrana chrání („defend the castle“),
 * spor v Souboji jmenuje téma („negotiate a raise“), hledání místo („explore the ruins“) – ti předmět nemají,
 * stejně jako pohyb, útěk, načasování a rytmus.
 */
function objectDoes(verb: string, kind: Kind, pick: Pair | null): CastRole | null {
  if (kind === 'pickup') return verb === 'collect' ? 'collect' : null;
  // P54C T13: chytá se a krájí, co padá a letí (ovoce); bouchá se do cíle v díře. Obrana chrání jako `defend` Arény.
  if (pick === CATCH || pick === SLICE) return 'collect';
  if (pick === WHACK) return 'shoot_at';
  if (pick === SHOOTER) return 'shoot_at';
  if (pick === THROW) return 'throw_at';
  if (pick === FIGHT) return verb === 'defend' ? null : 'fight';
  if (pick === DUEL) return verb === 'duel' ? 'fight' : null;
  return pick === SPATIAL || pick === STATION ? 'reach' : null;
}

/** Předmět slovesa rodiny (P37A T3): co se uklízí, se sbírá, cíl úkolu je cíl; rodina bez předmětu (stříkání, rytmus) nemá nic. */
const FAMILY_DOES: Readonly<Record<VerbFamily['object'], CastRole | null>> = { collectible: 'collect', target: 'reach', none: null };

const v = (verb: string, kind: Kind, pick: Pair | null, pattern: RegExp, does = objectDoes(verb, kind, pick)): Verb => ({ verb, kind, pick, pattern, does });

const VERBS: readonly Verb[] = [
  // P66 T12: znaky nových žánrů (`sign` jde před úkol). Přežívá se proti vlnám a hordám („survives endless waves of
  // skeletons“, „holds out against hordes of cats“), hrdina střílí sám („auto-fires at swarms“) nebo si mezi vlnami
  // vybírá sílu; „survive the storm“ zůstává útěkem a „defend the castle from waves of goblins“ obranou.
  v('survive', 'sign', SURVIVOR, new RegExp([
    String.raw`\b(?:surviv(?:e|es|ing)|outlast(?:s|ing)?|(?:hold|holds|holding) out|(?:fend|fends|fending) off|last(?:s|ing)? (?:against|through))(?= (?:against |through |off |the |an? |all |every |endless |wave after wave of )*(?:[a-z'-]+ ){0,2}?${HORDE})`,
    String.raw`\bauto[- ]?(?:fir(?:e|es|ed|ing)|shoot(?:s|ing|er)?|aim(?:s|ing)?)\b`,
    String.raw`\b(?:shoot|shoots|shooting|fire|fires|firing)(?= (?:[a-z]+ ){0,2}?(?:on (?:its|his|her|their|my|your) own|by (?:it|him|her|them|my|your)sel(?:f|ves)|automatically)\b)`,
    String.raw`\b(?:pick(?:s|ing)?|choos(?:e|es|ing)|unlock(?:s|ing)?|earn(?:s|ing)?)(?= (?:a |an |one |new |the )*(?:[a-z]+ )?(?:powers?|upgrades?|perks?|skills?|power-?ups?|abilit(?:y|ies)) (?:after|between) (?:each |every |the )?waves?\b)`,
  ].join('|'))),
  // Díra, která polyká („a black hole swallows the cars“, „a sinkhole … gulps down umbrellas“); „eats“ bez díry je sběr.
  v('swallow', 'sign', HOLE, new RegExp(String.raw`${HOLE_SUBJECT}[^.;!?]*?\b(?:swallow(?:s|ed|ing)?|gulp(?:s|ed|ing)?|devour(?:s|ed|ing)?|gobbl(?:e|es|ed|ing)|eat(?:s|ing)?|ate|suck(?:s|ed|ing)? (?:up|in|down)|consum(?:e|es|ed|ing))\b`)),
  // Krádež je kořist nesená domů („steal the golden egg … and carry it home“, „grabs their picnic basket and runs it
  // back“). Krádež bez cesty domů zůstává, kde byla: „steals fish while dodging the fishmonger“ sběrem s útěkem,
  // „sneaks past guards to steal a fish“ plížením v bludišti se strážemi (P46A).
  v('steal', 'sign', STEAL, new RegExp(String.raw`(?:\b(?:steal(?:s|ing)?|stole|snatch(?:es|ing)?|swip(?:e|es|ing)|nab(?:s|bing)?|raid(?:s|ing)?|loot(?:s|ing)?|rob(?:s|bing)?)\b|\bgrab(?:s|bing)?(?= (?:their|the [a-z-]+'s|the (?:enemy|rival|other))\b))(?=[^.;!?]*\b${CARRY_HOME})`)),
  // Třídění: sloveso třídění („sort the candies“; ne „a sort of“ ani místnost „a sorting room“), věci do správné nádoby
  // („puts … back on the right shelves“, „drops letters into the matching bags“), přelévání do jedné barvy, podle barvy.
  v('sort', 'sign', SORT, new RegExp([
    String.raw`\bsort(?:s|ed|ing)?\b(?! (?:of|rooms?|office|cent(?:er|re)|hat|facility|station|machine)\b)`,
    String.raw`\b(?:put(?:s|ting)?|drop(?:s|ping)?|plac(?:e|es|ing)|send(?:s|ing)?|mov(?:e|es|ing)|toss(?:es|ing)?|slot(?:s|ting)?|fil(?:e|es|ing)|shelv(?:e|es|ing)|load(?:s|ing)?|pack(?:s|ing)?)(?= (?:[a-z0-9,'-]+ ){0,8}?${RIGHT_BIN})`,
    String.raw`\bpour(?:s|ing)?(?=[^.;!?]*\b(?:one|a single) colou?r\b)`,
    String.raw`\b(?:group(?:s|ing)?|arrang(?:e|es|ing)|separat(?:e|es|ing)|organi[sz](?:e|es|ing))(?= (?:[a-z0-9,'-]+ ){0,6}?by (?:colou?r|kind|type|shape|size)s?\b)`,
  ].join('|'))),
  // Šipky: ťuk, po kterém kus odjede („tap a bus and it leaves“), kus jede, kam ukazuje („the way it points“), zácpa
  // k rozmotání („untangle the traffic jam“, „clear the jammed parking lot“).
  v('tap', 'sign', ARROWS, new RegExp([
    String.raw`\btap(?:s|ping|ped)?(?= (?:on )?(?:each|every|a|an|the|them|one|it)\b[^.;!?]*?\b${LEAVES})`,
    String.raw`\b(?:the )?(?:way|direction) (?:it |they |its (?:[a-z]+ )?|their (?:[a-z]+ )?|the arrows? |each (?:[a-z]+ )?)(?:points?|faces?|is pointing|are pointing|is facing)\b`,
    String.raw`\b(?:clear(?:s|ing)?|untangl(?:e|es|ing)|unjam(?:s|ming)?|empt(?:y|ies|ying)|unblock(?:s|ing)?|fre(?:e|es|eing)|solv(?:e|es|ing))(?= (?:the |a |an |this |that )?(?:[a-z'-]+ ){0,2}?(?:jam|jammed|gridlock(?:ed)?|clogged)\b)`,
    String.raw`\bunpark(?:s|ing|ed)?\b|\btap[- ]away\b`,
  ].join('|'))),
  // P68 T11: směna v obchodě, který si hráč postaví. Jedna z půlek stačí: konec pracovní směny („before the shift
  // ends“; samotná „a night shift at the hospital“ obchod není), stavění stanovišť („place grills and counters“), vlastní obchod („runs a donut shop“, „build
  // your own ice cream parlour“), obsluha zákazníků, zákazníci, kteří do obchodu chodí („line up for pizza at my
  // diner“). Jedno pracoviště, objednávka za objednávkou („a chef cooks burgers at one grill“) zůstává stanovištěm.
  // P68 T8: závod s triky. Rampa, kaskadér, nebo vozidlo, které skáče, bourá či prorazí hromadu věcí
  // („a police car smashes through a wall of barrels“). Samotná jízda nebo závod bez skoku a bourání zůstává plavbou,
  // skok bez vozidla plošinovkou („a frog jumps over logs“), nakreslená rampa kreslení (`drawsave`).
  v('stunt', 'sign', STUNT, new RegExp([
    // „monster truck“ sám znak není: „a monster truck racing other trucks and firing missiles“ (P42) je bojový závod
    // arény; slovo zůstává narážkou modulu (+1, `stunt.ts`) a skok či náraz trucku znak slyší větou vozidla níž.
    String.raw`\bstunts?\b|\bdaredevils?\b|\bdemolition\b`,
    // „grind ramps“ je skatepark (P55 h79), ne skok vozidla.
    String.raw`(?<!\b(?:draw(?:s|ing)?|grind(?:s|ing)?) (?:a |an |the )?(?:[a-z-]+ )?)\bramps?\b`,
    String.raw`\b${VEHICLE}\b[^.;!?]*?\b(?:jump(?:s|ing)?|smash(?:es|ing)?|crash(?:es|ing)?|plows?|plowing|ploughs?|fl(?:y|ies|ying) off|launch(?:es|ing)? off|knock(?:s|ing)? (?:down|over))\b`,
  ].join('|'))),
  // P68 T9: minigolf – mini golf, crazy golf, rána „putt“, hole in one, golfový míček. Samotné „golf course“ znak není:
  // „bonk the moles popping out of the golf course“ je bouchání (P66 p66-27), „a golfer drives a cart … collecting
  // lost balls“ sbírání; „putting“ jen u míčku nebo greenu – „putting out fires“ je hašení. Golfový míček jen v pohybu
  // dráhou („golf ball through a graveyard“) – „scooping up scattered golf balls“ je sbírání (stráž T9).
  v('putt', 'sign', MINIGOLF, new RegExp([
    String.raw`\bmini[- ]?golf\b|\bcrazy golf\b|\bputt-putt\b|\bputt(?:s|ed)?\b|\bholes? in one\b`,
    String.raw`\bgolf ball (?:rolls? )?(?:through|past|into|around|across|between|over|under)\b`,
    String.raw`\bputting (?:the |a |an )?(?:[a-z]+ )?(?:golf )?balls?\b|\bputting greens?\b`,
  ].join('|'))),
  v('serve', 'sign', BUILDSHIFT, new RegExp([
    String.raw`\b(?:before|until|till|by) (?:the |your |their |his |her |its )?(?:[a-z]+ )?shift (?:ends|is over|closes)\b|\b(?:one|a single) shift\b`,
    String.raw`\b(?:build(?:s|ing)?|plac(?:e|es|ing)|lay(?:s|ing)? out|set(?:s|ting)? up|buy(?:s|ing)?|put(?:s|ting)? down)(?= (?:[a-z'-]+ ){0,3}?(?:ovens?|counters?|tills?|grills?|stations?|freezers?|workbenches?|benches|lifts?)\b)`,
    String.raw`\b(?:run(?:s|ning)?|open(?:s|ing)?|own(?:s|ing)?|lay(?:s|ing)? out|set(?:s|ting)? up|build(?:s|ing)?) ${OWNER} (?:[a-z'-]+ ){0,3}?${SHOP}\b`,
    String.raw`\bshop (?:management|manager|sim(?:ulator)?|tycoon)\b`,
    String.raw`\bserv(?:e|es|ing)\b(?= (?:[a-z'-]+ ){0,4}?customers?\b)`,
    String.raw`\b(?:lines? up|lining up|queu(?:e|es|ing)(?: up)?|com(?:e|es|ing)|drops? by|crowds?|orders?|wants?) (?:[a-z'-]+ ){0,4}?(?:(?:at|to|into|in) )?${OWNER} (?:[a-z'-]+ ){0,3}?${SHOP}\b`,
    // „my taco truck has to feed 20 astronauts“, „serve tea … in a cozy tea room“, „a coffee shop where workers want …“.
    String.raw`\b${OWNER} (?:[a-z'-]+ ){0,3}?${SHOP} (?:has to|have to|must|needs? to) (?:feed|serve|sell)\b`,
    String.raw`\b(?:serv(?:e|es|ing)|sell(?:s|ing)?)\b[^.;!?]*?\b(?:in|at) ${OWNER} (?:[a-z'-]+ ){0,3}?${SHOP}\b`,
    String.raw`\b${SHOP} where (?:[a-z0-9'-]+ ){0,4}?(?:wants?|com(?:e|es)|lines? up|queu(?:e|es)|orders?)\b`,
  ].join('|'))),
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
  // P54C T13: žánry pruhů. Sloveso je jejich jen se znakem žánru, jinak hraje dál starý žánr – stojí před `hit`, `defend`
  // a rodinou sekání, takže na stejném místě věty vyhrají. Chytá se, co padá („catches falling apples“, „catch raindrops
  // in a cup“), ne kdo utíká („catch the thief“ je honička); bouchá se do toho, co vykukuje („hit the zombies popping out
  // of graves“), ne do čehokoli („pop ten balloons“ zůstává úkolem); brání se místo před někým („defend the castle from
  // goblins“, „tower defense“), ne sám sebe („defends himself in a duel“); krájí se, co letí („slice flying watermelons“),
  // ne cesta džunglí („slice through the jungle“) ani dříví („chop wood“).
  // P55 T3: sebrat, chytit i sníst to, co padá („collect falling stars in a basket“, „grabs presents dropping from the
  // sleigh“); věc, která padá, a hráč ji chytá nebo pod ni strká nádobu („toppings drop from above, catch them“); nádoba
  // posouvaná pod věci („move a bucket left and right to catch raindrops“).
  v('catch', 'goal', CATCH, new RegExp([
    String.raw`\b(?:catch(?:es|ing)?|collect(?:s|ing)?|grab(?:s|bing)?|gather(?:s|ing)?|snag(?:s|ging)?|scoop(?:s|ing)?|eat(?:s|ing)?)(?= (?!(?:him|her|me|us|you|the player)\b)(?:${SAME_CLAUSE}){0,4}?${CAUGHT})`,
    String.raw`\b${FALLS}(?= (?:[a-z'-]+ ){0,3}?[a-z'-]+\b[^.]*?\b(?:catch(?:es|ing)?|(?:slide|move|hold|put)s? (?:my|your|the|a|his|her) (?:[a-z]+ )?${VESSEL} under)\b)`,
    String.raw`\b(?:mov(?:e|es|ing)|slid(?:e|es|ing)|swing(?:s|ing)?|hold(?:s|ing)?|carr(?:y|ies|ying)) (?:a|an|the|your|my|his|her|their) (?:[a-z]+ )?${VESSEL}(?= [^.]*?\b(?:to catch|under (?:it|them|the)|left and right)\b)`,
  ].join('|'))),
  // P55 T3: co vykoukne a hráč do toho udeří zájmenem („ghosts appear in windows, tap them before they vanish“,
  // „gophers pop up in the garden and you smash them“).
  v('whack', 'goal', WHACK, new RegExp([
    String.raw`\bwhack(?:s|ing|ed)?\b|\bwhac?k-?a-?mole\b|\b(?:bonk|bop)(?:s|ping|ped|ed|ing)?\b|\b${STRIKE}(?= (?:[a-z']+ ){1,5}?${POPS_UP}| (?:[a-z']+ ){0,2}?(?:moles?|gophers?)\b)`,
    String.raw`\b${POPS_UP}(?=[^.]*?\b${STRIKE_THEM})`,
  ].join('|'))),
  // Obrana pruhů chce vlny: brání se před mnoha („from goblins“, „against waves of orcs“); kdo se brání jednomu
  // („a mouse defends its cheese from a hungry cat“), hraje dál rvačku Arény se štítem.
  v('defend', 'goal', DEFENSE, new RegExp([
    String.raw`\b(?:defend(?:s|ing)?|protect(?:s|ing)?|guard(?:s|ing)?)(?= (?:the|a|an|his|her|its|their|our|my|your|this)\b(?: [a-z']+){0,3}? (?:from|against) ${MANY})`,
    String.raw`\btower defen[cs]e\b(?! (?:platformer|runner|shooter|racer)\b)`,
    String.raw`\bhold(?:s|ing)?(?= (?:the |a |your |our )?(?:[a-z]+ )?(?:lanes?|line|gates?|walls?|fort|fortress|bridge|pass)\b.*\b(?:against|from)\b)`,
    String.raw`\bkeep(?:s|ing)?(?= (?:the |a |an |all |those )?(?:[a-z]+ ){0,2}?[a-z]+ (?:from|out of) (?:breach(?:ing)?|break(?:ing)? (?:in|into|through)|storm(?:ing)?|invad(?:e|ing)|enter(?:ing)?|overrun(?:ning)?|reach(?:ing)?|get(?:ting)? (?:in|into|inside|through|past))\b)`,
    String.raw`\bstop(?:s|ping)?(?= (?:the |a |an |all |those )?(?:[a-z]+ ){0,2}?[a-z]+ (?:before|from) (?:they|it|he|she|them) (?:break|breaks|breaking|get|gets|getting|storm|storms|sneak|sneaks|march|marches|crawl|crawls|invade|invades) (?:in|into|inside|through|over|past)\b)`,
    // P55 T3: zastavit mnohé, než dojdou k místu („stop the zombies before they reach the farmhouse“); vlna se valí
    // k pevnosti („orcs march down three lanes toward my castle“, „skeletons keep coming down the road to my tower“,
    // „goblins rush my village gate“); chránit místo něčím, co se staví nebo hází („guard their igloo by throwing
    // snowballs at walruses“).
    String.raw`\bstop(?:s|ping)?(?= (?:the |all |those )?(?:[a-z'-]+ ){0,2}?[a-z'-]*[a-rt-z]s (?:before|from) (?:they|them) (?:reach|reaching|get to|getting to|hit|hitting|touch|touching|cross|crossing|make it to) (?:the|your|my|our|their)\b)`,
    String.raw`${PLURAL_BEFORE}\b(?:march(?:es|ing)?|advanc(?:e|es|ing)|rush(?:es|ing)?|charg(?:e|es|ing)|swarm(?:s|ing)?|stomp(?:s|ing)?|crawl(?:s|ing)?|creep(?:s|ing)?|(?:keep|kept|keeps) coming|pour(?:s|ing)?|storm(?:s|ing)?)(?= (?:[a-z'-]+ ){0,4}?(?:(?:toward|towards|to|at|on|down|along|up|into) )?(?:the |my |our |your |their |a )(?:[a-z'-]+ ){0,2}?${STRONGHOLD})`,
    String.raw`\b(?:defend(?:s|ing)?|protect(?:s|ing)?|guard(?:s|ing)?)(?= (?:the|a|an|his|her|its|their|our|my|your|this)\b(?: [a-z']+){0,3}? by (?:throwing|shooting|placing|building|dropping|firing|launching|putting|setting up|tossing|hurling)\b)`,
  ].join('|'))),
  // Krájí a seká se ovoce („slices fruit“); řezat a sekat jde i v kuchyni a v rytmu („swords cutting fruit to music“), proto jen to, co letí.
  v('slice', 'goal', SLICE, new RegExp([
    String.raw`(?<!\b(?:pizza|cake|bread|pie|cheese|apple|lemon|orange|lime|tomato) )\b(?:slic(?:e|es|ing)|slash(?:es|ing)?)(?= ${NOT_THROUGH}(?:[a-z']+ ){0,3}?(?:${FLIGHT}|(?:fruits?|watermelons?|melons?)\b))`,
    String.raw`\b(?:chop(?:s|ping)?|cut(?:s|ting)?)(?= ${NOT_THROUGH}(?:[a-z']+ ){0,3}?${FLIGHT})`,
    String.raw`\bswip(?:e|es|ing) to (?:cut|slice|slash|chop)\b`,
    // P55 T3: věc vyhozená nebo vyskočivší před řezem („pumpkins get thrown up and you slice them“) a tah prstem přes to,
    // co letí („swipe through gems tossed in the air“).
    String.raw`(?<=\b${FLUNG}[^.]*?)\b(?:slic(?:e|es|ing)|slash(?:es|ing)?|chop(?:s|ping)?|cut(?:s|ting)?|split(?:s|ting)?|swip(?:e|es|ing)) (?:them|it|'em|each one)\b`,
    String.raw`\bswip(?:e|es|ing)(?= (?:through|across|at|over) (?:[a-z']+ ){0,3}?${FLIGHT})`,
  ].join('|'))),
  // P54C T13b: žánry fáze 3, stejně jako žánry pruhů jen se znakem žánru a před `hit`, skokem, sběrem a `make`.
  // Přeskáká se přes silnici, provoz nebo koleje („a chicken crosses a busy road“, „hops across train tracks“) a přes
  // řeku po kládách; skok mezi lekníny nebo přes ploty zůstává plošinovkou a během.
  v('cross', 'goal', HOP, new RegExp([
    String.raw`\bcrossy road\b|\bfrogger\b`,
    String.raw`\bcross(?:es|ing)?(?= (?:over )?(?:the |a |an |all |many |\d+ )?(?:[a-z'-]+ ){0,2}?${TRAFFIC})`,
    String.raw`\b(?:hop|hops|hopping|jump|jumps|jumping|leap|leaps|leaping)(?= (?:[a-z'-]+ ){0,3}?(?:across|over|through) (?:[a-z'-]+ ){0,3}?${TRAFFIC})`,
    String.raw`\b(?:cross(?:es|ing)?|(?:hop|hops|hopping|jump|jumps|jumping|leap|leaps|leaping) (?:across|over))(?= (?:the |a |an )?(?:[a-z'-]+ ){0,2}?(?:river|stream|creek|pond|lake)\b[^.]*\b(?:logs?|turtles?)\b)`,
    String.raw`\b(?:hop|hops|hopping|jump|jumps|jumping|leap|leaps|leaping)(?= (?:on|onto|over|across|along) (?:the )?${LOGS})`,
  ].join('|'))),
  // Dav roste: skupina nebo růst a brány („grow your army through gates“, „pick the right gates to make your horde
  // bigger“), nebo sloveso růstu na skupině („multiply your crowd“). Dav bez bran a růstu („the crowd cheers“) ani
  // brány bez davu („speeds through checkpoint gates“) žánr nedají.
  v('grow', 'goal', CROWD, new RegExp([
    String.raw`\bcount masters\b|\bmob control\b|\bcrowd run(?:ner)?\b`,
    String.raw`\b(?:${GROUP}|${GROWS}|more)\b(?=[^.;]*\b(?:through|at|past|between) (?:[a-z'+-]+ ){0,4}?gates\b)`,
    String.raw`\b(?:pick(?:s|ing)?|choos(?:e|es|ing)) (?:the |a |an )?(?:right |best |correct |good )?gates\b(?=[^.;]*\b(?:${GROUP}|${GROWS}|bigger|larger)\b)`,
    String.raw`\b${GROWS}(?= (?:up )?(?:your|the|a|an|his|her|their|our|my) (?:[a-z'-]+ )?${GROUP}\b)`,
    String.raw`\b(?:growing|multiplying|ever-growing) ${GROUP}\b`,
    // P55 T4: brány, které dav násobí („pick the x2 gates“, „flying through doubling hoops“, „gates that add more zombies“).
    String.raw`\b(?:x\d+|×\d+|\+\d+|doubling|multiplying|multiplier|bonus) (?:gates|hoops|rings|portals)\b|\b(?:gates|hoops|portals) that (?:add|double|multiply|give you) (?:more|extra)\b`,
    String.raw`\bmak(?:e|es|ing)(?= (?:your|the|a|an|his|her|their|our|my) (?:[a-z'-]+ )?${GROUP} (?:bigger|larger|grow)\b)`,
  ].join('|'))),
  // Slučují se stejné kusy („merge matching candies“, „combine equal ones like 2048“), kusy v nádobě („merge the fruits
  // in a jar“, „drop gems into the bowl and fuse…“) nebo jako v suice; „merge into traffic“ je jízda a zůstává, kde byla.
  v('merge', 'goal', MERGE, new RegExp([
    String.raw`\bsuika\b|\bwatermelon game\b|\bmerge (?:game|puzzle)\b`,
    String.raw`\b(?:merg(?:e|es|ing)|combin(?:e|es|ing)|fus(?:e|es|ing))(?= (?:[a-z'-]+ ){0,3}?${ALIKE}| (?:[a-z'-]+ ){1,3}?(?:in|into|inside) (?:a|an|the|your|my) (?:[a-z'-]+ )?${CONTAINER}|\b[^.]*\b(?:suika|2048)\b)`,
    String.raw`\bdrop(?:s|ping)?(?= (?:[a-z0-9'-]+ ){1,4}?(?:into|in|onto|down) (?:a|an|the|your|my|his|her|their) (?:[a-z'-]+ )?${CONTAINER}[^.]*\b(?:merg|combin|fus)\w*)`,
  ].join('|'))),
  // Vytlačuje se soupeř z ringu, plošiny nebo kry („pushes rivals out of a ring“, „shove the penguins off the ice floe“);
  // „push crates onto switches“ je úkol, „knock out five scarecrows“ rvačka.
  v('push', 'goal', PUSH, new RegExp([
    String.raw`\bsumo (?:wrestling|match|bout|battle|game|fight)\b`,
    String.raw`\b(?:push(?:es|ing|ed)?|shov(?:e|es|ing|ed)|knock(?:s|ing|ed)?|bump(?:s|ing|ed)?|nudg(?:e|es|ing)|ram(?:s|ming)?|barg(?:e|es|ing))(?= (?:[a-z0-9'-]+ ){1,4}?(?:out of|off(?: of)?) (?:the |a |an |his |her |their |its )?(?:[a-z'-]+ ){0,3}?${RING})`,
  ].join('|'))),
  v('hit', 'goal', SPATIAL, /\b(?:pop(?:s|ping)?|hit(?:s|ting)?|smash(?:es|ing)?|zap(?:s|ping)?|destroy(?:s|ing)?)\b|\bknock(?:s|ing)? on\b/),
  // Rodiny sloves (P37A T3, T4): úklid, vaření, sekání, řemeslo, zahrada, opravy (dřív sloveso `repair` tady), malování, péče,
  // stříkání, pastevectví, vystoupení a papíry – `families.ts`.
  ...FAMILIES.flatMap((family) => family.members.map((member) => v(member.verb, 'goal', family.pick, member.pattern, FAMILY_DOES[family.object]))),
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
  v('defeat', 'goal', FIGHT, /\bdefeat(?:s|ing)?\b|\bslay(?:s|ing)?\b|\bknock(?:s|ing)? out\b|\bbeat(?:s|ing)? up\b|\battack(?:s|ing)?\b|(?<!candy )\bcrush(?:es|ing)?\b(?! on\b)|\bstomp(?:s|ing)?\b|\bsquash(?:es|ing|ed)\b/),
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

/** Buňky, které hraje znak žánru (P66 T12): když je hlavním slovesem věty, jmenuje celou hru (`chain/decide.ts`). */
export const SIGN_CELLS: ReadonlySet<string> = new Set(VERBS.filter((entry) => entry.kind === 'sign' && entry.pick !== null).map((entry) => `${entry.pick!.genre}.${entry.pick!.mode}`));

/**
 * Jména her a věci, které žánr prozradí bez slovesa („like mario kart“, „a
 * match 3 game“): +2, takže rozhodnou jen věty, kde hlavní sloveso chybí.
 * Hlavním slovesem se nestanou – kontrola věrnosti čte jen slovesa.
 */
const NAMES: readonly (readonly [Pair, RegExp])[] = [
  // „crossy road“ a „frogger“ jsou od P54C T13b přeskákání; přejít silnici slyší sloveso přeskákání, „cross the frozen
  // lake“ (bez kládek) dál napoví běh.
  [RUNNER, /\bsubway surfers?\b|\btemple run\b|\bskateboard(?:s|ing)?\b|\bcross(?:es|ing)? (?:the |an? )?(?:endless |busy |big )?(?:[a-z]+ )?(?:road|street|highway|lake)\b|\broll(?:s|ing)? (?:down|through)\b/],
  [HOP, /\bcrossy road\b|\bfrogger\b/],
  [CROWD, /\bcount masters\b|\bmob control\b|\bcrowd run(?:ner)?\b/],
  // „suika“ je od P54C T13b slučování, ne skládačka na místě.
  [MERGE, /\bsuika\b|\b2048\b|\bwatermelon game\b|\bmerge (?:game|puzzle)\b/],
  [PUSH, /\bsumo\b|\bbumper (?:cars?|boats?|balls?)\b/],
  [PLATFORMER, /\bmario\b(?! kart)|\bobby\b|\bparkour\b|\bfall guys\b|\bobstacle course\b|\bsonic\b/],
  [RACE, /\bkarts?\b|\bdrift(?:s|ing)?\b|\bmotorbikes?\b|\bbikes?\b|(?<!bumper )\bcars?\b|\bboats?\b|\bplanes?\b|\bspaceships?\b|\bsubmarines?\b|\btractors?\b|\bstunts?\b|\bramps?\b/],
  [FLAP, /\bflapp?y\b/],
  [RHYTHM, /\bpiano tiles\b|\bbeat saber\b|\bguitar hero\b|\bthe beat\b|\bdrummers?\b|\bdrums?\b|\bsongs?\b|\bmusic(?:al)?\b|\bdisco\b|\bconcert\b|\bkaraoke\b/],
  [DUEL, /\brivals?\b|\bhigh noon\b|\bshowdown\b|\bstand-?off\b|\bquick ?draw\b/],
  // „fruit ninja“ je krájení a „tower defense“ obrana pruhů (P54C T13), ne rvačka.
  [FIGHT, /\bswords?\b|(?<!fruit )\bninjas?\b|\bgladiators?\b|\bsamurai\b/],
  [DEFENSE, /\btower defen[cs]e\b|\bplants? vs\.? zombies\b|\bkingdom rush\b|\b(?:waves|hordes) of (?:[a-z]+ )?(?:enemies|zombies|goblins|orcs|monsters|aliens|robots|skeletons|invaders|attackers|soldiers|bugs|ants|knights|pirates|undead|creatures|slimes|demons|bandits|trolls|rats|spiders|vikings|barbarians)\b|\bcom(?:e|es|ing) in waves\b/],
  [SLICE, /\bfruit ninja\b/],
  [COLLECT, /\bsnake game\b|\bslither\b|\b[a-z]+[ .]io\b|\bagar\b|\bpac-?man\b/],
  [ESCAPE, /\bhorror\b|\bscary\b|\bcreepy\b|\bfive nights\b|\bfreddy'?s?\b|\bhide and seek\b|\bstealth\b|\bsneak(?:s|ing|y)?\b|\bfloor is lava\b/],
  [SHOOTER, /\bshooter\b|\bshooting (?:range|gallery|game)\b|\barchery\b|\bguns?\b|\bkrunker\b|\bsniper\b|\bfps\b/],
  [THROW, /\bgolf\b|\bbowling\b|\bbilliards\b|\bbasketball\b|\bslingshot\b|\bangry birds\b|\bcannon\b|\bcatapult\b|\bragdoll\b|\bknock(?:s|ing)? (?:down|over) (?:the |a |an )?(?:[a-z]+ )?towers?\b/],
  [SPATIAL, /\bsoccer\b|\bfootball\b|\btennis\b/],
  [STATION, /\bmatch[ -]?3\b|\bcandy crush\b|\btetris\b|\bmahjong\b|\bjenga\b|\bpuzzle\b|\bidle\b|\bclicker\b|\btycoon\b|\bovercooked\b|\bfarm game\b|\bsalon\b|\bmakeover\b|\bfashion\b|\bclinic\b|\bmatching game\b|\bword game\b|\bfishing\b|\bfactory\b|\bempire\b/],
];

const KIND_ORDER: readonly Kind[] = ['sign', 'goal', 'move', 'pickup', 'chase'];

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
 * Brána aktivace (P68 T1): žánry, které klasifikátor nevidí, i když je kategorie přepne na `ready` a napíše jim
 * narážky – obdoba `DIRECTOR_PENDING` režiséra. Hra je do té doby dostupná jen ručním specem (fixture). Žánr odsud
 * odebírá jen úloha „zapoj X“ v P68-I, spolu s `DIRECTOR_PENDING` a `READER_PENDING`. T11 `buildshift` zapojil a
 * vrátil: FPS brána na `pixel7-touch` (p95 snímku 49,9 ms) a herní brána (dev 7/8) neprošly – `integration-log.md`.
 * T8 `stunt` zapojil a vrátil: čas do hratelnosti proti `main` (+1,3 s desktop, +2,6 s pixel7, mez +0,2 s) neprošel.
 * T9 zapojil `minigolf`.
 */
export const ROUTE_PENDING: ReadonlySet<GenreId> = new Set<GenreId>(['stunt', 'railfps', 'buildshift', 'drawsave']);

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
  // Týž základní tvar mívá víc řádků („defend“ – rvačka v Aréně i obrana pruhů, P54C T13): hraje ho každý z nich.
  const plain = VERBS.filter((candidate) => candidate.kind !== 'sign');
  const named = plain.filter((candidate) => words.includes(candidate.verb));
  const entries = named.length > 0 ? named : plain.filter((candidate) => words.some((word) => candidate.pattern.test(word))).slice(0, 1);
  // P66 T12: znak nového žánru („steal“, „sort“) hraje navíc svůj žánr; řádek starého žánru, který slovo hrál, neschová.
  const signs = VERBS.filter((candidate) => candidate.kind === 'sign' && words.includes(candidate.verb));
  return [...signs, ...entries].some((entry) => (entry.pick === null ? collects : entry.pick.genre === genre && entry.pick.mode === mode));
}

/** Věta (a čtení modelem, když je) → všechny režimy seřazené od nejlepšího. */
export function classifyGenre(sentence: string, reading: Reading | null, modules: GenreModules = GENRE_MODULES): GenreRanking {
  const text = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
  const availability = (p: Pair): ModeAvailability => (modules[p.genre] as GenreModule).availability(p.mode as never);
  // Kostra žánru (P54C T4, `staged`) nehraje: v pořadí není vůbec, ani na konci – skladatel i návrh zkoušejí celé pořadí.
  // Žánr brány aktivace (`ROUTE_PENDING`, P68 T1) taky ne, i když ho jeho kategorie už přepnula na `ready`.
  const pairs = PAIRS.filter((p) => availability(p) !== 'staged' && !ROUTE_PENDING.has(p.genre));
  const scores = new Map<string, { score: number; why: string[] }>(pairs.map((p) => [key(p), { score: 0, why: [] }]));
  const add = (p: Pair, points: number, why: string): void => {
    const entry = scores.get(key(p));
    if (entry === undefined) return;
    entry.score += points;
    entry.why.push(why);
  };

  const heard = VERBS.flatMap((entry) => {
    // Znak žánru, který nehraje (kostra, dvojníci testů), věc nerozhoduje – sloveso starého žánru zůstává hlavní.
    if (entry.kind === 'sign' && entry.pick !== null && !scores.has(key(entry.pick))) return [];
    const match = entry.pattern.exec(text);
    return match === null ? [] : [{ ...entry, at: match.index, end: match.index + match[0].length }];
  });
  // P38: „a jumping game where you shoot animals“ – skok nebo běh nese žánr a střelba jede jako doplněk
  // (`ride`, v návrhu věc obsazení s `does: 'shoot_at'`); samotná střelba by skákání zahodila.
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
    // P66 T12: hlavní znak žánru je sloveso (+4) i jméno hry (+2 jako `NAMES`) – druhá půlka znaku hru jmenuje. Bez toho
    // ho dorovná starý žánr ze slov kolem („tap the boats so they sail out“: sloveso, „boats“ a narážka plavby = 4).
    const sign = isMain && entry.kind === 'sign';
    add(entry.pick ?? pickup(), isMain ? (sign ? 6 : 4) : 1, isMain ? `main ${sign ? 'sign' : 'verb'} "${entry.verb}"` : `verb "${entry.verb}"`);
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

  // Režim, který hraje náhradu, jde za všechny `ready`, které něco slyšely; věta bez narážky dá `ready` v pořadí `unheard`.
  // Rozhodnutý režim (`decided`, P56A T5) jde před všechny.
  const tier = (p: Pair, score: number, decided: string | null): number => (key(p) === decided ? -1 : score > 0 ? 0 : 2 + 2 * unheard(p)) + (availability(p) === 'ready' ? 0 : 1);
  const order = (decided: string | null): GenreChoice[] => pairs.map((p, index) => {
    const entry = scores.get(key(p)) ?? { score: 0, why: [] };
    return { choice: { genre: p.genre, mode: p.mode, score: entry.score, why: entry.why.join(', ') || 'no cue' }, index };
  })
    .sort((a, b) => tier(a.choice, a.choice.score, decided) - tier(b.choice, b.choice.score, decided) || b.choice.score - a.choice.score || a.index - b.index)
    .map((item) => item.choice);

  let decided: string | null = null;
  if (reading !== null) {
    // P58B T5: rozhoduje platný žánr čtení, který hraje. Slovník jen když si čtení není jisté (`sure: false`) a slovník
    // něco slyšel – body ze sloves čtení ho pak nepřeskočí. Slovník řadí zbytek, kam se ustupuje, když se režim čtení
    // nepřeloží nebo neprojde robotem. Dřív (P56A T5) rozhodl slovník, kdykoli první slyšel nový žánr P54C – na dev
    // P58B tak 2× přebil správné čtení astry (p56a s02, p55 h78), u gpt-oss-20b 4× (P56A s02, s03, s09, s12).
    const heard = order(null)[0];
    // Čtení uložená před P56A T3 (`read/__fixtures__/readings.json`) pole `genre` nemají, před P58B T5 pole `sure`.
    const read = reading.genre ?? null;
    // P58B T6: čtení řeklo, že žádný žánr nesedí (tahová hra, rozhovor, focení) – slovo pasti ve větě („card battle“,
    // „rock band“, „shoot pics“) pak nerozhoduje. Hraje se jako věta bez narážky: chůze po scéně z věty, útěk, jen když
    // čtení jmenuje pronásledovatele – slovo „escape room“ útěk nespustí. Na dev P58B slovník po takovém čtení 4× zvolil
    // lákavý žánr; na p30/dev po promptu T6 čte „nic nesedí“ už jen nehry (daně, rande, dopis), dřív i věž z palačinek.
    const roam = reading.roles.some((role) => role.kind === 'chaser') ? ESCAPE : COLLECT;
    if (read !== null && scores.has(key(read)) && availability(read) === 'ready') {
      add(read, 4, `reading genre "${key(read)}"`);
      decided = reading.sure === false && heard !== undefined && heard.score > 0 ? key(heard) : key(read);
    } else if (reading.genre === null && scores.has(key(roam)) && availability(roam) === 'ready') {
      add(roam, 4, 'reading: no genre fits');
      decided = key(roam);
    }
    reading.verbs.forEach((verb, index) => {
      const pick = READ_CLASS[verb.class];
      if (pick === undefined) return;
      add(pick ?? pickup(), index === 0 ? 2 : 1, `reading "${verb.word}"`);
    });
    if (reading.roles.some((role) => role.kind === 'chaser')) add(ESCAPE, 1, 'reading: chaser');
  }
  const ranked = order(decided);

  return {
    ranked,
    fallback: availability(ranked[0]) === 'fallback',
    verb: main?.verb ?? reading?.verbs[0]?.word ?? null,
    after: main === undefined ? null : text.slice(main.end).trim() || null,
    pick: main === undefined ? null : (main.pick ?? pickup()),
    ride: carrier === undefined ? null : 'shoot',
    does: main?.does ?? null,
    decided: decided !== null,
  };
}
