/**
 * Výběr ovládání ze slov (P25A T7, P25C T7, P25G T6): věta → `runner`,
 * `platform`, `flap`, `throw`, `shooter`, nebo `null` (= dnešní `tap_go`
 * bez pole `control`). Hod a střelba mají přednost před běžcem a plošinovkou:
 * „shoot“ nebo „throw“ ve větě říká, co hráč dělá, „run“ a „jump“ ne.
 *
 * Silné narážky (žánr, známý titul) stačí samy. Slabé („run“, „jump“,
 * „dodge“) se sčítají a běžce dají až dvě – jedno slovo samo je v korpusu
 * i u plošinovek, přechodů a načasovaných her („ski jumping“, „dodging
 * ghosts“). Přednost: poletování > silný běžec > silná plošinovka > slabý
 * běžec > slabá plošinovka – „endless runner“ zůstává běžcem, i když skáče.
 * Řízení (`steer`) a aréna (`move_free`, P25F) mají jen silné narážky a stojí
 * hned za silným běžcem.
 * Hustotu a obtížnost čte jen z kvantifikátorů; co věta neřekne, doplní
 * generátor svým výchozím.
 *
 * P25H: rytmus, souboj a načasování mají jen silné narážky (žánr, titul,
 * sloveso hry) a jdou hned za poletováním – „tap to the beat“ ani „time
 * your jumps“ nejsou skákačka, „sword fighting with ninjas“ není běh.
 */

import type { ArenaDensity } from '../arcade/pieces/arena';
import type { DuelDifficulty } from '../arcade/pieces/duel';
import type { FlapDifficulty } from '../arcade/pieces/flap';
import type { PlatformDifficulty } from '../arcade/pieces/platform';
import type { RhythmDensity } from '../arcade/pieces/rhythm';
import type { RunnerDensity } from '../arcade/pieces/runner';
import type { ShooterDifficulty } from '../arcade/pieces/shooter';
import type { SteerDifficulty } from '../arcade/pieces/steer';
import { HOOP_CUES, TOWER_CUES, type ThrowDifficulty, type ThrowGoal } from '../arcade/pieces/throw';
import type { TimingMode, TimingSpeed } from '../arcade/pieces/timing';
import { CAPABILITIES } from '../capabilities';
// Z kontraktu arkády, ne ze `spec.ts`: `compose/compile` tenhle modul načte i v prohlížeči (arcade-bundle).
import { ABILITIES, ADDONS, type AbilityId, type AddonId } from '../arcade/contract';
import type { Intent } from '../intent/contract';
import { extractIntent } from '../intent/extract';
import { negationScopes, singular } from './lexicon';
import type { ControlId } from '../spec';

const RHYTHM_CUES: readonly RegExp[] = [
  /\brhythm\b/,
  /\b(?:to|with|on) the beat\b/,
  /\bbeat saber\b/,
  /\bpiano tiles\b/,
  /\bguitar hero\b/,
  /\bmusic game\b/,
  /\bto (?:the )?music\b/,
  /\bdanc(?:e|es|ing)\b/,
  /\bdrumm(?:er|ing)\b/,
  /\bdisco\b/,
];

// Holé „fight“ a „ninja“ jsou moc široké („fight the boss“, „ninja running on
// rooftops“, „water gun fight“) – jen spojení, která znamenají souboj zblízka.
const DUEL_CUES: readonly RegExp[] = [
  /\bfight(?:s|ing)? (?:game|match|with|against)\b/,
  /\b(?:sword|stickman|pillow|fist|street|ninja|samurai) ?fight/,
  /\bduel\b(?!.*\bshoot)/,
  /\bbox(?:ing|er)\b/,
  /\bkarate\b/,
  /\bkung fu\b/,
  /\bdodge and (?:strike|hit|punch)\b/,
];

const TIMING_CUES: readonly RegExp[] = [
  /\bstack(?:s|ing)?\b/,
  // „tower of moving platforms“ je plošinovka – jen věž, která se staví.
  /\b(?:tallest|highest)\b[a-z ]* tower\b/,
  /\b(?:at )?the right (?:time|moment)\b/,
  /\bperfect timing\b/,
  /\btime your\b/,
  /\bstop the (?:bar|moving|block|needle)\b/,
  /\bhelix\b/,
  /\bcut the rope\b/,
  /\b(?:grow|build) a bridge\b/,
  /\bfishing\b/,
  /\bcatch it on\b/,
];

