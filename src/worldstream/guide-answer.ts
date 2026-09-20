/**
 * **Věta průvodce — složená z cesty, ne napsaná o ní.**
 *
 * `guide.ts` rozhodl, jestli cesta existuje a jestli ji verifikátor
 * certifikoval. Tenhle modul z ní dělá větu — a jediné, co na něm záleží, je
 * **že do té věty nemůže vejít slovo, které ve světě není**.
 *
 * ## Proč se to řeší zásobou slov, a ne dobrým úmyslem
 *
 * Plynulá odpověď, která do cesty přidá jeden orientační bod navíc („projdi
 * kolem fontány a pak doleva"), se čte jako **lepší** odpověď než ta poctivá.
 * Fontána ve světě není, hráč ji hledá a nenajde, a nikdo nepozná, kde vznikla
 * ta nepravda — protože zbytek věty pravdivý je. Věta se proto skládá ze dvou
 * uzavřených zásob a z ničeho jiného:
 *
 *   `GUIDE_FRAME_WORDS`  spojovací slova, seznam v tomhle souboru
 *   jména z odpovědi     `actionId` a `target` každého kroku, `target` cesty,
 *                        a u „to tu není" **výhradně slovo tazatele**
 *
 * Uzavřenost drží `guideVocabulary()` a měří ji test: každé slovo hotové věty
 * musí být v jedné z těch dvou zásob. Nové slovo se proto do rámce **dopisuje**,
 * nikdy nevzniká uvnitř formulace.
 *
 * ## Co tenhle modul nedělá
 *
 * Nerozhoduje. Odpověď `NOT_IN_WORLD` nese jen to, na co se tazatel ptal, a
 * tenhle modul k ní nesmí přidat nejbližší existující jméno — to je přesně ten
 * výmysl, kterému se celá funkce vyhýbá (`guide.ts`).
 */

import type { GuideAnswer, NoRouteReason } from './guide';
import type { ProxyWorld } from './proxy';

/**
 * Spojovací slova věty. **Uzavřený seznam:** co v něm není, nesmí se ve větě
 * objevit, a test to soudí nad hotovým textem, ne nad touhle konstantou.
 */
export const GUIDE_FRAME_WORDS: readonly string[] = [
  'to',
  'reach',
  'then',
  'there',
  'is',
  'no',
  'in',
  'this',
  'world',
  'i',
  'can',
  'see',
  'it',
  'but',
  'ran',
  'out',
  'of',
  'search',
  'before',
  'found',
  'a',
  'the',
  'way',
  'nothing',
  'here',
  'acts',
  'on',
  'anything',
  'did',
  'not',
  'check',
  'holds',
  'up',
  'when',
  'and',
];

/** Druhá půlka věty u `NO_ROUTE`, podle toho, kde hledání skončilo. */
const NO_ROUTE_TAIL: Readonly<Record<NoRouteReason, readonly string[]>> = {
  BUDGET_EXHAUSTED: ['but', 'i', 'ran', 'out', 'of', 'search', 'before', 'i', 'found', 'a', 'way', 'there'],
  SEARCH_EXHAUSTED: ['but', 'no', 'way', 'there', 'holds', 'up', 'when', 'i', 'check', 'it'],
  WORLD_INELIGIBLE: ['but', 'nothing', 'here', 'acts', 'on', 'anything'],
  UNCERTIFIED: ['but', 'the', 'way', 'i', 'found', 'did', 'not', 'check', 'out'],
};

export interface GuideSentence {
  /** Věta tak, jak ji tazatel uvidí. */
  readonly text: string;
  /** Jména ze světa, která věta jmenuje, v pořadí výskytu. */
  readonly names: readonly string[];
  /** Co má scéna zvýraznit, v pořadí kroků cesty. Prázdné, když cesta není. */
  readonly highlight: readonly string[];
}

/** Slova, která smí ve větě k téhle odpovědi stát. Nic mimo ně. */
export function guideVocabulary(answer: GuideAnswer): readonly string[] {
  const names = answer.status === 'ROUTE'
    ? [answer.target, ...answer.ops.flatMap((op) => [op.actionId, ...(op.target === undefined ? [] : [op.target])])]
    : answer.status === 'NO_ROUTE'
      ? [answer.target]
      : [answer.asked];
  return [...GUIDE_FRAME_WORDS, ...names];
}

