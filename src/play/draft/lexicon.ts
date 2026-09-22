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

/** Hádanka pořadí: spínače jdou zapnout jen v daném pořadí (`switch.ordered`). */
export const ORDER_PUZZLE = /\bin (?:the )?(?:right|correct|exact) order\b/;

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
  delivery: [/\bcarry(?:ing)?\b|\bcarries\b/, /\bdeliver(?:s|ed|ing)?\b/, /\bbring(?:s|ing)?\b/, /\bfragile\b/],
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
  combat_lite: [/\bdefeat(?:s|ed|ing)?\b/, /\bknock(?:s|ed|ing)? out\b/, /\bhit(?:s|ting)?\b/, /\bdestroy(?:s|ed|ing)?\b/, /\btargets?\b/],
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

/** Slova, na kterých končí jmenná fráze role. */
const PHRASE_STOP = new Set([
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

/** Prvních nejvýš `max` slov po členu a číslovce, do zarážky nebo interpunkce. */
export function nounPhrase(text: string, max = 3): string | null {
  let rest = text.trim().toLowerCase().replace(ARTICLES, '').replace(NUMBER_PREFIX, '').replace(ARTICLES, '');
  const words: string[] = [];
  for (const raw of rest.split(/\s+/)) {
    const word = raw.replace(/[^a-z-]/g, '');
    const punctuated = /[.,;:!?]$/.test(raw);
    if (word === '' || PHRASE_STOP.has(word) || NUMBER_WORDS[word] !== undefined) break;
    words.push(word);
    if (punctuated || words.length === max) break;
  }
  rest = words.join(' ');
  return rest === '' ? null : rest;
}

/** Hrubé jednotné číslo pro `label`: `coins → coin`, `dummies → dummy`, `boxes → box`. */
export function singular(phrase: string): string {
  const words = phrase.split(' ');
  const last = words[words.length - 1];
  const single = last.endsWith('ies')
    ? `${last.slice(0, -3)}y`
    : /(?:ses|xes|ches|shes)$/.test(last)
      ? last.slice(0, -2)
      : last.endsWith('s') && !last.endsWith('ss')
        ? last.slice(0, -1)
        : last;
  return [...words.slice(0, -1), single].join(' ');
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

export function readRoles(sentence: string): SentenceRoles {
  const text = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
  const player = first(text, [
    /\b(?:i'?m|i am|you are|you're|play as|playing as) (?:a |an |the )?([a-z][a-z -]*)/,
    /^(?:a |an |the )([a-z][a-z -]*?) (?:escapes|flees|runs|races|carries|delivers|brings|hunts|must|has to|sneaks|crosses)\b/,
  ], 2);
  const chaser = first(text, [
    /\b([a-z]+(?: [a-z]+)?) (?:hunts|chases|pursues|catches|follows|stalks) (?:it|you|me|them|him|her|the player)\b/,
    /\b(?:hunted|chased|pursued|followed) by (?:a |an |the )?([a-z][a-z -]*)/,
    /\b(?:flees|escapes|escape|flee|run from|runs from|outrun|outruns) (?:from )?(?:a |an |the )?([a-z][a-z -]*)/,
  ], 2);
  const collectible = first(text, [/\b(?:collect|gather|find|pick up|grab|steal)s? (?:all |every )?(?:of )?(?:the )?((?:\d+ |[a-z]+ )?[a-z][a-z -]*)/], 2);
  const delivery = /\b(?:carry|deliver|bring|take|escort)s? (?:a |an |the )?([a-z][a-z -]*?) (?:from (?:a |an |the )?[a-z][a-z -]*? )?(?:across (?:a |an |the )?[a-z][a-z -]*? )?to (?:a |an |the )?([a-z][a-z -]*)/.exec(text);
  const target = first(text, [/\b(?:defeat|destroy|knock out|hit|smash|beat)s? (?:all |every |the )?(?:of )?(?:the )?((?:\d+ |[a-z]+ )?[a-z][a-z -]*)/], 2);
  const checkpointMatch = /(?:[a-z]+ )?((?:[a-z]+ )?(?:gates?|hoops?|rings?|checkpoints?|flags?|arches?|posts?))\b/.exec(text);
  const hazardMatch = HAZARD_WORDS.exec(text);
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
