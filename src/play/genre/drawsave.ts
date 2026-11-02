/**
 * Žánr Kresli a zachraň (P68, kategorie `stavba`, volitelný): hráč tahem prstu nakreslí čáry (posloupnost buněk
 * mřížky v ose s `HOLD` po dobu tahu, `DRAWSAVE_STROKE` v `p68-contract.ts`), hrozby z věty padají shora a odrážejí
 * se od nich a chráněná postava z věty musí 10 s přežít; pohled z boku (`side`) (ovládání `drawsave`, vlastní
 * dotykový adaptér `genres/drawsave/DrawsaveTouch.tsx`, generátor `drawsave_level` v `arcade/pieces/drawsave.ts`).
 *
 * **Z věty:** chráněná postava = hrdina (předmět „save / protect / shield / keep … safe“, jinak podmět „X is in
 * danger“, „X needs a shield“, „so X survives“), hrozba = co padá („falling rocks“, „a rain of meteors“, „from the
 * asteroid shower“, „bees are attacking“), počet hrozeb = číslo před hrozbou v mezích 1–30 (výchozí 10).
 *
 * Doba obrany je v jádře pevná (`DRAWSAVE.surviveTicks`, 10 s) a generátor bere jen `threats` – parametr doby modul
 * nemá, dokud ho generátor nepřijme.
 *
 * Brána aktivace: dokud úloha „zapoj drawsave“ (P68-I) žánr nevyjme z `ROUTE_PENDING` a `DIRECTOR_PENDING`,
 * klasifikátor ani režisér ho nevidí – hraje jen ruční spec (`e2e/fixtures/p68-drawsave-spec.json`).
 */

import { ARCADE_HZ } from '../arcade/contract';
import { DRAWSAVE } from '../arcade/pieces/drawsave-world';
import { NUMBER_WORDS, nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastRole, type GenreModule, castFor, draftRoles, legacySpec, titleCase } from './contract';

/** Výchozí hrozba, když ji věta nejmenuje (slovo, které `DEFAULT_LABELS` má). */
export const DRAWSAVE_DEFAULTS = { threat: 'bomb' } as const;

/** Sekundy obrany, které jádro hraje. */
export const DRAWSAVE_SECONDS = DRAWSAVE.surviveTicks / ARCADE_HZ;

/** Role obsazení, kterou hra hraje jako padající hrozbu: všechno, co postavě škodí. */
const THREAT_DOES: readonly CastRole[] = ['avoid', 'chase_me', 'shoot_at', 'fight', 'throw_at'];