const stepPhrase = (actionId: string, target: string | undefined): string =>
  target === undefined ? actionId : `${actionId} ${target}`;

/** Věta z odpovědi průvodce. Skládá se, nepíše se. */
export function phraseGuideAnswer(answer: GuideAnswer): GuideSentence {
  if (answer.status === 'NOT_IN_WORLD')
    return { text: `There is no ${answer.asked} in this world.`, names: [answer.asked], highlight: [] };

  if (answer.status === 'NO_ROUTE')
    return {
      text: `I can see ${answer.target}, ${NO_ROUTE_TAIL[answer.reason].join(' ')}.`,
      names: [answer.target],
      highlight: [],
    };

  const steps = answer.ops.map((op) => stepPhrase(op.actionId, op.target));
  const targets = answer.ops.flatMap((op) => (op.target === undefined ? [] : [op.target]));
  return {
    text: `To reach ${answer.target}: ${steps.join(', then ')}.`,
    names: [answer.target, ...answer.ops.map((op) => op.actionId), ...targets],
    // Pořadí kroků, každý jednou. Zvýraznit jeden objekt dvakrát není chyba
    // scény, ale nepravda o cestě: vypadalo by to jako dvě zastávky.
    highlight: [...new Set(targets)],
  };
}

export interface RouteMarker {
  readonly stableId: string;
  /** Střed kvádru slotu ve světě — kolem něj se kreslí zvýraznění. */
  readonly at: readonly [number, number, number];
  /** Poloměr, který slot obkrouží. Nikdy nula, i u plochého objektu. */
  readonly radius: number;
  /** Kolikátá zastávka cesty to je, od jedné. */
  readonly step: number;
}

/**
 * Kam ve scéně zvýraznění patří.
 *
 * **Sloty, které svět nemá, se tiše vynechají** — cesta je vedená pravidly
 * (`sim.entities`), kdežto zvýraznit jde jen to, co má hmotu. Vyrobit značku
 * nad prázdnem by ukázalo zastávku, kde není nic vidět.
 */
export function routeMarkers(world: ProxyWorld, highlight: readonly string[]): readonly RouteMarker[] {
  if (world.kind !== 'built') return [];

  const markers: RouteMarker[] = [];
  for (const stableId of highlight) {
    const found = world.slots.find((entry) => entry.slot.stableId === stableId);
    if (found === undefined) continue;
    const { min, max } = found.slot.worldBounds;
    markers.push({
      stableId,
      at: [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2],
      radius: Math.max((max[0] - min[0]) / 2, (max[2] - min[2]) / 2, 0.35),
      step: markers.length + 1,
    });
  }
  return markers;
}

/**
 * Kde ve světě stojí sám průvodce.
 *
 * Postava musí stát **dřív, než padne první otázka** — porotce se nezeptá
 * někoho, koho nevidí. Místo se proto počítá ze světa, ne z odpovědi: střed
 * půdorysu všech slotů, posunutý k jižní hraně a na zem. Jižní proto, že tam
 * se scéna otevírá kamerou (výchozí pozice `[17, 12, 21]` ve
 * `WorldstreamCanvas`), takže postava stojí čelem k porotci a ne za zdí.
 *
 * `null` je poctivá odpověď na svět, který ještě nemá hmotu: postavit figuru
 * nad prázdno by ukázalo průvodce ve světě, který neexistuje.
 */
export function guideStand(world: ProxyWorld): readonly [number, number, number] | null {
  if (world.kind !== 'built' || world.slots.length === 0) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxZ = -Infinity;
  for (const { slot } of world.slots) {
    minX = Math.min(minX, slot.worldBounds.min[0]);
    maxX = Math.max(maxX, slot.worldBounds.max[0]);
    minY = Math.min(minY, slot.worldBounds.min[1]);
    maxZ = Math.max(maxZ, slot.worldBounds.max[2]);
  }
  // Tři čtvrtě metru dovnitř od hrany: postava patří do světa, ne vedle něj.
  return [(minX + maxX) / 2, minY, maxZ - 0.75];
}
