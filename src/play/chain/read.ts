/**
 * Čtení věty pro řetěz mikroher (P56C T3): jediné, co řetěz z věty čte – hrdina, protivník, předmět, svět a slovesa.
 *
 * Rozhraní `SentenceRead` je to, co P56C od čtení věty z P56A čeká; dokud P56A nedorazí, tělo `readForChain`
 * skládá jen existující kusy: čtení modelem (`Reading`, když je), `draftRoles`, `readRoles`, `lookFor` a položky
 * záměru z `extractIntent`. Bez sítě a bez stavu – stejná věta dává stejné čtení. Na P56A sahá jen tělo (T17).
 */

import { lookFor, type LookId } from '../arcade/look';
import { readRoles } from '../draft/lexicon';
import { draftRoles } from '../genre/contract';
import { extractIntent } from '../intent';
import type { IntentAction } from '../intent/contract';
import type { Reading, VerbClass } from '../read/schema';

export interface SentenceRead {
  /** Podmět věty, 1–3 slova. */
  readonly hero: string | null;
  /** Protivník (chase / attack / avoid). */
  readonly foe: string | null;
  /** Předmět (collect / catch / target). */
  readonly item: string | null;
  /** Svět věty jako jedna z `LOOK_IDS`. */
  readonly look: LookId | null;
  /** Slovesa v pořadí věty; první = hlavní, nejvýš 4. */
  readonly verbs: readonly { readonly word: string; readonly class: VerbClass }[];
  readonly title: string | null;
  readonly source: 'llm' | 'lexicon';
}

const MAX_VERBS = 4;

/** Kanonický kus záměru → třída slovesa (legenda `VERB_CLASSES`). Hrozby jen tam, kde je sloveso nese hrdina („dodging“). */
const VERB_CLASS: Readonly<Record<IntentAction['axis'], Readonly<Record<string, VerbClass>>>> = {
  move: { run: 'runner', jump: 'platform', flap: 'flap', drive: 'steer', roam: 'move_free', glide: 'flap', walk: 'move_free', ball: 'sandbox', lanes: 'steer', hop: 'tap_go', crowd: 'steer', drop: 'timing' },
  action: {
    shoot: 'aim_shoot', throw: 'throw', fight: 'melee', collect: 'move_free', deliver: 'move_free', interact: 'manipulate', stack: 'build_place',
    time: 'timing', beat: 'rhythm', duel: 'melee', kick: 'throw', whack: 'melee', slice: 'manipulate', merge: 'manipulate', push: 'melee',
  },
  objective: { race: 'steer', reach: 'move_free', collect: 'move_free', survive: 'runner', escape: 'runner', defeat: 'melee', catch: 'move_free', score: 'throw', land: 'flap', build: 'build_place', defend: 'build_place' },
  threat: { chaser: 'runner', guard: 'move_free', hazard: 'steer', obstacle: 'steer', rival: 'steer' },
  unknown: {},
};

/** Hlava, která je místo, ne postava: slovník bere podmětem i „an underwater city built …“. */
const PLACE_NOUNS = new Set([
  'city', 'town', 'village', 'market', 'library', 'desert', 'forest', 'jungle', 'ocean', 'sea', 'island', 'castle', 'cave', 'mountain',
  'valley', 'lake', 'river', 'swamp', 'garden', 'park', 'kitchen', 'house', 'room', 'world', 'planet', 'land', 'kingdom', 'alley', 'street',
]);

const isPlace = (phrase: string): boolean => PLACE_NOUNS.has(phrase.split(' ').filter((word) => !/ed$|^built$|^made$/.test(word)).at(-1) ?? '');

/** Poslední tři slova – hrdina z věty je 1–3 slova. */
const short = (phrase: string): string => phrase.trim().split(/\s+/).slice(-3).join(' ');

/** Kde ve větě položka záměru začíná (`said` je slovo z věty). */
const positionOf = (text: string, said: string): number => {
  const at = text.indexOf(said.toLowerCase());
  return at < 0 ? text.length : at;
};

/** Slovesa věty ze záměru: první výskyt každého slova, hrozba jen se slovesem hrdiny, ne s holým jménem („lava“). */
function lexiconVerbs(sentence: string, items: readonly IntentAction[]): SentenceRead['verbs'] {
  const seen = new Set<string>();
  const verbs: { word: string; class: VerbClass }[] = [];
  for (const item of items) {
    const verbClass = VERB_CLASS[item.axis][item.verb];
    const head = item.said.toLowerCase().split(' ')[0] ?? '';
    if (verbClass === undefined || seen.has(head)) continue;
    // U hrozby je aktérem ona sama: „lava“ s aktérem „lava“ je jméno, „dodging“ s aktérem „snowball“ sloveso.
    if (item.axis === 'threat' && item.said.toLowerCase().includes(item.actor)) continue;
    seen.add(head);
    verbs.push({ word: item.said, class: verbClass });
  }
  const text = sentence.toLowerCase();
  return verbs.sort((a, b) => positionOf(text, a.word) - positionOf(text, b.word)).slice(0, MAX_VERBS);
}

/** Hrdina záměru jen jako podmět se členem před prvním slovesem („where a robot hops“), ne „balloon popping“. */
function intentHero(sentence: string, hero: string | null, verbs: SentenceRead['verbs']): string | null {
  if (hero === null || !/^[a-z]+$/.test(hero) || verbs.length === 0) return null;
  const text = sentence.toLowerCase();
  const named = new RegExp(`\\b(?:a|an|the|my|your) (?:[a-z-]+ )?${hero}\\b`).exec(text);
  return named !== null && named.index < positionOf(text, verbs[0]!.word) ? hero : null;
}

export function readForChain(sentence: string, reading: Reading | null): SentenceRead {
  const roles = draftRoles(sentence, reading);
  const intent = extractIntent(sentence);
  const verbs = reading !== null ? reading.verbs.slice(0, MAX_VERBS) : lexiconVerbs(sentence, intent.items);
  const lexiconHero = roles.hero !== undefined && !isPlace(roles.hero) ? roles.hero : intentHero(sentence, intent.hero, verbs);
  const hero = reading?.hero ?? lexiconHero;

  const foe = roles.cast?.find((member) => member.does !== 'collect')?.label ?? null;
  const caught = intent.items.find((item) => (item.verb === 'collect' || item.verb === 'catch') && item.object !== null)?.object ?? null;
  const item =
    roles.cast?.find((member) => member.does === 'collect')?.label ??
    reading?.roles.find((role) => role.kind === 'target')?.noun ??
    (reading === null ? readRoles(sentence).target ?? caught : null);

  return {
    hero: hero === null ? null : short(hero),
    foe,
    item,
    look: lookFor(reading?.setting ?? roles.setting ?? '', reading?.mood ?? '') ?? lookFor(sentence),
    verbs,
    title: null,
    source: reading === null ? 'lexicon' : 'llm',
  };
}