const STRONG_CUES: readonly RegExp[] = [
  /\bend+les+ runner\b/,
  /\brunner\b/,
  /\bsubway surfers?\b/,
  /\btemple run\b/,
  /\bgeometry dash\b/,
  /\bparkour\b/,
];

const WEAK_CUES: readonly RegExp[] = [
  // „run a supermarket“ je provozovat, ne běžet.
  /\b(?:run|runs)\b(?! (?:a|an|the|my|your) )/,
  /\brunning\b/,
  /\b(?:jump|jumps|jumping|hop|hops|hopping)\b/,
  /\b(?:dodge|dodges|dodging|avoid|avoids|avoiding)\b/,
  /\bobstacles?\b/,
  /\b(?:slide|slides|sliding) under\b/,
  /\bendless\b/,
  /\bskateboard\w*\b/,
];

// Narážka na mřížkovou hru přebije slabé skóre: „hop across the road and dodge
// cars“ je přechod, „run from the zombie and avoid the traps“ honička. Silnou
// narážku (žánr, titul) nepřebije.
const GRID_CUES: readonly RegExp[] = [
  /\b(?:cross|crosses|crossing)\b/,
  /\bacross the (?:road|street|river|highway|lava)\b/,
  /\b(?:runs?|running) (?:from|away)\b/,
  /\b(?:escape|escapes|escaping|flee|flees|chase|chases|chased|chasing|hunts?|hunting)\b/,
];

const FLAP_CUES: readonly RegExp[] = [/\bflapp?(?:y|s|ing)?\b/, /\btap to fly\b/, /\bbird\b.*\bpipes?\b/, /\bfly (?:through|between) (?:the )?(?:pipes|gaps)\b/];

// Hod před střelbou: „slingshot“ a „trick shots“ nejsou střílečka. Házení nožů
// na točící se kládu a „toss and catch“ jsou v korpusu načasování, kutálející
// se sněhová koule řízení.
const THROW_CUES: readonly RegExp[] = [
  /(?<!knife )\b(?:throw|throws|throwing)\b/,
  /\b(?:toss|tosses|tossing)\b(?!.*\bcatch)/,
  /\bsling ?shots?\b/,
  /\bsling\b/,
  /\bcatapult\b/,
  /\bangry birds\b/,
  // Samotné „hoops“ ne: „fly a paper plane through four hoops“ je závod přes checkpointy.
  /\bbasketball\b/,
  /\bknock(?:s|ing)? (?:down|over)\b/,
  /\bbowling\b/,
  /\bpenalty (?:kicks?|shots?)\b/,
  /\bdarts?\b/,
  /\blaunch\w* .*\bfrom a cannon\b/,
];

// „auto shooting“ (vampire survivors) je volný pohyb – střílí se samo.
const SHOOTER_CUES: readonly RegExp[] = [
  /(?<!auto[- ]|photo )\bshoot(?:s|ing|er|ers)?\b(?! stars?)/,
  /\bguns?\b/,
  /\bsniper\b/,
  /\barchery\b/,
  /\bbow and arrows?\b/,
  /\barrows?\b/,
  /\bfps\b/,
  /\bkrunker\b/,
  /\btanks? (?:battle|war|fight)s?\b/,
  /\baim(?:s|ing)? (?:at|and)\b/,
  /\btower defen[cs]e\b/,
  /\bzombie waves?\b/,
  /\bwaves? of (?:zombies|enemies|aliens|robots)\b/,
  /\bspace invaders\b/,
];

const PLATFORM_STRONG: readonly RegExp[] = [
  /\bplatformer\b/,
  /\bplatform game\b/,
  /\bobby\b/,
  // „mario kart“ je řízení.
  /\bmario\b(?! kart)/,
  /\bjump king\b/,
  /\bonly up\b/,
  /\bdoodle jump\b/,
  /\bfall guys\b/,
  // Jednotné číslo je v korpusu načasování („stop the moving platform“).
  // „floating islands/platforms“ tu schválně chybí: startovní věta a zlatá sada
  // („Cross floating islands…“, „Hop between floating platforms…“) jsou mřížkový přechod.
  /\bmoving platforms\b/,
  /\bdouble jump\b/,
  /\bledges?\b/,
  /\bjump(?:s|ing)? (?:across|between|from|onto) (?!the (?:road|street|river|highway))/,
];

