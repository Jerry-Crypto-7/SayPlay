/**
 * Absurdní přenos (P37A T5): věta mimo hry („pay the electricity bill“, „a long
 * queue at the pharmacy“) se hraje jako hra, ve které hráč svou větu pozná –
 * podstatná jména věty jsou hrdina, věci a soupeř a cíl v HUD je jmenuje
 * („Dodge the long queues!“, „Collect the phones!“).
 *
 * Nálada věty vybere režim Arény: nepříjemnost (zkouška, fronta, šéf, „scary“,
 * „awkward“) je útěk – co děsí, honí hrdinu; jinak sběr – věc z věty se sbírá.
 * Slova se poznávají jen z uzavřených seznamů tady a z katalogu modelů; slovo,
 * které neznají, roli nedostane. Místo (`lookFor`) a nábytek jsou kulisa, ne role.
 *
 * Cíl v HUD skládá `twistGoal` z uzavřeného anglického vzoru a jen z popisků,
 * které věta opravdu říká – výchozí role z prostředí („wolf“) do něj nejdou.
 */

import { lookFor } from '../arcade/look';
import { modelOf } from '../arcade/models';
import type { GenreSpec } from '../genre/contract';

import { plural, singular } from './lexicon';

/** Lidé, kterým se hráč vyhýbá: autorita a protějšek nepříjemné chvíle. */
const FOE_PEOPLE = new Set([
  'boss', 'manager', 'supervisor', 'teacher', 'professor', 'principal', 'dentist', 'doctor', 'advisor', 'adviser', 'landlord',
  'neighbor', 'neighbour', 'coworker', 'co-worker', 'colleague', 'in-law', 'parent', 'team', 'client', 'cop', 'police', 'officer',
  'inspector', 'judge', 'accountant', 'banker', 'cashier', 'clerk', 'agent', 'operator', 'receptionist', 'interviewer', 'examiner',
  'salesman', 'ex', 'relative', 'stranger', 'coach', 'lawyer', 'auditor', 'recruiter', 'telemarketer', 'bully', 'critic',
]);

/** Blízcí a mazlíčci: hrdina věty, nebo soupeř sporu (`argue with my wife`). */
const KIN = new Set([
  'grandma', 'granny', 'grandpa', 'grandmother', 'grandfather', 'mom', 'mum', 'mother', 'dad', 'father', 'son', 'daughter', 'kid',
  'child', 'toddler', 'baby', 'wife', 'husband', 'sister', 'brother', 'friend', 'girlfriend', 'boyfriend', 'uncle', 'aunt', 'cousin',
  'roommate', 'teenager', 'student', 'partner', 'family', 'cat', 'kitten', 'dog', 'puppy', 'hamster', 'parrot',
]);

/** Věci a chvíle, kterých se člověk bojí; tvorové hororu taky. */
const DREAD = new Set([
  'exam', 'test', 'quiz', 'deadline', 'tax', 'bill', 'invoice', 'fine', 'debt', 'rent', 'mortgage', 'audit', 'root-canal', 'alarm',
  'meeting', 'standup', 'lecture', 'conference', 'interview', 'queue', 'traffic', 'price', 'silence', 'overtime', 'paperwork', 'chore',
  'commute', 'hangover', 'flu', 'tornado', 'storm', 'laser', 'zombie', 'ghost', 'monster', 'dragon', 'spider', 'wasp', 'shark', 'snake',
  'rat', 'cockroach', 'mosquito', 'zoom-meeting',
]);

/** Přívlastek, který z věci udělá nepříjemnost („scary letter“, „long queue“); popisek ho nese. */
const DREAD_ADJ = new Set([
  'scary', 'awkward', 'boring', 'bored', 'long', 'rising', 'loud', 'angry', 'moldy', 'overdue', 'late', 'endless', 'annoying', 'noisy',
  'rude', 'grumpy', 'crying', 'screaming', 'terrible', 'horrible', 'awful', 'nasty', 'creepy', 'stinky', 'smelly',
]);

