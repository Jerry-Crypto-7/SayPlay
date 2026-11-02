/**
 * Žánr Směna se stavbou obchodu (P68, kategorie `stavba`): hráč z omezeného rozpočtu mincí postaví na mřížce obchodu
 * pece, pulty a police, otevře a posílá prodavače mezi nimi; zákazníci z věty přicházejí dveřmi a chtějí zboží z věty.
 * Cíl = obsloužit tolik zákazníků, kolik věta řekne (`customers` 9–20, výchozí 12). Vstup `lanes` (ťuk s buňkou v ose),
 * pohled shora (`top`); ovládání `buildshift`, generátor `buildshift_shop` v `arcade/pieces/buildshift.ts`.
 *
 * **Z věty:** zákazník = kdo přichází („robots line up“, „serve 12 cats“), zboží = co chtějí („for pizza“, „their milk“;
 * zboží v názvu obchodu – „ice cream parlour“ – jen když jiné není), počet = cíl v mezích (`serve 3 of them` → 9); číslo u směny nebo času („for one shift“, „two hours“) počet není.
 * Majitel („a raccoon runs a donut shop“) je hrdina, obchod je místo.
 *
 * Do kostry P68-I T1 patří brána aktivace: dokud úloha „zapoj buildshift“ žánr nevyjme z `ROUTE_PENDING`
 * a `DIRECTOR_PENDING`, klasifikátor ani režisér ho nevidí – hraje jen ruční spec (`e2e/fixtures/p68-buildshift-spec.json`).
 */

import { BUILDSHIFT } from '../arcade/pieces/buildshift-world';
import { NUMBER_WORDS, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, titleCase } from './contract';

/** Výchozí obsazení, když ho věta nejmenuje: roboti chtějí pizzu. */
export const BUILDSHIFT_DEFAULTS = { customer: 'robot', goods: 'pizza' } as const;

/** Zboží obchodu: popisek → tvary ve větě. Víceslovné první, ať „hot dogs“ nevyhraje „dogs“. */
const GOODS: readonly (readonly [string, string])[] = [
  ['ice cream', 'ice ?creams?'],
  ['hot dog', 'hot ?dogs?'],
  ['milkshake', 'milk ?shakes?'],
  ['bubble tea', 'bubble ?teas?'],
  ['noodles', 'noodles?'],
  ['pizza', 'pizzas?'],
  ['milk', 'milk'],
  ['bread', 'breads?'],
  ['taco', 'tacos?'],
  ['burger', '(?:ham)?burgers?'],
  ['lemonade', 'lemonades?'],
  ['donut', '(?:donuts?|doughnuts?)'],
  ['sushi', 'sushi'],
  ['coffee', 'coffees?'],
  ['candy', 'cand(?:y|ies)'],
  ['cupcake', 'cupcakes?'],
  ['juice', 'juices?'],
  ['fish', 'fish'],
  ['tea', 'teas?'],
  ['pie', 'pies?'],
  ['lunch', 'lunch(?:es)?'],
  ['cake', 'cakes?'],
  ['cookie', 'cookies?'],
  ['soup', 'soups?'],
  ['salad', 'salads?'],
  ['sandwich', 'sandwich(?:es)?'],
  ['fries', 'fries'],
  ['pancake', 'pancakes?'],
  ['waffle', 'waffles?'],
  ['smoothie', 'smoothies?'],
  ['popcorn', 'popcorn'],
  ['pasta', 'pasta'],
  ['ramen', 'ramen'],
  ['latte', 'lattes?'],
  ['croissant', 'croissants?'],
  ['muffin', 'muffins?'],
  ['bagel', 'bagels?'],
  ['dumpling', 'dumplings?'],
  ['burrito', 'burritos?'],
  ['pretzel', 'pretzels?'],
  ['cocoa', 'cocoa'],
  ['honey', 'honey'],
  ['cheese', 'cheese'],
  ['chocolate', 'chocolates?'],
  ['steak', 'steaks?'],
  ['apple', 'apples?'],
  ['banana', 'bananas?'],
  ['carrot', 'carrots?'],
];

const GOODS_PATTERNS = GOODS.map(([label, form]) => [label, new RegExp(`\\b${form}\\b`, 'g')] as const);

/** Podstatná jména obchodu: zboží těsně před nimi je název obchodu („burger joint“), ne objednávka. */
const PLACE = 'shop|stand|bar|truck|joint|bakery|store|room|cafe|café|parlou?r|diner|restaurant|canteen|cart|stall|kiosk|van|booth|hut|shack|kitchen|cafeteria|bistro|pizzeria|deli';
const PLACE_AFTER = new RegExp(`^\\s+(?:${PLACE})\\b`);
/** Obchod jako místo hry: nejvýš dvě slova před podstatným jménem obchodu. */
const SHOP = new RegExp(`\\b((?:[a-z']+\\s+){0,2}(?:${PLACE}))\\b`);