// „hill climb racing“ je řízení.
const PLATFORM_WEAK: readonly RegExp[] = [/(?<!hill )\bclimb(?:s|ing)?\b/, /\bbounc(?:e|es|ing)\b/, /\bspikes?\b/];

// Řízení (P25F): vozidlo, závod, letadlo. „drive out / drive cars“ je v korpusu
// posouvačka a GTA, „food truck“ vaření, „park“ místo – proto ty výjimky.
const STEER_CUES: readonly RegExp[] = [
  /\brac(?:e|es|ing|er|ers)\b/,
  /\bdriving\b/,
  /\bdrive (?:a|an|the|your|my) /,
  /\bkart\b/,
  /\bdrift\w*/,
  /\bpark(?:ing)? (?:game|without)\b/,
  /\bbumper cars?\b/,
  /\b(?:plane|airplane|pilot)s?\b/,
  /\bfly (?:a|an|the) /,
  /\b(?:(?<!food )truck|motorbike|motorcycle|scooter|sled|boat|kayak)s?\b/,
  /\bon wheels\b/,
  /\bformula 1\b/,
  /\brocket league\b/,
  /\bsurf(?:er|ing)\b/,
  /\bsteer\w*/,
  /\broll(?:s|ing)? (?:down|through)\b/,
];

// Závod branami nebo obručemi v pořadí je mřížkový `checkpoint_race` (zlatá sada).
const GATE_RACE = /\b(?:gates?|hoops?|rings?|checkpoints?|in (?:the right )?order)\b/;

// Aréna (P25F): jíst menší a růst, io hry, strkanice. „grow a bridge / a garden“
// je načasování a idle, „gets bigger then“ běžec s davem, „hungry seal“ honička.
const ARENA_CUES: readonly RegExp[] = [
  /\bagar\b/,
  /\bslither\b/,
  /\bpaper ?io\b/,
  /\beat(?:s|ing)? (?:smaller|everything)\b/,
  /\bsmaller (?:fish|cells?|ones)\b/,
  /\bbigger the more\b/,
  /\b(?:grow|grows|growing)\b(?! (?:a|an|the|your|my) )/,
  /\bswallow\w*/,
  /\bsnake game\b/,
  /\bsumo\b/,
  /\bbattle royale\b/,
  /\bbump\w* (?:other|everyone)/,
  /\bpush everyone\b/,
  /\bsurvive (?:the )?(?:swarm|waves)\b/,
  /\barena\b/,
];

const HIGH_DENSITY =/\b(?:a lot of|lots of|many|tons of|loads of|full of|everywhere|hard|super hard)\b/;
const LOW_DENSITY = /\b(?:few|easy|simple|chill|relaxing|calm)\b/;

export type ControlChoice =
  | { readonly control: 'runner'; readonly density: RunnerDensity | null }
  | {
      readonly control: 'platform';
      readonly difficulty: PlatformDifficulty | null;
      readonly movingPlatforms: boolean;
      readonly doubleJump: boolean;
    }
  | { readonly control: 'flap'; readonly difficulty: FlapDifficulty | null }
  | { readonly control: 'steer'; readonly difficulty: SteerDifficulty | null; readonly drift: boolean }
  | { readonly control: 'move_free'; readonly density: ArenaDensity | null }
  | { readonly control: 'shooter'; readonly difficulty: ShooterDifficulty | null }
  | { readonly control: 'throw'; readonly difficulty: ThrowDifficulty | null; readonly goal: ThrowGoal | null }
  | { readonly control: 'timing'; readonly mode: TimingMode; readonly speed: TimingSpeed | null }
  | { readonly control: 'rhythm'; readonly density: RhythmDensity | null }
  | { readonly control: 'duel'; readonly difficulty: DuelDifficulty | null };

