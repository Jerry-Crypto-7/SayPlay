/**
 * Rodiny sloves (P37A T3): slovesa se stejnou hratelnou podstatou na jednom
 * existujícím žánru a s jednou viditelnou činností hrdiny (`heroAction`).
 * Nové žánry ne – rodina jen řekne klasifikátoru, který režim sloveso hraje,
 * a návrhu, co hrdina dělá. Přehled rodin a měření: `evals/play/p37a/families.md`.
 *
 * Každý člen je vlastní sloveso tabulky `VERBS` (`classify.ts`), takže úkol
 * dostane do cíle sloveso věty („Carve all 4 pumpkins“), ne jméno rodiny.
 * Vzory chytají jen tvary slovesa: „clean towels“, „the mines“ ani „a mop“
 * sloveso nejsou.
 */

import type { HeroAction } from '../spec';
import { vocabVerb } from '../vocab';

import type { GenreId, GenreMode } from './contract';

export type FamilyId = 'clean' | 'cook' | 'chop' | 'craft' | 'garden' | 'fix' | 'paint' | 'care' | 'spray' | 'herd' | 'perform' | 'paperwork';

export interface FamilyMember {
  /** Základní tvar, vrací ho klasifikátor jako `verb`. */
  readonly verb: string;
  readonly pattern: RegExp;
  /** Činnost hrdiny, když se od rodiny liší („plants“ kope, „waters“ zalévá). */
  readonly heroAction?: HeroAction;
}

export interface VerbFamily {
  readonly id: FamilyId;
  /** Režim, který rodina hraje. */
  readonly pick: { readonly genre: GenreId; readonly mode: GenreMode };
  readonly heroAction: HeroAction;
  /** Kterou roli dostane předmět slovesa: sbíranou věc (úklid), cíl úkolu, nebo žádnou (rytmus, střelba a skládání mají vlastní). */
  readonly object: 'collectible' | 'target' | 'none';
  readonly members: readonly FamilyMember[];
}

const OWNER = String.raw`(?:the|a|an|all|every|some|his|her|their|my|your|its)\b`;
const m = (verb: string, pattern: RegExp, heroAction?: HeroAction): FamilyMember => ({ verb, pattern, ...(heroAction === undefined ? {} : { heroAction }) });