/** Domácí a kancelářské věci, které katalog nemusí znát; scéna je nakreslí tvarem, HUD je jmenuje. */
const THINGS = new Set([
  'receipt', 'report', 'passport', 'letter', 'paper', 'document', 'form', 'contract', 'phone', 'laptop', 'computer', 'email', 'message',
  'towel', 'sock', 'shoe', 'laundry', 'shirt', 'budget', 'chart', 'spreadsheet', 'grade', 'medicine', 'pill', 'key', 'wallet', 'coffee',
  'lunch', 'meal', 'leftover', 'vegetable', 'sugar', 'candy', 'cake', 'cookie', 'crate', 'box', 'package', 'parcel', 'plan', 'homework',
  'book', 'notebook', 'toy', 'dish', 'plate', 'gift', 'balloon', 'oven', 'fridge', 'tire', 'car', 'bus', 'van', 'train', 'bike',
  'umbrella', 'ticket', 'coupon', 'cash', 'money', 'coin', 'bottle', 'container', 'grocery', 'milk', 'egg', 'bread', 'pizza', 'burger',
  'party', 'pen', 'folder', 'stamp', 'card', 'photo', 'flower', 'toaster', 'taxi', 'kart', 'wedding', 'birthday',
]);

/** Kulisa: nábytek a cesta, na kterých se děj odehrává, nikdy role. */
const SCENERY = new Set(['desk', 'table', 'couch', 'sofa', 'bed', 'chair', 'floor', 'shelf', 'counter', 'wall', 'door', 'window', 'highway', 'road', 'street', 'room', 'corner', 'line', 'hold', 'home']);