export function runnerScore(text: string): number {
  if (STRONG_CUES.some((cue) => cue.test(text))) return 2;
  if (GRID_CUES.some((cue) => cue.test(text))) return 0;
  return WEAK_CUES.filter((cue) => cue.test(text)).length;
}

/** 2 = silná narážka, 1 = slabá (a žádná mřížková), 0 = nic. */
function platformScore(text: string): number {
  if (PLATFORM_STRONG.some((cue) => cue.test(text))) return 2;
  if (GRID_CUES.some((cue) => cue.test(text))) return 0;
  return PLATFORM_WEAK.some((cue) => cue.test(text)) ? 1 : 0;
}

const difficultyOf = (text: string): 'easy' | 'hard' | null => (HIGH_DENSITY.test(text) ? 'hard' : LOW_DENSITY.test(text) ? 'easy' : null);

/**
 * Druhé sloveso jako doplněk (P26D T8). Střelba pozná jen sloveso, ne „photo
 * shoot“ ani „shooting stars“; sbírání jen sloveso („coin factory“ nic nesbírá);
 * pronásledovatel jen hráče, kterého někdo honí; životy jen s počtem.
 */
const ADDON_CUES: Readonly<Record<AddonId, RegExp>> = {
  shoot: /(?<!(?:photo|auto)[- ])\bshoot(?:s|ing)?\b(?! stars?)|\bblast(?:s|ing)? (?:the |at )?(?!off\b)\w+/,
  collect: /\b(?:collect(?:s|ing)?|grab(?:s|bing)?|gather(?:s|ing)?|pick(?:s|ing)? up)\b/,
  chaser: /\b(?:chased|hunted|followed) by\b|\bchas(?:es|ing) (?:you|u|me|him|her|them|the player)\b/,
  lives: /\b(?:\d+|two|three|four|five|a few|extra) (?:lives|hearts)\b/,
};

/**
 * Akce hrdiny ze sloves věty (P46A T8). Krádež jen ze sloves krádeže a uchopení:
 * „collect“ a „catch“ mají vlastní mechaniku (sběr dotykem, chycení v aréně),
 * tlačítko Grab by přibylo každé hře s mincemi. „hit“ ne, když hrdinu něco trefí.
 */
const ABILITY_CUES: Readonly<Record<AbilityId, RegExp>> = {
  shoot: /(?<!(?:photo|auto)[- ])\bshoot(?:s|ing)?\b(?! stars?)|\bblast(?:s|ing)? (?:the |at )?(?!off\b)\w+|\bfir(?:e|es|ing) (?:at|on|back)\b|\bfir(?:e|es|ing) (?:[a-z]+ ){1,2}at\b|\bbreath(?:e|es|ing) fire\b|\blaser(?:s|ing)?\b|\bzap(?:s|ping)?\b|\bsnip(?:e|es|ing)\b|\bspit(?:s|ting)? (?:[a-z]+ ){0,2}at\b/,
  strike: /\b(?:fight(?:s|ing)?|punch(?:es|ing)?|kick(?:s|ing)?|strike(?:s)?|striking|slash(?:es|ing)?|slap(?:s|ping)?|smash(?:es|ing)?|bash(?:es|ing)?|attack(?:s|ing)?|crush(?:es|ing)?)\b|(?<!\b(?:get|gets|getting|got|be|being|without|avoid|avoids|avoiding|not|never) )\bhit(?:s|ting)?\b(?! by\b)|\b(?:bit(?:e|es|ing)|peck(?:s|ing)?|sting(?:s|ing)?|pinch(?:es|ing)?|swat(?:s|ting)?|chop(?:s|ping)?|stab(?:s|bing)?|whack(?:s|ing)?|tackl(?:e|es|ing)|ram(?:s|ming)?|headbutt(?:s|ing)?|shov(?:e|es|ing))\b/,
  dash: /\b(?:dash(?:es|ing)?|dodg(?:e|es|ing)|duck(?:s|ing)?|evad(?:e|es|ing)|swerv(?:e|es|ing)|sidestep(?:s|ping)?)\b|\bzip(?:s|ping)? (?:past|around|between|through)\b|\bweav(?:e|es|ing) (?:through|between|around|past)\b|\b(?:leap|leaps|leaping|jump|jumps|jumping|dart|darts|darting) aside\b|\bescap(?:e|es|ing) quickly\b/,
  shield: /\b(?:block(?:s|ing)?|defend(?:s|ing)?|protect(?:s|ing)?|shield(?:s|ing)?|guard(?:s|ing)?|deflect(?:s|ing)?|parr(?:y|ies|ying)|shelter(?:s|ing)?)\b/,
  grab: /\b(?:steal(?:s|ing)?|stole|grab(?:s|bing)?|snatch(?:es|ing)?|swip(?:e|es|ing)|loot(?:s|ing)?|rob(?:s|bing)?|pickpocket(?:s|ing)?|nab(?:s|bing)?|pilfer(?:s|ing)?)\b/,
};