/** Sloveso ochrany a jeho předmět („save the puppy“, „keep the robot safe“). */
const KEEP = /\b(?:sav|protect|shield|guard|defend|rescu|cover|shelter|keep|help)(?:e|es|s|ed|ing)?\s+([a-z][a-z' -]*)/g;
/** Podmět, který je v ohrožení („a baby penguin is in danger“, „the king needs a shield“, „so the chick survives“). */
const AT_RISK = /\b(?:is|are|needs?|survives?|stays?|sits?|sleeps?|naps?|lives?)\b/;
/** Hranice klauze: podmět ohrožení je až za ní. */
const CLAUSE = /,|\band\b|\bso\b|\bwhile\b|\bthat\b|\bwho\b|\bwhen\b|\bbut\b|\bto\b|\bbefore\b|\buntil\b/;
/** Místo z `draftRoles`, které místem není („a penguin is in danger“). */
const NOT_PLACE = /^(?:danger|trouble|peril|need)$/;
/** Slova, která za slovesem ochrany postava nejsou (zájmena, kresba, slovesa). */
const NOT_KEPT = /^(?:it|him|her|them|me|you|us|yourself|everyone|everybody|line|lines|wall|walls|roof|roofs|shield|shields|safe|drawing|draw|from|against|on|up|out)\b/;
/** Přívlastky před postavou („the little chick“ → chick); poslední slovo zůstane vždy. */
const ADJECTIVES = new Set(
  'a an the my our your their his her its this that poor little tiny small baby cute sleepy sleeping brave precious helpless lonely lost scared frightened old young big giant fluffy sweet innocent defenceless defenseless newborn sick tired happy sad cuddly adorable fragile'.split(' '),
);
/** Za postavou, kde jméno končí: „keep the robot safe“, „help the hamster survive a…“. */
const AFTER_KEPT = new Set(['safe', 'alive', 'dry', 'unharmed', 'protected', 'sound', 'survive', 'stay', 'live', 'get', 'escape', 'a', 'an', 'the']);

/** Pohyb hrozby před ní („falling rocks“) a po ní („bees are attacking“). */
const FALLING = /\b(?:falling|dropping|tumbling|plummeting|raining|crashing|rolling|bouncing|hurtling|incoming|flying|exploding|flaming)\s+([a-z][a-z -]*)/;
const FALLS = /\b(?:fall|falls|falling|rain|rains|raining|drop|drops|dropping|attack|attacks|attacking|crash|crashes|crashing|tumble|tumbles|tumbling|come|comes|coming)\b/;
/** Hromadné slovo: hrozba je to, z čeho je („a rain of meteors“, „an asteroid shower“). */
const HEAP = 'rain|shower|storm|hail|barrage|avalanche|swarm|wave|waves|cloud|flood|pile|downpour|attack|attacks';
const HEAP_OF = new RegExp(`\\b(?:${HEAP})\\s+of\\s+([a-z][a-z -]*)`);
const HEAP_BEFORE = new RegExp(`\\b([a-z]+)\\s+(?:${HEAP})\\b(?!\\s+of\\b)`);
const HEAP_AFTER = new RegExp(`\\s+(?:${HEAP})$`);
const HEAP_ONLY = new RegExp(`^(?:${HEAP})$`);
/** Slova před hromadným slovem, která hrozbou nejsou („a storm“, „heavy rain“). */
const NOT_THREAT = new Set('a an the this that some big huge giant heavy massive deadly sudden endless whole wild'.split(' '));
/** Odkud hrozba přichází („from falling rocks“, „against the arrows“). */
const FROM = /\b(?:from|against)\s+([a-z][a-z -]*)/;

const NUMBER = new RegExp(`\\b(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})\\s+`, 'g');

/** Jméno ze slov: bez přívlastků na začátku (poslední slovo zůstane) a bez „safe“ za ním. */
function nameOf(phrase: string | null): string | null {
  if (phrase === null) return null;
  const words = phrase.split(' ');
  const end = words.findIndex((word) => AFTER_KEPT.has(word));
  const kept = end < 0 ? words : words.slice(0, end);
  let start = 0;
  while (start < kept.length - 1 && ADJECTIVES.has(kept[start] as string)) start += 1;
  const name = kept.slice(start).join(' ');
  return name === '' ? null : singular(name);
}

/**
 * Hrozba z jmenné fráze: bez hromadného slova na konci („asteroid shower“ → asteroid); samo hromadné slovo nic,
 * s přívlastkem je hrozbou ono („giant waves“ → wave).
 */
function threatOf(phrase: string | null): string | null {
  if (phrase === null) return null;
  const head = phrase.replace(HEAP_AFTER, '');
  if (head === '' || HEAP_ONLY.test(head)) return null;
  return singular(NOT_THREAT.has(head) ? (phrase.split(' ').at(-1) as string) : head);
}

/** Chráněná postava: předmět slovesa ochrany, jinak podmět ohrožení. */
function keptOf(text: string): string | null {
  KEEP.lastIndex = 0;
  for (let match = KEEP.exec(text); match !== null; match = KEEP.exec(text)) {
    const object = match[1] as string;
    if (NOT_KEPT.test(object)) continue;
    const name = nameOf(nounPhrase(object, 4));
    if (name !== null) return name;
  }
  const verb = AT_RISK.exec(text);
  if (verb === null) return null;
  const clause = text.slice(0, verb.index).split(CLAUSE).at(-1)?.trim() ?? '';
  return clause === '' ? null : nameOf(nounPhrase(clause.split(/\s+/).slice(-3).join(' '), 3));
}

/** Co padá: pohyb před hrozbou, hromadné slovo, „from / against“, nebo podmět slovesa pádu či útoku. */
function fallingOf(text: string): string | null {
  for (const pattern of [FALLING, HEAP_OF]) {
    const match = pattern.exec(text);
    const found = match === null ? null : threatOf(nounPhrase(match[1] as string, 2));
    if (found !== null) return found;
  }
  const heap = HEAP_BEFORE.exec(text)?.[1];
  if (heap !== undefined && !NOT_THREAT.has(heap)) return singular(heap);
  const from = FROM.exec(text);
  if (from !== null) {
    const found = threatOf(nounPhrase((from[1] as string).replace(/^(?:falling|dropping|tumbling|the)\s+/, ''), 2));
    if (found !== null) return found;
  }
  const verb = FALLS.exec(text);
  if (verb === null) return null;
  const clause = text.slice(0, verb.index).split(CLAUSE).at(-1)?.replace(/\s+(?:are|is|keep|keeps|start|starts)\s*$/, '').trim() ?? '';
  return clause === '' ? null : threatOf(nounPhrase(clause.split(/\s+/).slice(-2).join(' '), 2));
}

/** Počet hrozeb: číslo nejvýš dvě slova před hrozbou („20 falling bombs“, „5 flower pots“), v mezích generátoru. */
function countOf(text: string, threat: string | null): number | null {
  if (threat === null) return null;
  const head = threat.split(' ').at(-1) as string;
  NUMBER.lastIndex = 0;
  for (let match = NUMBER.exec(text); match !== null; match = NUMBER.exec(text)) {
    const raw = match[1] as string;
    const words = text.slice(match.index + match[0].length).split(/[\s,.!?;]+/).slice(0, 3).map(singular);
    if (!words.includes(head)) continue;
    const count = /^\d+$/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw] as number);
    return Math.min(DRAWSAVE.threats.max, Math.max(DRAWSAVE.threats.min, count));
  }
  return null;
}