/** Přívlastky a určovací slova, která k zákazníkovi nepatří („15 sweaty tourists“ → tourist). */
const NOT_NOUN = new Set(
  'a an the my our your their his her its these those some many lots of more few several dozens hundreds all every hungry thirsty sweaty picky greedy sleepy noisy busy tired happy angry little tiny big cute grumpy impatient cranky fancy rich old young spooky crazy silly lazy fussy polite rude loud shy small giant huge starving famished excited eager friendly hairy sad cold wet fluffy lonely weird strange new'.split(
    ' ',
  ),
);
/** Slova, na kterých jméno zákazníka za číslem končí („16 office workers want…“). */
const STOP = new Set('their his her its at in on before after to for with who that and or during while want wants wanting come comes line lines queue queues order orders by from of every each per a an the'.split(' '));
/** Slovesa příchodu: podmět před nimi je zákazník („robots line up for“, „hungry dragons come for“). */
const ARRIVE =
  /\b(?:lines?|lining|queues?|queu(?:e)?ing|comes?|coming|orders?|ordering|wants?|wanting|drops?|crowds?|crowding|waits?|waiting|visits?|flocks?|rush(?:es)?|pops?|stops?|arrives?|begs?|needs?|craves?|shows?|swarms?|storms?|streams?)\b/;
/** Hranice věty: podmět slovesa příchodu je až za ní („… a donut shop and sleepy police dogs come“). */
const CLAUSE = /,|\band\b|\bwhere\b|\bwhile\b|\bthat\b|\bwho\b|\bwhen\b|\bbut\b/;
/** Majitel obchodu („a raccoon runs a donut shop“) – hrdina. */
const OWNER = /\b(?:a|an|the|my)\s+(?:[a-z]+\s+)?([a-z]+)\s+(?:runs|opens|owns|manages|works at|bakes|cooks)\b/;

const NUMBER = new RegExp(`\\b(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})\\s+`, 'g');

/** Zboží věty: první výskyt, který není názvem obchodu; jinak název obchodu („cat cafe“ bez zboží nic). */
export function goodsOf(sentence: string): string | null {
  const text = sentence.toLowerCase();
  const found: { readonly label: string; readonly at: number; readonly end: number; readonly place: boolean }[] = [];
  for (const [label, pattern] of GOODS_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const end = match.index + match[0].length;
      found.push({ label, at: match.index, end, place: PLACE_AFTER.test(text.slice(end)) });
    }
  }
  // Na stejném místě vyhraje delší tvar („milk shakes“ před „milk“).
  found.sort((a, b) => Number(a.place) - Number(b.place) || a.at - b.at || b.end - a.end);
  return found[0]?.label ?? null;
}

const isGoods = (word: string): boolean => GOODS_PATTERNS.some(([, pattern]) => new RegExp(`^${pattern.source}$`).test(word));

/** Jméno zákazníka ze slov: bez přívlastků na začátku, jen podstatná jména, jednotné číslo. */
function customerOfWords(words: readonly string[]): string | null {
  let start = 0;
  while (start < words.length && NOT_NOUN.has(words[start] as string)) start += 1;
  const noun = words.slice(start).filter((word) => /^[a-z][a-z'-]*$/.test(word));
  if (noun.length === 0 || noun.some((word) => isGoods(word) || NOT_NOUN.has(word))) return null;
  return singular(noun.join(' '));
}

/** Jednotka času za číslem: „for one shift“, „two hours“ počítají čas, ne zákazníky (dev d25, P68-K T2). */
const TIME_UNIT = /^(?:shifts?|days?|nights?|hours?|minutes?|seconds?|mornings?|evenings?|afternoons?|weeks?|months?|years?|rounds?|turns?)\b/;

/** Počet a zákazník za číslem („serve 12 cats“, „16 office workers want“); „serve 9 of them“ = jen počet. */
function countedOf(text: string): { readonly count: number; readonly customer: string | null } | null {
  NUMBER.lastIndex = 0;
  for (let match = NUMBER.exec(text); match !== null; match = NUMBER.exec(text)) {
    const raw = match[1] as string;
    const count = /^\d+$/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw] as number);
    if (TIME_UNIT.test(text.slice(match.index + match[0].length))) continue;
    const words: string[] = [];
    for (const word of text.slice(match.index + match[0].length).split(/[\s,.!?;]+/)) {
      if (word === '' || STOP.has(word) || isGoods(word) || words.length === 3) break;
      words.push(word);
    }
    if (words.length === 0) return { count, customer: null };
    return { count, customer: customerOfWords(words) };
  }
  return null;
}

/** Podmět slovesa příchodu v jeho klauzi („where hungry dragons come for bread“ → dragon). */
function arrivingOf(text: string): string | null {
  const verb = ARRIVE.exec(text);
  if (verb === null) return null;
  const clause = text.slice(0, verb.index).split(CLAUSE).at(-1) ?? '';
  const words = clause.trim().split(/\s+/).filter((word) => word !== '');
  return words.length === 0 ? null : customerOfWords(words.slice(-3));
}

/**
 * Nejmenší cíl, který dostane věta nebo spec (P68-K T2). Generátor bere 6–20, ale při cíli 6–8 vyhrálo i špatné
 * rozvržení (pec v nejvzdálenějším rohu) na všech 12 semínkách, i se 2 životy – malý cíl nešel prohrát. Od 9 prohraje
 * vždy; cíle ≥ 9 se nemění.
 */