/** Úder a střelba ze záměru věty (P47B T3): osa akce `extractIntent`, i slovesa otevřeného slovníku P44C („shoves“ → kick, „zaps“ → shoot). */
const INTENT_ABILITY: Readonly<Record<string, AbilityId>> = { shoot: 'shoot', fight: 'strike', kick: 'strike' };

/**
 * Slova mezi podmětem a slovesem, za kterými sloveso patří hrdinovi z předchozí klauze
 * („runs and dodges“, „it shoots“, „tries to steal“). Čárka taky: „shoots, punches, steals“.
 */
const LINKERS = new Set([',', 'and', 'or', 'then', 'to', 'can', 'will', 'must', 'also', 'just', 'still', 'even', 'always', 'who', 'that', 'he', 'she', 'it', 'they', 'you', 'i', 'we', 'by']);
/** Spojky, za kterými přichází nový podmět; hrdinovi patří jen tvar na -ing („while dodging“). */
const SUBORDINATORS = new Set(['while', 'as', 'when', 'whenever', 'until', 'before', 'after', 'because']);
/** Odmítnutí, které `negationScopes` nečte: „refuses to shoot“. */
const REFUSAL = /\brefus(?:e|es|ing) to $/;
/** Úder na věc, která nepřítel není: míč, nástroj, bedna sokobanu („kicks a football“, „hits the drums“, „pushes crates“). */
const NOT_A_FOE = /^ (?:a |an |the |his |her |its |their |some |\d+ )?(?:[a-z]+ )?(?:balls?|football|drums?|notes?|keys|piano|bells?|gongs?|crates?|box(?:es)?|blocks?|carts?|buttons?|levers?|switch(?:es)?)\b/;

/**
 * Patří sloveso na `[at, end)` hrdinovi? Ano, když před ním stojí hrdina (podmět první klauze)
 * nebo spojovací slovo. Ne, když před ním je člen, číslovka, „of“, přídavné jméno nebo jiné
 * podstatné jméno – to je podstatné jméno („wooden blocks“, „a shield“) nebo sloveso nepřítele
 * („while sharks bite“, „the ghosts shoot back“, „cars blocking“).
 */