/** Čas věty („last night“, „monday morning“) roli nedává. */
const TIME = new Set([
  'morning', 'afternoon', 'evening', 'night', 'tonight', 'today', 'tomorrow', 'yesterday', 'day', 'week', 'weekend', 'month', 'year',
  'hour', 'minute', 'second', 'moment', 'time', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** Slova, která katalog zná jako značku modelu, ale ve větě jsou sloveso, přívlastek nebo zájmeno. */
const NOT_NOUN = new Set([
  'old', 'man', 'up', 'extra', 'post', 'spooky', 'flaming', 'golden', 'rare', 'row', 'launch', 'cross', 'crossing', 'frost', 'heal',
  'polar', 'frozen', 'snowy', 'haunted', 'moonlit', 'medieval', 'jump', 'slide', 'paint', 'rake', 'vacuum', 'race', 'spring', 'fishing',
  'mine', 'water', 'present', 'cover', 'local', 'first', 'last', 'new', 'big', 'little', 'small', 'more', 'less', 'feeling', 'name',
  'someone', 'anyone', 'everyone', 'something', 'anything', 'everything', 'nothing', 'thing', 'way', 'reason', 'work', 'job', 'care',
]);

/** Víceslovná jména, která se čtou jako jedno slovo. */
const PHRASES: readonly (readonly [RegExp, string])[] = [
  [/\broot canals?\b/g, 'root-canal'],
  [/\bzoom (?:meeting|call)s?\b/g, 'zoom-meeting'],
  [/\bcustomer (?:support|service)(?: lines?)?\b/g, 'support-agent'],
  [/\bin[- ]laws\b/g, 'in-laws'],
];
const PHRASE_LABEL: Readonly<Record<string, string>> = { 'root-canal': 'root canal', 'zoom-meeting': 'zoom meeting', 'support-agent': 'support agent' };

type Kind = 'foe' | 'kin' | 'dread' | 'thing';

interface Noun {
  readonly label: string;
  readonly kind: Kind;
  /** Pořadí slova ve větě. */
  readonly at: number;
  /** Scéna má pro slovo model (`modelOf`). */
  readonly drawn: boolean;
}

export interface Twist {
  /** Tvor nebo blízký, o kterém věta je („my cat refusing…“, „call grandma“); `null` = hrdina z prostředí. */
  readonly hero: string | null;
  /** Kdo nebo co hráče honí: poslední autorita, jinak první nepříjemnost. */
  readonly foe: string | null;
  /** Protějšek sporu: první člověk věty (`argue with my wife about our baby` → wife); spor hrdinu z věty nebere. */
  readonly person: string | null;
  /** Věc ke sběru: napřed ta, kterou scéna nakreslí, pak pořadím ve větě. */
  readonly thing: string | null;
}

const kindOf = (word: string): Kind | null => {
  if (FOE_PEOPLE.has(word) || word === 'support-agent') return 'foe';
  if (KIN.has(word)) return 'kin';
  if (DREAD.has(word)) return 'dread';
  if (SCENERY.has(word) || TIME.has(word) || NOT_NOUN.has(word)) return null;
  if (THINGS.has(word)) return 'thing';
  // Místo („pharmacy“, „office“) je kulisa; věc z katalogu je věc.
  if (lookFor(word) !== null) return null;
  return word.length >= 3 && modelOf(word, false) !== undefined ? 'thing' : null;
};

/** Podstatná jména věty z uzavřených seznamů a katalogu, v pořadí věty. */
function nounsOf(sentence: string): Noun[] {
  let text = sentence.toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z\s-]/g, ' ');
  for (const [pattern, token] of PHRASES) text = text.replace(pattern, token);
  const words = text.split(/\s+/).filter((word) => word !== '');
  const nouns: Noun[] = [];
  let dread: string | null = null;
  words.forEach((raw, at) => {
    const word = raw === 'in-laws' ? 'in-law' : singular(raw);
    if (DREAD_ADJ.has(raw)) {
      dread = raw;
      return;
    }
    const kind = kindOf(word);
    if (kind === null) {
      // Přívlastek platí jen pro slovo hned za ním („long queue“), ne pro celou větu.
      if (!/^(?:a|an|the|my|your|his|her|our|their)$/.test(raw)) dread = null;
      return;
    }
    const name = PHRASE_LABEL[word] ?? (word === 'in-law' ? 'in-laws' : word);
    // Nepříjemný přívlastek udělá z věci i z blízkého nepřítele („bored teenagers“).
    const scared = dread !== null && (kind === 'thing' || kind === 'kin');
    nouns.push({ label: dread === null ? name : `${dread} ${name}`, kind: scared ? (kind === 'kin' ? 'foe' : 'dread') : kind, at, drawn: modelOf(word, true) !== undefined });
    dread = null;
  });
  return nouns;
}

/** Hrdina: podmět na začátku věty („my cat refusing“, „toaster tornado“), jinak první blízký. */
function heroOf(nouns: readonly Noun[], sentence: string): Noun | null {
  const lead = /^(?:(?:a|an|the|my|your|our)\s+)?([a-z-]+)/.exec(sentence.toLowerCase().trim())?.[1];
  const first = nouns[0];
  if (first !== undefined && lead !== undefined && singular(lead) === first.label && (first.kind === 'kin' || (first.kind === 'thing' && modelOf(first.label, true) !== undefined))) return first;
  return nouns.find((noun) => noun.kind === 'kin') ?? null;
}

/** Jmenuje popisek člověka nebo mazlíčka? Ten se neskládá ani nehraje jako věc („help my kid with homework“). */
export const isPerson = (label: string): boolean => {
  const kind = kindOf(singular(label.split(' ').at(-1)!));
  return kind === 'foe' || kind === 'kin';
};