export const SHIFT_GOAL_MIN = 9;

/** Cíl v mezích žánru. */
const goalOf = (count: number): number => Math.min(BUILDSHIFT.goal.max, Math.max(SHIFT_GOAL_MIN, count));

/** Co věta o směně říká bez AI: zákazník, zboží, cíl, majitel a obchod. Chybějící = `null`. */
export function readShift(sentence: string): { readonly customer: string | null; readonly goods: string | null; readonly goal: number | null; readonly owner: string | null; readonly shop: string | null } {
  const text = sentence.toLowerCase().replace(/[“”"]/g, '');
  const counted = countedOf(text);
  const customer = counted?.customer ?? arrivingOf(text);
  const owner = OWNER.exec(text)?.[1] ?? null;
  const shop = SHOP.exec(text)?.[1]?.split(/\s+/).filter((word) => !NOT_NOUN.has(word) || word === 'little' || word === 'tiny').join(' ') ?? null;
  return { customer, goods: goodsOf(text), goal: counted === null ? null : goalOf(counted.count), owner: owner !== null && owner !== customer ? owner : null, shop: shop === '' ? null : shop };
}

/** První text, který se vejde do meze schématu. */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const buildshiftGenre: GenreModule<'buildshift'> = {
  id: 'buildshift',
  modes: ['default'],
  // Jen slova obchodu a obsluhy; žádné, které vlastní jiný žánr. P68-I T11 zúžil (stráž žánru, `integration-log.md`):
  // `shop` slyší „shopping“, `cafe`/`café`/`restaurant` vyhrály věty bez slovesa („a cat naps in a rainy café“),
  // `run a` slyší „run a marathon“; obchod a jeho stavbu nese znak žánru `serve` v `classify.ts`.
  cues: ['diner', 'serve', 'customers'],
  heroClasses: ['humanoid', 'animal', 'robot'],
  paramBounds: { customers: { min: SHIFT_GOAL_MIN, max: BUILDSHIFT.goal.max } },
  // `ready` až zapojením v P68-I T11 („zapoj buildshift“, `evals/play/p68/stavba/integration.md` → Zapnutí); brány
  // hry 1. 11. ani 2. 11. neprošly (`evals/play/p68/integration-log.md`), proto zatím `staged`.
  availability: () => 'staged',
  compile: (spec) => {
    const goal = spec.params?.customers ?? BUILDSHIFT.goal.default;
    const customer = castFor(spec, 'collect', 'chase_me', 'reach', 'fight', 'shoot_at', 'avoid', 'throw_at')?.label ?? BUILDSHIFT_DEFAULTS.customer;
    const goods = spec.cast?.find((item) => item.does === 'scenery')?.label ?? BUILDSHIFT_DEFAULTS.goods;
    const one = singular(customer);
    const many = plural(one, goal);
    return legacySpec(spec, {
      control: 'buildshift',
      controlParams: { generator: 'buildshift_shop', ...(goal === BUILDSHIFT.goal.default ? {} : { tuning: { goal } }) },
      archetype: 'collect_exit',
      title: fit(60, `${titleCase(goods)} Shift`, 'Shop Shift'),
      objective: {
        kind: 'collect',
        description: fit(120, `Build your shop, open it and serve ${String(goal)} ${many} their ${goods} before the shift ends.`, `Build your shop and serve ${String(goal)} ${many}.`),
        count: goal,
        role: 'customer',
      },
      // Životy = kolik zákazníků smí odejít bez obsluhy.
      mechanics: [{ id: 'health', params: { max: BUILDSHIFT.walkouts } }],
      roles: [
        { id: 'customer', kind: 'collectible', label: one, count: goal },
        { id: 'goods', kind: 'item', label: goods },
      ],
      tutorial: {
        goalLine: fit(80, `Serve ${String(goal)} ${many} their ${goods}!`, `Serve ${String(goal)} ${many}!`),
        controlsHint: 'Pick a station, tap a tile to build, tap Open. Then oven, counter!',
      },
      mood: 'playful',
      targetDurationSec: 75,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    const read = readShift(sentence);
    const customer = read.customer ?? castFor({ cast }, 'collect', 'chase_me', 'reach', 'fight', 'shoot_at', 'avoid')?.label ?? null;
    const goods = read.goods;
    const roles: CastItem[] = [...(customer === null ? [] : [{ label: customer, does: 'collect' as const }]), ...(goods === null ? [] : [{ label: goods, does: 'scenery' as const }])];
    const owner = read.owner ?? (hero !== undefined && hero !== customer && hero !== goods ? hero : undefined);
    const place = read.shop ?? setting;
    return {
      genre: 'buildshift',
      mode: 'default',
      ...(owner === undefined ? {} : { hero: owner }),
      ...(place === undefined || place === null ? {} : { setting: place }),
      ...(roles.length === 0 ? {} : { cast: roles }),
      ...(read.goal === null ? {} : { params: { customers: read.goal } }),
    };
  },
};