function heroDoes(text: string, at: number, end: number, hero: ReadonlySet<string>, id: AbilityId): boolean {
  if (REFUSAL.test(text.slice(0, at))) return false;
  if (id === 'strike' && NOT_A_FOE.test(text.slice(end))) return false;
  const before = text.slice(0, at).match(/[a-z']+|,/g) ?? [];
  while (before.length > 0 && /ly$/.test(before[before.length - 1]!)) before.pop();
  const prev = before[before.length - 1];
  if (prev === undefined) return false;
  if (SUBORDINATORS.has(prev)) return /ing\b/.test(text.slice(at, end));
  if (LINKERS.has(prev)) return true;
  if (!hero.has(prev) && !hero.has(singular(prev))) return false;
  // Po jednotném čísle má sloveso -s: „a photo shoot“ je podstatné jméno, „a fox shoots“ sloveso.
  return /s$/.test(prev) || /(?:s|ing|ed)$/.test(text.slice(at, end).split(' ')[0]!);
}

/**
 * Slova podmětu první klauze pro `heroDoes`. Záměr dá první slovo hrdiny („amanita“ z „amanita
 * mushrooms“), proto i slovo hned za ním na začátku věty. Bez hrdiny ze záměru slovo před první
 * akcí, stojí-li na začátku věty („a mother hen shelters“). Slovo, které záměr čte jako
 * sloveso („a toddler stacks blocks“), podmět není.
 */
function heroOf(text: string, intent: Pick<Intent, 'hero' | 'items'>, first: number | undefined): Set<string> {
  const verbs = new Set(intent.items.map((item) => item.said.toLowerCase()));
  const words = text.match(/[a-z']+/g) ?? [];
  const words4 = words.slice(0, 4);
  const head = intent.hero?.split(' ').pop();
  const at = head === undefined ? -1 : words4.findIndex((word) => word === head || singular(word) === head);
  const fallback = head === undefined && first !== undefined ? (text.slice(0, first).match(/[a-z']+/g) ?? []) : [];
  // Hrdina ze záměru zůstává, i když nese pohyb („a motorbike“ → jízda); slova kolem něj jen nejsou-li sloveso.
  const near = [at < 0 ? undefined : words4[at + 1], fallback.length <= 4 ? fallback[fallback.length - 1] : undefined];
  return new Set([head, ...near.filter((word) => word === undefined || !verbs.has(word))].filter((word): word is string => word !== undefined));
}

/** Hrdina má nejvýš 2 akce (tlačítka A, B). */
const MAX_ABILITIES = 2;

/**
 * Všechny akce, které věta hrdinovi říká, v pořadí věty, bez sloves v záporu („doesn't shoot“)
 * a bez sloves, která dělá někdo jiný. `text` je věta malými písmeny; `intent` její záměr
 * (`assemble` ho předá, jinak se přečte).
 */
export function saidAbilities(text: string, intent: Pick<Intent, 'hero' | 'items'> = extractIntent(text)): AbilityId[] {
  const scopes = negationScopes(text);
  const found: { id: AbilityId; at: number; end: number }[] = [];
  for (const id of ABILITIES)
    for (const match of text.matchAll(new RegExp(ABILITY_CUES[id].source, 'g'))) found.push({ id, at: match.index, end: match.index + match[0].length });
  for (const item of intent.items) {
    const id = item.axis === 'action' && item.essential ? INTENT_ABILITY[item.verb] : undefined;
    const at = id === undefined ? -1 : text.indexOf(item.said.toLowerCase());
    // Ruční seznam má přednost: „parries“ je štít, i když ho slovník P44C přiblíží k úderu.
    if (id !== undefined && at >= 0 && !found.some((cue) => cue.at === at)) found.push({ id, at, end: at + item.said.length });
  }
  const live = found.filter(({ at }) => !scopes.some(([from, to]) => at >= from && at < to)).sort((a, b) => a.at - b.at);
  const hero = heroOf(text, intent, live[0]?.at);
  const ordered: AbilityId[] = [];
  for (const { id, at, end } of live) if (!ordered.includes(id) && heroDoes(text, at, end, hero, id)) ordered.push(id);
  return ordered;
}

/** Z akcí věty `said` ty, které ovládání bere, nejvýš 2 (první = A = J). */
export const abilitiesOfControl = (said: readonly AbilityId[], control: ControlId): AbilityId[] =>
  said.filter((id) => CAPABILITIES[control].abilities.includes(id)).slice(0, MAX_ABILITIES);

export const abilitiesFor = (text: string, control: ControlId): AbilityId[] => abilitiesOfControl(saidAbilities(text), control);

/** Akce na tlačítkách v nápovědě („J to strike, K to shoot.“). */
export const abilityHint = (abilities: readonly AbilityId[]): string => `${abilities.map((id, slot) => `${slot === 0 ? 'J' : 'K'} to ${id}`).join(', ')}.`;

// Pohyb ve větě: „fight“ s během, závodem nebo skokem je úder za jízdy, ne souboj na místě.
const TRAVEL = /\b(?:run|runs|running|race|races|racing|jump|jumps|jumping|hop|hops|hopping|flee|flees|fleeing|drive|drives|driving)\b/;

// „jump and shoot“, „run and collect“: dvě slovesa hráče – pohyb je základ, druhé
// sloveso doplněk (jinak by vyhrála střelnice, a samotné „run“ běžce nedá).
const MOVE_AND_VERB = /\b(jump|hop|run)\w*(?: \w+){0,5} and (?:shoot|collect|grab|gather|pick)|\bshoot\w* (?:and|while) (jump|hop|run)/;

/** Ovládání ze slov (níž) a doplňky, které jeho tabulka schopností bere. */
export type ControlPick = ControlChoice & { readonly addons?: readonly AddonId[]; readonly abilities?: readonly AbilityId[] };

/** `text` je věta malými písmeny. Klíče `addons` a `abilities` jen když je věta řekla. */
export function pickControl(text: string): ControlPick | null {
  const pair = MOVE_AND_VERB.exec(text);
  const choice = pickBase(text, pair !== null) ?? (pair === null ? null : moveOf(pair[1] ?? pair[2] ?? 'jump', text));
  if (choice === null) return null;
  const allowed = CAPABILITIES[choice.control].addons;
  const addons = ADDONS.filter((addon) => allowed.includes(addon) && ADDON_CUES[addon].test(text));
  const abilities = abilitiesFor(text, choice.control);
  return { ...choice, ...(addons.length === 0 ? {} : { addons }), ...(abilities.length === 0 ? {} : { abilities }) };
}

/**
 * Nejbližší arkádová hra (P28D T2, F-05) pro větu, ve které `pickControl` ani
 * archetypy mřížky nic neslyší – dřív z ní byl sběr hub na mřížce. Nejdřív
 * sloveso, pak podstatné jméno, jinak běžec: nejjednodušší hra a funguje na
 * telefonu. `why: 'default'` = věta žádnou narážku nemá (T4 to hráči řekne).
 */
const NEAREST_VERBS: readonly (readonly [RegExp, ControlChoice['control']])[] = [
  [/\b(?:pop|pops|popping|popped|defend|defends|defending|protect|protects|protecting|zap|zaps|zapping|blast|blasts|blasting)\b/, 'shooter'],
  [/\b(?:fight|fights|fighting|duel|duels|punch|punches|punching|kick|kicks|kicking|battle|battles|battling)\b/, 'duel'],
  [/\b(?:throw|throws|throwing|toss|tosses|tossing|knife|knives)\b/, 'throw'],
  [/\b(?:beat|beats|rhythm|sing|sings|singing|song|songs|music|dance|dances|dancing)\b/, 'rhythm'],
  [/\b(?:fly|flies|flying|ride|rides|riding|soar|soars|soaring|glide|glides|gliding)\b/, 'flap'],
  [/\b(?:race|races|racing|drive|drives|driving)\b/, 'steer'],
  [/\b(?:dodge|dodges|dodging|avoid|avoids|avoiding|survive|survives|surviving)\b/, 'move_free'],
  [/\b(?:jump|jumps|jumping|hop|hops|hopping|climb|climbs|climbing)\b/, 'platform'],
];

const NEAREST_NOUNS: readonly (readonly [RegExp, ControlChoice['control']])[] = [
  [/\b(?:balloons?|targets?|aliens?|zombies?|monsters?|skeletons?|invaders?)\b/, 'shooter'],
  [/\b(?:birds?|dragons?|wings?|sky|skies|clouds?)\b/, 'flap'],
  [/\b(?:balls?|baskets?)\b/, 'throw'],
  [/\b(?:drums?|guitars?|pianos?|concert|disco)\b/, 'rhythm'],
  [/\b(?:cars?|bikes?|bicycles?|horses?|roads?)\b/, 'steer'],
];

export type NearestPick = { readonly choice: ControlChoice; readonly why: 'verb' | 'noun' | 'default' };

export function nearestControl(text: string): NearestPick {
  const byVerb = NEAREST_VERBS.find(([cue, control]) => cue.test(text) && (control !== 'duel' || !TRAVEL.test(text)))?.[1];
  if (byVerb !== undefined) return { choice: defaultChoice(byVerb, text), why: 'verb' };
  const byNoun = NEAREST_NOUNS.find(([cue]) => cue.test(text))?.[1];
  if (byNoun !== undefined) return { choice: defaultChoice(byNoun, text), why: 'noun' };
  return { choice: defaultChoice('runner', text), why: 'default' };
}

function defaultChoice(control: ControlChoice['control'], text: string): ControlChoice {
  const level = difficultyOf(text);
  switch (control) {
    case 'runner':
      return { control, density: level === 'hard' ? 'high' : level === 'easy' ? 'low' : null };
    case 'platform':
      return { control, difficulty: level, movingPlatforms: false, doubleJump: false };
    case 'steer':
      return { control, difficulty: level, drift: false };
    case 'move_free':
      return { control, density: level === 'hard' ? 'dense' : level === 'easy' ? 'sparse' : null };
    case 'throw':
      return { control, difficulty: level, goal: null };
    case 'timing':
      return { control, mode: 'precision', speed: null };
    case 'rhythm':
      return { control, density: null };
    default:
      return { control, difficulty: level };
  }
}

/** Základ dvojice „jump/run and shoot“, když věta jinou narážku nemá. */
function moveOf(verb: string, text: string): ControlChoice {
  if (verb === 'run') return { control: 'runner', density: HIGH_DENSITY.test(text) ? 'high' : LOW_DENSITY.test(text) ? 'low' : null };
  return { control: 'platform', difficulty: difficultyOf(text), movingPlatforms: /\bmoving platforms?\b/.test(text), doubleJump: /\bdouble jump/.test(text) };
}

function pickBase(text: string, moveAndShoot: boolean): ControlChoice | null {
  if (FLAP_CUES.some((cue) => cue.test(text))) return { control: 'flap', difficulty: difficultyOf(text) };
  const level = difficultyOf(text);
  if (RHYTHM_CUES.some((cue) => cue.test(text))) return { control: 'rhythm', density: level === 'hard' ? 'dense' : level === 'easy' ? 'sparse' : null };
  // Souboj zblízka před hodem a střelbou: „throw punches“ i „gun fight“ jsou souboj,
  // a narážky souboje jsou úzké (holé „fight“ mezi nimi není).
  if (DUEL_CUES.some((cue) => cue.test(text)) && !TRAVEL.test(text)) return { control: 'duel', difficulty: level };
  // Výslovný žánr plošinovky přebije hod i střelbu („a tower defense platformer“).
  const platformer = /\bplatform(?:er| game)\b/.test(text) || moveAndShoot;
  if (!platformer && THROW_CUES.some((cue) => cue.test(text))) {
    return { control: 'throw', difficulty: difficultyOf(text), goal: HOOP_CUES.test(text) ? 'hoop' : TOWER_CUES.test(text) ? 'tower' : null };
  }
  if (!platformer && SHOOTER_CUES.some((cue) => cue.test(text))) return { control: 'shooter', difficulty: difficultyOf(text) };
  if (TIMING_CUES.some((cue) => cue.test(text))) {
    const mode = /\b(?:bridge|rope)\b/.test(text) ? 'bridge' : /\b(?:stack|stacks|stacking|tower|pile)\b/.test(text) ? 'stack' : 'precision';
    return { control: 'timing', mode, speed: level === 'hard' ? 'fast' : level === 'easy' ? 'slow' : null };
  }
  const runner = runnerScore(text);
  const platform = platformScore(text);
  const strongRunner = STRONG_CUES.some((cue) => cue.test(text));
  // Řízení před arénou: „bumper cars arena“ je řízení, sněhová koule, která „gets
  // bigger“, taky. Silný běžec má přednost („subway surfers“).
  if (!strongRunner && !GATE_RACE.test(text) && STEER_CUES.some((cue) => cue.test(text))) return { control: 'steer', difficulty: difficultyOf(text), drift: /\bdrift/.test(text) };
  if (!strongRunner && ARENA_CUES.some((cue) => cue.test(text))) {
    return { control: 'move_free', density: HIGH_DENSITY.test(text) ? 'dense' : LOW_DENSITY.test(text) ? 'sparse' : null };
  }
  if (!strongRunner && (platform === 2 || (runner < 2 && platform === 1))) {
    return { control: 'platform', difficulty: difficultyOf(text), movingPlatforms: /\bmoving platforms?\b/.test(text), doubleJump: /\bdouble jump/.test(text) };
  }
  if (runner < 2) return null;
  const density = HIGH_DENSITY.test(text) ? 'high' : LOW_DENSITY.test(text) ? 'low' : null;
  return { control: 'runner', density };
}