export const FAMILIES: readonly VerbFamily[] = [
  {
    // Úklid: sběr pod časem v Aréně – co se uklízí, jsou sbírané věci („rakes autumn leaves“, „vacuums crumbs“).
    id: 'clean',
    pick: { genre: 'arena', mode: 'collect' },
    heroAction: 'sweep',
    object: 'collectible',
    members: [
      m('scrub', /\bscrub(?:s|bing|bed)?\b/),
      m('polish', new RegExp(String.raw`\bpolish(?:es|ing|ed)\b|\bpolish ${OWNER}`)),
      m('mop', new RegExp(String.raw`\bmop(?:s|ping|ped)\b|\bmop (?:up )?${OWNER}`)),
      m('vacuum', new RegExp(String.raw`\bvacuum(?:s|ing|ed)\b|\bvacuum (?:up )?${OWNER}`)),
      // „a washing machine“ a „a car wash“ jsou věci.
      m('wash', /(?<!car )\bwash(?:es|ing|ed)?\b(?! (?:up on|ashore|away|out|machines?)\b)/),
      m('tidy', new RegExp(String.raw`\btid(?:ies|ying|ied)\b|\btidy (?:up\b|${OWNER})`)),
      m('rake', new RegExp(String.raw`\brak(?:es|ing|ed)\b|\brake (?:up\b|leaves\b|${OWNER})`)),
      // „drones sweep the area“ hlídkuje, neuklízí: zametá se jen to, co se uklízí.
      m('sweep', new RegExp(String.raw`\b(?:sweep(?:s|ing)?|swept) (?:up\b|away\b|(?:${OWNER} )?(?:[a-z]+ )?(?:floors?|dust|leaves|snow|dirt|crumbs|chimneys?|rooms?|kitchens?|halls?|decks?|streets?|porch|paths?|yards?|stairs|steps|garages?|attics?|barns?|stables?|ashes|sand|cobwebs|mess|trash|litter)\b)`)),
      m('wipe', /\bwip(?:e|es|ing|ed)\b/),
      m('shovel', new RegExp(String.raw`\bshovel(?:s|ing|ed|led|ling)\b|\bshovel (?:snow|dirt|sand|${OWNER})`)),
      m('clean', new RegExp(String.raw`\bclean(?:s|ing|ed)? (?:up|out|off)\b|\bclean(?:s|ing)? ${OWNER}`)),
    ],
  },
  {
    // Vaření: stanice, předmět mění stav pod časem („stirs a pot of fish soup“, „bakes bread“).
    id: 'cook',
    pick: { genre: 'quest', mode: 'station' },
    heroAction: 'stir',
    object: 'target',
    members: [
      m('cook', /\b(?:cook(?:s|ing)?|bak(?:e|es|ing)|grill(?:s|ing)?|brew(?:s|ing)?)\b|\bflip(?:s|ping)? (?:the |a |an |some )?(?:[a-z]+ )?(?:pancakes?|burgers?|patt(?:y|ies)|eggs?|crepes?)\b/),
      m('stir', /\bstir(?:s|ring|red)?\b/),
      m('whisk', /\bwhisk(?:s|ing|ed)?\b/),
      m('knead', /\bknead(?:s|ing|ed)?\b/),
      m('frost', /\bfrosts\b|\bfrost(?:ing|ed)? (?:the|a|an|some|\d+|cakes?|cupcakes?|cookies?)\b/),
      m('simmer', /\bsimmer(?:s|ing|ed)?\b/),
      m('fry', /\bfr(?:y|ying|ied)\b/),
      m('roast', /\broast(?:s|ing|ed)?\b/),
      m('pour', /\bpour(?:s|ing|ed)?\b(?! (?:down|in from))/),
      m('meal prep', /\bmeal[ -]?prep(?:s|ping)?\b/),
      // „make coffee“, „wizzard makin potions“: vaření i s překlepem; jiné „make“ zůstává obecnou stanicí.
      // Předmět jen pohledem dopředu: za slovesem ho čte návrh jako cíl stanice. Stejně u dalších vzorů, které předmět jmenují.
      m('cook', /\bmak(?:e|es|ing|in)'?(?= (?:a |an |the |some |\d+ )?(?:[a-z]+ )?(?:potions?|coffee|tea|soup|stew|pancakes?|pizzas?|cakes?|cookies|breakfast|dinner|lunch|smoothies?|lemonade)\b)/),
      // Alchymie: „transforms frogs into gold coins“; „transforms into a car“ je proměna hrdiny, ne vaření.
      m('transform', /\btransform(?:s|ing)? (?!into\b)|\btransmut(?:e|es|ing)\b/),
    ],
  },
  {
    // Sekání a řezání: úkol v prostoru, ke každému předmětu dojít a opracovat ho („chops logs“, „shears fluffy sheep“).
    id: 'chop',
    pick: { genre: 'quest', mode: 'spatial' },
    heroAction: 'chop',
    object: 'target',
    members: [
      m('chop', /\bchop(?:s|ping|ped)?\b/),
      m('carve', /\bcarv(?:e|es|ing|ed)\b/),
      m('sculpt', /\bsculpt(?:s|ing|ed)?\b/),
      m('whittle', /\bwhittl(?:e|es|ing|ed)\b/),
      m('shear', /\bshear(?:s|ing|ed)?\b/),
      m('gnaw', /\bgnaw(?:s|ing|ed)?\b/),
      m('mine', /\bmining\b|\bmines? (?:for|through|into|gold|diamonds?|coal|ore|crystals?|gems?|iron|silver)\b/),
      // „prunes hedges“ (P37A T4): stříhání je sekání po zahradě.
      m('prune', /\bprun(?:e|es|ing)\b|\btrim(?:s|ming)? (?:the |a |an |some )?(?:[a-z]+ )?(?:hedges?|bushes|trees?)\b/),
    ],
  },
  // P37A T4: zbylé rodiny z `evals/play/p37a/families.md`.
  {
    // Řemeslo: steh, sklad a sklad v rytmu („knits a giant scarf“, „folds paper cranes“).
    id: 'craft',
    pick: { genre: 'rhythm', mode: 'default' },
    heroAction: 'knit',
    object: 'none',
    members: [
      m('knit', /\bknit(?:s|ting|ted)?\b/),
      m('sew', /\bsew(?:s|ing|ed|n)?\b/),
      m('stitch', /\bstitch(?:es|ing|ed)?\b/),
      m('crochet', /\bcrochet(?:s|ing|ed)?\b/),
      // „weaves through traffic“ je pohyb, ne řemeslo.
      m('weave', /\bweav(?:e|es|ing)\b(?! (?:through|between|in and out|around|past)\b)/),
      // „irons shirts“; železo („an iron sword“) sloveso není.
      m('iron', new RegExp(String.raw`\birons\b|\bironing\b|\biron ${OWNER}`)),
      // Jen tvar slovesa s předmětem: „back into the fold“, „a folding chair“, „a chicken wrap“ ani „wrap up the day“ řemeslo nejsou.
      m('fold', new RegExp(String.raw`\bfold(?:s|ing|ed)? (?:${OWNER}|paper\b|towels?\b|laundry\b|clothes\b|origami\b)`)),
      m('wrap', new RegExp(String.raw`\bwrap(?:s|ping|ped)? (?:${OWNER}|presents?\b|gifts?\b|boxes\b|mummies\b)`)),
    ],
  },
  {
    // Zahrada: ke každému záhonu dojít a zalít nebo zasadit („waters thirsty sunflowers“, „plants acorns“).
    id: 'garden',
    pick: { genre: 'quest', mode: 'spatial' },
    heroAction: 'water',
    object: 'target',
    members: [
      // Voda jako podstatné jméno („into the water“, „deep waters“) sloveso není.
      m('water', /\bwater(?:s|ing|ed)?(?= (?:the|a|an|all|every|each|some|his|her|their|my|thirsty|dry|wilting|plants|flowers|crops|trees|roses|seedlings)\b)/),
      m('plant', /\bplant(?:s|ing|ed)?(?= (?:the|a|an|all|every|each|some|his|her|their|my|\d+|seeds?|trees?|flowers?|acorns?|bulbs?|crops?|saplings?|carrots?|potatoes?|tulips?|roses?)\b)/, 'dig'),
      // „to reach its burrow“ je nora, ne kopání.
      m('dig', /\bdig(?:s|ging)?\b|\bdug\b|\bburrow(?:s|ing|ed)? (?:under|into|through|beneath|deep|down)\b|\bbur(?:y|ies|ying)\b/, 'dig'),
    ],
  },
  {
    // Opravy: rozbitá věc je stanice, úder po úderu se spraví („hammers glowing swords“, „welds cracks in a hull“).
    id: 'fix',
    pick: { genre: 'quest', mode: 'station' },
    heroAction: 'fix',
    object: 'target',
    members: [
      // Dřív samostatné sloveso tabulky `VERBS` (týž vzor i režim), teď s činností hrdiny.
      m('repair', /\b(?:repair(?:s|ing)?|fix(?:es|ing)?|mend(?:s|ing)?)\b/),
      m('hammer', /\bhammer(?:s|ing|ed)\b|\bhammer(?= (?:the|a|an|some|nails?|in)\b)/),
      m('weld', /\bweld(?:s|ing|ed)?\b/),
      m('patch', /\bpatch(?:es|ing)?(?: up)?(?= (?:the |a |an |some )?(?:[a-z]+ )?(?:holes?|cracks?|leaks?|roofs?|tires?|tyres?)\b)/),
      m('change', /\bchang(?:e|es|ing)(?= (?:a |the |my |his |her |their )?(?:flat )?(?:tires?|tyres?|wheels?)\b)/),
    ],
  },
  {
    // Malování: plochy po scéně jako cíle („paints a mural on a train“).
    id: 'paint',
    pick: { genre: 'quest', mode: 'spatial' },
    heroAction: 'paint',
    object: 'target',
    // „covered in paint“, „a paint bucket“ ani „stealing a painting from“ malování nejsou.
    members: [m('paint', new RegExp(String.raw`\bpaint(?:s|ing|ed)? (?:${OWNER}|murals?\b|walls?\b|pictures?\b|portraits?\b|fences?\b|eggs?\b)|\bspray[ -]paint(?:s|ing|ed)?\b|\bgraffiti\b`))],
  },
  {
    // Péče: k tvorovi donést, co potřebuje („grooms a muddy poodle“, „bandages injured puppies“).
    id: 'care',
    pick: { genre: 'quest', mode: 'station' },
    heroAction: 'carry',
    object: 'target',
    members: [
      // „the bride and groom“ je ženich, ne péče.
      m('groom', /\bgroom(?:s|ing|ed)? (?:a|an|the|his|her|their|my|some|\d+)\b/),
      m('bandage', /\bbandag(?:e|es|ing|ed)\b/),
      m('bathe', /\bbath(?:e|es|ing|ed) (?:a|an|the|his|her|their|my|some|\d+)\b/),
      m('nurse', /\bnurs(?:e|es|ing) (?:a|an|the|his|her|their|my|some|back|sick|injured|wounded)\b/),
    ],
  },
  {
    // Hašení a stříkání: mířit proudem na cíle („sprays a garden hose at angry wasps“). „spray water“ na oheň hraje sloveso `extinguish`.
    id: 'spray',
    pick: { genre: 'shooter', mode: 'default' },
    heroAction: 'spray',
    object: 'none',
    members: [
      // „dodging sea spray“ je mlha, ne stříkání.
      m('spray', new RegExp(String.raw`\bspray(?:s|ing|ed)? (?!paint)(?:${OWNER}|at\b|on\b|down\b|water\b|foam\b)`)),
      m('squirt', /\bsquirt(?:s|ing|ed)?\b/),
      m('hose', /\bhos(?:e|es|ing) (?:at|off)\b/),
    ],
  },
  {
    // Pastevectví: zvířata nahnat jako sbírané věci („herds sheep into a pen“, „lassos wild chickens“).
    id: 'herd',
    pick: { genre: 'arena', mode: 'collect' },
    heroAction: 'throw',
    object: 'collectible',
    members: [
      // „a herd of cows“ je stádo, ne sloveso.
      m('herd', new RegExp(String.raw`\bherd(?:s|ing|ed)\b|\bherd ${OWNER}`)),
      m('lasso', /\blasso(?:s|es|ing|ed)?\b/),
      // „a fishing lure“ je návnada.
      m('lure', /\blur(?:es|ing|ed)\b|\blure (?:the|a|an|his|her|their|them|it)\b/),
      m('round up', /\bround(?:s|ing)? up\b/),
      m('wrangle', /\bwrangl(?:e|es|ing|ed)\b/),
    ],
  },
  {
    // Vystoupení: ťuk v rytmu před publikem („juggles flaming torches“, „conducts an orchestra“). Činnost má jen žonglování.
    id: 'perform',
    pick: { genre: 'rhythm', mode: 'default' },
    heroAction: 'none',
    object: 'none',
    members: [
      m('juggle', /\bjuggl(?:e|es|ing|ed)\b/, 'throw'),
      // „blows a whistle“ a „oil drums“ jsou věci.
      m('whistle', /\bwhistl(?:es|ing|ed)\b|\bwhistle (?:to|at|for)\b/),
      m('conduct', /\bconduct(?:s|ing|ed)? (?:a|an|the|his|her|their)\b/),
      m('drum', /\bdrumm(?:ing|ed)\b|\bdrums (?:on|along|to)\b/),
      // „present the quarterly budget“; dárky („wraps presents on a belt“) sloveso nejsou.
      m('present', new RegExp(String.raw`\bpresent(?:s|ing)? ${OWNER}`)),
    ],
  },
  {
    // Papíry (věty mimo hry): list po listu na stoh („file my expense report“, „sign the mortgage papers“).
    id: 'paperwork',
    pick: { genre: 'timing', mode: 'stack' },
    heroAction: 'stack',
    object: 'none',
    members: [
      m('file', new RegExp(String.raw`\bfil(?:e|es|ing) ${OWNER}`)),
      m('sign', new RegExp(String.raw`\bsign(?:s|ing)? (?:${OWNER}|\d+)`)),
      m('renew', /\brenew(?:s|ing)?\b/),
      m('pay', new RegExp(String.raw`\bpa(?:y|ys|ying|id) (?:${OWNER}|off\b|rent\b|bills?\b|taxes\b)`)),
      m('write', new RegExp(String.raw`\bwrit(?:e|es|ing) (?:${OWNER}|\d+)`)),
      // „do my math homwork“ i s překlepem.
      m('do', /\bdo(?:es|ing)? (?:my|his|her|their|the|your|our) (?:[a-z]+ )?(?:home?work|homwork|taxes|paperwork)\b/),
      m('answer', /\banswer(?:s|ing)? (?:the |all |\d+ )?(?:[a-z]+ )?(?:emails?|letters?|messages?)\b/),
      m('help', /\bhelp(?:s|ing)? (?:[a-z']+ ){1,3}with (?:[a-z]+ )?(?:home?work|taxes|paperwork)\b/),
    ],
  },
];

const BY_VERB: ReadonlyMap<string, VerbFamily> = new Map(FAMILIES.flatMap((family) => family.members.map((member) => [member.verb, family] as const)));
const MEMBER: ReadonlyMap<string, FamilyMember> = new Map(FAMILIES.flatMap((family) => family.members.map((member) => [member.verb, member] as const)));

/** Rodina hlavního slovesa věty (`GenreRanking.verb`), `null` mimo rodiny. */
export function familyOf(verb: string | null): VerbFamily | null {
  return verb === null ? null : (BY_VERB.get(verb) ?? null);
}

/** Činnost hrdiny pro hlavní sloveso: vlastní u členu, jinak rodiny, mimo rodiny póza z tabulky P44C; jinak `null`. */
export function heroActionOf(verb: string | null): HeroAction | null {
  if (verb === null) return null;
  const family = familyOf(verb);
  return family === null ? (vocabVerb(verb)?.hero ?? null) : (MEMBER.get(verb)?.heroAction ?? family.heroAction);
}
