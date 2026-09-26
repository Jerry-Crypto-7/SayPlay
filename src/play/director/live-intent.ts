/**
 * Věta uprostřed hry → živá změna, poctivý remix, nebo „nerozumím“ (P29D T8).
 *
 * Bez modelu: věta se rozdělí na klauze („make it rain and add more enemies“
 * jsou dvě) a každá se přečte proti krátkým seznamům. Co jde živě
 * (`arcade/live.ts`): víc hrozeb nebo sběru, čas, životy, náboje, počasí,
 * denní doba. Hrozba je tu jen „hostile“ – kterou roli to v běžící hře je,
 * rozhodne až stav (`resolveWish` → `hostileRole`).
 *
 * Co živě nejde (nová role, létání, nové ovládání, jiný cíl), jde dnešní
 * cestou remixu na novou verzi; třídu dá `classifyRemix`. Stačí jedna taková
 * klauze a celá věta je remix – půl změny živě a půl v nové verzi by hráč
 * nepoznal. Věta bez jediného návěští je `unknown`, ne tichý remix.
 */

import { type ArcadeRole, type ArcadeState, BODY, HEADER, ROLE, bodyBase } from '../arcade/contract';
import { type LiveCounter, type LivePatch, type TimeOfDay, type Weather, hostileRole } from '../arcade/live';
import type { RemixClass } from '../contracts';
import type { GameSpecV1 } from '../spec';

import { MECHANIC_VERBS, OBJECTIVE_WORDS, PRESENTATION_WORDS, TOPOLOGY_WORDS, chipOf, classifyRemix } from './remix';

/** Přání živé změny; hrozba se na roli převede až nad stavem běhu. */
export type LiveWish =
  | { readonly kind: 'spawn'; readonly target: 'hostile' | 'collectible'; readonly count: number }
  | { readonly kind: 'count'; readonly counter: LiveCounter; readonly amount: number }
  | { readonly kind: 'visual'; readonly weather?: Weather; readonly timeOfDay?: TimeOfDay };

export const REMIX_MESSAGE = 'That needs a new version – making it';
export const UNKNOWN_MESSAGE = 'I did not catch a change there. Try “more enemies”, “make it rain” or “extra life”.';

export type LiveIntent =
  | { readonly kind: 'live'; readonly wishes: readonly LiveWish[] }
  | { readonly kind: 'needsRemix'; readonly remixClass: RemixClass; readonly message: typeof REMIX_MESSAGE }
  | { readonly kind: 'unknown'; readonly message: typeof UNKNOWN_MESSAGE };

const NUMBERS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, another: 1, two: 2, couple: 2, three: 3, few: 3, four: 4, five: 5, ten: 10, twenty: 20, thirty: 30 };

const HOSTILE = /\b(enem(y|ies)|monsters?|baddies|bad guys|obstacles?|hazards?|zombies?|ghosts?|chasers?|spikes?|rocks?|bombs?|traps?|cars?|sharks?|guards?)\b/;
const COLLECTIBLE = /\b(coins?|stars?|gems?|collectibles?|pickups?|items?|treasures?|fruits?|apples?|diamonds?|points)\b/;
const MORE = /\b(more|extra|add|spawn|another|additional|bring|send|lots of|many|double)\b/;
const REMOVE = /\b(less|fewer|remove|no more|without|stop|get rid of|delete)\b/;

const WEATHER: readonly (readonly [RegExp, Weather])[] = [
  [/\b(stop (the )?(rain|snow)|clear (sky|skies|weather)|sunny|sunshine|no (more )?(rain|snow|fog))\b/, 'clear'],
  [/\b(rain|rains|raining|rainy|storm|stormy|downpour)\b/, 'rain'],
  [/\b(snow|snows|snowing|snowy|blizzard)\b/, 'snow'],
  [/\b(fog|foggy|mist|misty|haze)\b/, 'fog'],
];
const TIME: readonly (readonly [RegExp, TimeOfDay])[] = [
  [/\b(night|nighttime|night time|midnight|dark)\b/, 'night'],
  [/\b(dusk|sunset|evening|twilight)\b/, 'dusk'],
  [/\b(day|daytime|daylight|morning|noon|light)\b/, 'day'],
];

/** Klauze, která nic nechce – zdvořilost nebo výplň, ne „nerozumím“. */
const FILLER = /^(please|pls|thanks|thank you|ok|okay|now|also|and|then|oh|hey)?$/;
/** Věta o změně hry, kterou živě neumíme → remix. Bez tohohle návěští je to nesmysl. */
const CHANGE = /\b(add|put|let me|make|turn|change|give|swap|replace|want|can i|could|should|become|into|fly|flying|swim|shoot|faster|slower|bigger|smaller|harder|easier|new|more|remove)\b/;