/** Co věta o záchraně říká bez AI: chráněná postava, hrozba a jejich počet. Chybějící = `null`. */
export function readRescue(sentence: string): { readonly kept: string | null; readonly threat: string | null; readonly threats: number | null } {
  const text = sentence.toLowerCase().replace(/[“”"]/g, '');
  const threat = fallingOf(text);
  const kept = keptOf(text);
  return { kept: kept === threat ? null : kept, threat, threats: countOf(text, threat) };
}

/** První text, který se vejde do meze schématu. */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const drawsaveGenre: GenreModule<'drawsave'> = {
  id: 'drawsave',
  modes: ['default'],
  // Slova kresby a záchrany; „protect“ jen s tím, co padá (obranu hradu vlastní `defense`). P68-I je zúží, když stráž
  // najde krádež („save the“ je široké).
  // P68-I T12 zúžilo `draw` → `draw a line` a `line` → `draw lines`: samotné „line“ bralo frontu obchodu („robots
  // line up for pizza“, `buildshift`) a „draw“ kreslicí program („draw a picture of my cat“) – `integration-log.md`.
  cues: ['draw a line', 'draw lines', 'protect from falling', 'save the'],
  heroClasses: ['animal', 'humanoid', 'prop', 'robot'],
  paramBounds: { threats: { min: DRAWSAVE.threats.min, max: DRAWSAVE.threats.max } },
  // Zapnuto v P68-I T12 („zapoj drawsave“, `stavba/integration.md` → Zapnutí); režisér a čtečka dál za branou
  // `DIRECTOR_PENDING` / `READER_PENDING`.
  availability: () => 'ready',
  compile: (spec) => {
    const threats = spec.params?.threats ?? DRAWSAVE.threats.default;
    const one = singular(castFor(spec, ...THREAT_DOES)?.label ?? DRAWSAVE_DEFAULTS.threat);
    const many = plural(one, threats);
    const seconds = String(DRAWSAVE_SECONDS);
    const kept = spec.hero;
    return legacySpec(spec, {
      control: 'drawsave',
      controlParams: { generator: 'drawsave_level', ...(threats === DRAWSAVE.threats.default ? {} : { tuning: { threats } }) },
      archetype: 'survival_timer',
      title: fit(80, `Save the ${titleCase(kept)}`, 'Draw to Save'),
      objective: {
        kind: 'survive',
        description: fit(120, `Draw lines to shield the ${kept} from ${String(threats)} falling ${many} for ${seconds} seconds.`, `Draw lines to keep the ${kept} safe for ${seconds} seconds.`, `Draw lines to keep it safe for ${seconds} seconds.`),
        seconds: DRAWSAVE_SECONDS,
      },
      roles: [{ id: 'threat', kind: 'hazard', label: one, count: threats }],
      tutorial: {
        goalLine: fit(80, `Keep the ${kept} safe from the ${plural(one, 2)}!`, `Keep the ${kept} safe!`, 'Keep it safe!'),
        controlsHint: 'Drag across the grid to draw a wall, then let go. Ink runs out!',
      },
      mood: 'tense',
      targetDurationSec: 30,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    const read = readRescue(sentence);
    const threat = read.threat ?? (cast === undefined ? undefined : castFor({ cast }, ...THREAT_DOES)?.label) ?? null;
    const kept = read.kept ?? (hero !== undefined && hero !== threat ? hero : null);
    return {
      genre: 'drawsave',
      mode: 'default',
      ...(kept === null ? {} : { hero: kept }),
      ...(setting === undefined || NOT_PLACE.test(setting) ? {} : { setting }),
      ...(threat === null ? {} : { cast: [{ label: threat, does: 'avoid' as const }] }),
      ...(read.threats === null ? {} : { params: { threats: read.threats } }),
    };
  },
};