/** Věta → role absurdního přenosu; `null`, když věta nemá ani jedno slovo, které role zná. */
export function twistOf(sentence: string): Twist | null {
  const nouns = nounsOf(sentence);
  if (nouns.length === 0) return null;
  const hero = heroOf(nouns, sentence);
  const rest = nouns.filter((noun) => noun !== hero);
  const foe = rest.filter((noun) => noun.kind === 'foe').at(-1) ?? rest.find((noun) => noun.kind === 'dread') ?? null;
  // Hrdina „argue with my wife“ je wife – ve sporu je ale soupeř, proto i hrdina.
  const person = nouns.find((noun) => noun.kind === 'foe' || noun.kind === 'kin') ?? null;
  const things = rest.filter((noun) => noun.kind === 'thing');
  const thing = things.find((noun) => noun.drawn) ?? things[0] ?? null;
  return { hero: hero?.label ?? null, foe: foe?.label ?? null, person: person?.label ?? null, thing: thing?.label ?? null };
}

/** Popisek, který věta opravdu říká – výchozí role z prostředí do cíle nejde. */
const said = (label: string | undefined, sentence: string): label is string => {
  if (label === undefined) return false;
  const text = sentence.toLowerCase();
  // Popisek fráze („support agent“) věta píše po svém („customer support line“).
  const phrase = PHRASES.find(([, token]) => PHRASE_LABEL[token] === label);
  if (phrase !== undefined) return new RegExp(phrase[0].source).test(text);
  const head = singular(label.split(' ').at(-1)!).replace(/-/g, '[- ]');
  return new RegExp(`\\b${head}(?:e?s)?\\b`).test(text);
};

/** Jmenuje popisek kulisu („kitchen table“)? Ta se nesbírá ani neskládá. */
export const isScenery = (label: string): boolean => SCENERY.has(singular(label.split(' ').at(-1)!));

/** Nepočitatelná jména: cíl je nechá v jednotném čísle („Stack the homework!“). */
const MASS = new Set(['homework', 'paperwork', 'laundry', 'cash', 'money', 'mail', 'luggage', 'sugar', 'milk', 'bread', 'coffee', 'traffic', 'silence', 'overtime', 'rent', 'debt']);

/** Množné číslo popisku do cíle; „in-laws“ už množné je. */
const many = (label: string): string => (label.endsWith('in-laws') || MASS.has(label.split(' ').at(-1)!) ? label : plural(label, 2));

type Said = { readonly thing: string | null; readonly foe: string | null; readonly rival: string | null };

/** Uzavřený anglický vzor cíle podle režimu; `null` = role, kterou vzor jmenuje, věta neříká. */
const GOALS: Readonly<Record<string, (said: Said) => string | null>> = {
  'arena.escape': ({ thing, foe }) => (foe === null ? null : thing === null ? `Dodge the ${foe}!` : `Grab the ${thing} and dodge the ${foe}!`),
  'arena.collect': ({ thing }) => (thing === null ? null : `Collect the ${thing}!`),
  'timing.stack': ({ thing }) => (thing === null ? null : `Stack the ${thing}!`),
  'rhythm.default': ({ thing }) => (thing === null ? null : `Hit the ${thing} on the beat!`),
  'duel.default': ({ rival }) => (rival === null ? null : `Out-talk the ${rival}!`),
};

/**
 * Cíl v HUD podle režimu: „Dodge the long queues!“, „Grab the phones and
 * dodge the neighbors!“, „Collect the phones!“, „Stack the bills!“, „Hit the
 * towels on the beat!“, „Out-talk the boss!“. `null`, když režim vzor nemá,
 * role, kterou vzor jmenuje, není z věty, nebo by cíl přesáhl 80 znaků.
 */
export function twistGoal(spec: GenreSpec, sentence: string): string | null {
  const rule = GOALS[`${spec.genre}.${spec.mode}`];
  if (rule === undefined) return null;
  const enemy = said(spec.enemy, sentence) ? spec.enemy : null;
  const goal = rule({ thing: said(spec.collectible, sentence) ? many(spec.collectible) : null, foe: enemy === null ? null : many(enemy), rival: enemy });
  return goal === null || goal.length > 80 ? null : goal;
}