function amount(clause: string, fallback: number): number {
  const digits = /\b(\d{1,3})\b/.exec(clause);
  if (digits !== null) return Number(digits[1]);
  if (/\b(lots of|a lot|many|tons of|loads of)\b/.test(clause)) return 5;
  for (const [word, value] of Object.entries(NUMBERS)) if (new RegExp(`\\b${word}\\b`).test(clause)) return value;
  return fallback;
}

/** Jedna klauze: přání, `remix`, nebo `null` (žádné návěští). */
function readClause(clause: string): LiveWish | 'remix' | null {
  const visual: { weather?: Weather; timeOfDay?: TimeOfDay } = {};
  const weather = WEATHER.find(([cue]) => cue.test(clause));
  if (weather !== undefined) visual.weather = weather[1];
  const time = /\b(time|clock|seconds?)\b/.test(clause) && MORE.test(clause) ? undefined : TIME.find(([cue]) => cue.test(clause));
  if (time !== undefined) visual.timeOfDay = time[1];
  if (visual.weather !== undefined || visual.timeOfDay !== undefined) return { kind: 'visual', ...visual };

  if (/\b(more|extra|add|longer|give me)\b/.test(clause) && /\b(time|seconds?|clock)\b/.test(clause)) return { kind: 'count', counter: 'time', amount: Math.min(30, amount(clause, 10)) };
  if (/\b(li(fe|ves)|health|hearts?|hp)\b/.test(clause) && /\b(more|extra|add|another|give|one more|\d+)\b/.test(clause)) return { kind: 'count', counter: 'health', amount: Math.min(3, amount(clause, 1)) };
  if (/\b(ammo|bullets?|arrows?|shots?|reload)\b/.test(clause) && /\b(more|extra|add|give|reload|refill)\b/.test(clause)) return { kind: 'count', counter: 'ammo', amount: Math.min(20, amount(clause, 5)) };

  const spawnable = HOSTILE.test(clause) ? 'hostile' : COLLECTIBLE.test(clause) ? 'collectible' : null;
  if (spawnable !== null && MORE.test(clause) && !REMOVE.test(clause)) return { kind: 'spawn', target: spawnable, count: Math.min(5, amount(clause, 3)) };

  if (CHANGE.test(clause) || REMOVE.test(clause) || MECHANIC_VERBS.test(clause) || TOPOLOGY_WORDS.test(clause) || OBJECTIVE_WORDS.test(clause) || PRESENTATION_WORDS.test(clause)) return 'remix';
  return null;
}

export function liveIntentOf(sentence: string, parent: GameSpecV1): LiveIntent {
  const text = sentence.trim().toLowerCase().replace(/[!?.]+$/g, '');
  if (chipOf(text) !== null) return { kind: 'needsRemix', remixClass: classifyRemix(sentence, parent), message: REMIX_MESSAGE };
  const clauses = text
    .split(/\s*(?:,|;|\band then\b|\bthen\b|\band\b|\bplus\b|\balso\b)\s*/)
    .map((clause) => clause.trim())
    .filter((clause) => !FILLER.test(clause));
  const wishes: LiveWish[] = [];
  let remix = false;
  for (const clause of clauses) {
    const read = readClause(clause);
    if (read === 'remix') remix = true;
    else if (read !== null) wishes.push(read);
  }
  if (remix) return { kind: 'needsRemix', remixClass: classifyRemix(sentence, parent), message: REMIX_MESSAGE };
  if (wishes.length === 0) return { kind: 'unknown', message: UNKNOWN_MESSAGE };
  return { kind: 'live', wishes };
}

function present(state: ArcadeState, role: ArcadeRole): boolean {
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) if (state[bodyBase(i) + BODY.role] === ROLE[role]) return true;
  return false;
}

/** Přání nad stavem běhu → patch pro `live.ts`; `null` = tahle hra tu roli nemá. */
export function resolveWish(wish: LiveWish, state: ArcadeState): LivePatch | null {
  if (wish.kind !== 'spawn') return wish;
  const role: ArcadeRole | null = wish.target === 'hostile' ? hostileRole(state) : present(state, 'collectible') ? 'collectible' : null;
  return role === null ? null : { kind: 'spawn', role, count: wish.count };
}
