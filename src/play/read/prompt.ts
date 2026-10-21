/**
 * Systémový text čtečky (P29B T2). Krátký – malý model na 3090 má odpovědět
 * do stovek milisekund a tvar odpovědi drží gramatika z `READING_JSON_SCHEMA`,
 * ne text.
 */

import { LOOK_IDS, type LookId } from '../arcade/look';
import { READ_CONTROLS } from '../spec';
import { READY_GENRE_MODES, ROLE_KINDS, VERB_CLASSES } from './schema';

const VERB_HINTS: Record<(typeof VERB_CLASSES)[number], string> = {
  tap_go: 'tap where the hero walks (explore, collect, sneak)',
  runner: 'runs by itself, swipe to jump or switch lanes',
  platform: 'move and jump with gravity',
  flap: 'tap to fly up, gravity pulls down',
  steer: 'drive or fly a vehicle, race, park',
  aim_shoot: 'aim and shoot',
  throw: 'drag and release: throw, launch, golf',
  timing: 'tap at the right moment: stack, cut, stop',
  rhythm: 'tap to the beat of music',
  melee: 'close fight: punch, sword, dodge',
  move_free: 'move freely in an arena, grow, eat, survive',
  manipulate: 'swap, match, sort or connect pieces',
  build_place: 'place towers, clothes, furniture',
  idle: 'click, earn, upgrade, merge',
  sandbox: 'open world or multiplayer',
};

/**
 * P56A T3: co režim hraje, slovy hráče – jeden řádek na režim, který hraje (`READY_GENRE_MODES`). Chybějící řádek
 * shodí test promptu, ne čtení.
 */
export const MODE_HINTS: Readonly<Record<string, string>> = {
  'runner.default': 'runs by itself in lanes: dodge, jump, slide',
  'platformer.default': 'jump ledge to ledge over gaps to the goal',
  'arena.escape': 'move around while something hunts you',
  'arena.collect': 'roam and pick everything up, nobody hunts you',
  'arena.fight': 'roam and beat foes up close',
  'voyage.race': 'steer a vehicle or animal through a course, beat rivals',
  'voyage.land': 'fly with thrust and tilt, touch down softly',
  'quest.spatial': 'walk to objects and act on each (light, fix) while chased',
  'quest.station': 'stay at a stove or bench, finish orders before they pile up',
  'shooter.default': 'stand, aim and shoot waves coming at you',
  'throw.default': 'charge, aim an arc, throw at a target or hoop',
  'timing.stack': 'tap to drop a swinging block onto a tower',
  'timing.precision': 'tap to stop a sweeping marker in the zone',
  'timing.bridge': 'hold to grow a plank across a gap',
  'rhythm.default': 'tap notes on the beat of music',
  'duel.default': 'one on one: dodge the wind-up, strike back',
  'flap.default': 'tap to fly up through gaps',
  'catch.default': 'catch falling things, dodge bad ones',
  'whack.default': 'hit things popping out of holes',
  'defense.default': 'stop waves marching down lanes at what you protect',
  'slice.default': 'swipe through things tossed up, not bombs',
  'hop.default': 'hop row by row across roads, rivers and rails',
  'crowd.default': 'grow a crowd through gates, beat a giant',
  'merge.default': 'drop items in a box, two alike merge bigger',
  'push.default': 'shove rivals out of a ring',
};

/** Co sada vzhledu pokrývá, když to id samo neřekne (louka je i farma, ne vesmír). */
const LOOK_HINTS: Partial<Record<LookId, string>> = { meadow: 'farm/park', living_room: 'home', underwater: 'reef', space: 'moon/planets', graveyard: 'haunted' };

export function readerSystemPrompt(): string {
  return [
    'Read one game idea sentence and answer one JSON object. Never add words that are not implied by the sentence.',
    `control: the control that fits the main verb best: ${READ_CONTROLS.join('|')}.`,
    'verbs: up to 4 verbs of the sentence, main verb first; word = the verb as written, class = one of:',
    ...VERB_CLASSES.map((id) => `- ${id}: ${VERB_HINTS[id]}`),
    'hero: who the player is, 1-3 words from the sentence; null for you/I/my.',
    `roles: up to 6 other nouns that matter in play; kind = ${ROLE_KINDS.join('|')}; count = the number the sentence gives, else null.`,
    'setting: where it happens in English, or null. mood: one or two words, or null.',
    'numbers: seconds = a time limit in seconds, else null; counts = the other numbers in order.',
    'genre: the game the sentence wants, {genre, mode} from this list, or null when none fits:',
    ...READY_GENRE_MODES.flatMap(({ genre, modes }) => modes.map((mode) => `- ${genre}.${mode}: ${MODE_HINTS[`${genre}.${mode}`] ?? ''}`)),
    'foe: who or what the hero fights, flees or dodges, 1-3 words, or null.',
    'item: the main thing the hero collects, throws or protects, or null.',
    `world: the look of the place, one of ${LOOK_IDS.map((id) => (LOOK_HINTS[id] === undefined ? id : `${id} (${LOOK_HINTS[id]})`)).join(', ')}; null when none fits.`,
    'title: a short game title in the sentence\'s own words (max 32 chars), never "<hero> Run".',
  ].join('\n');
}
