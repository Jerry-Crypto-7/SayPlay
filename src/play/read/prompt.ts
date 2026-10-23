/**
 * Systémový text čtečky (P29B T2). Krátký – malý model na 3090 má odpovědět
 * do stovek milisekund a tvar odpovědi drží gramatika z `READING_JSON_SCHEMA`,
 * ne text.
 */

import { LOOK_IDS, type LookId } from '../arcade/look';
import { READ_CONTROLS } from '../spec';
import { READY_GENRE_MODES, ROLE_KINDS, VERB_CLASSES } from './schema';

// P56A T5: krátké – místo dostaly znaky žánrů níž (prompt ≤ 3 500 znaků).
const VERB_HINTS: Record<(typeof VERB_CLASSES)[number], string> = {
  tap_go: 'tap where to walk',
  runner: 'auto-run, swipe lanes',
  platform: 'jump with gravity',
  flap: 'tap to fly up',
  steer: 'drive, race, park',
  aim_shoot: 'aim and shoot',
  throw: 'throw, launch, golf',
  timing: 'tap at the right moment',
  rhythm: 'tap to the beat',
  melee: 'punch, sword, dodge',
  move_free: 'roam, eat, survive',
  manipulate: 'swap, match, sort',
  build_place: 'place towers, furniture',
  idle: 'click, earn, upgrade',
  sandbox: 'open world',
};

/**
 * P56A T3: co režim hraje, slovy hráče – jeden řádek na režim, který hraje (`READY_GENRE_MODES`). Chybějící řádek
 * shodí test promptu, ne čtení.
 *
 * P56A T5: čtečka četla chytání, bouchání, krájení, přeskákání, dav a vytlačování jako obecnou Arénu nebo běžce.
 * Žánry se znakem ve větě jdou proto první a řádek říká ten znak – co padá, vykukuje, letí, kudy se přechází –,
 * obecné režimy až za nimi (`MODE_ORDER`). Žánr čtení gpt-oss-20b (`low`): p55 holdout-opened 13 → 35/60,
 * p54c dev 32 → 50/64 (dvě kola, druhé přidalo „ne závěrečný boj ani běh“ a slučování napřed).
 */
export const MODE_HINTS: Readonly<Record<string, string>> = {
  'merge.default': 'two alike or identical items combine into a bigger one',
  'crowd.default': 'a group grows through gates, doors or portals (x2, +5), then fights',
  'push.default': 'shove, ram or bump others off a ring, island, edge or plate',
  'hop.default': 'get across roads, highways, tracks or rivers row by row past traffic',
  'catch.default': 'things fall, drop or rain down and the hero catches them',
  'whack.default': 'things pop up, peek or rise from holes and get hit before they hide',
  'slice.default': 'things fly, drift or are tossed and get cut or swiped in midair',
  'defense.default': 'many foes march or come at something you protect',
  'quest.spatial': 'walk to objects and act on each (light, fix, free)',
  'quest.station': 'stay at a stove or bench, finish orders',
  'shooter.default': 'aim and shoot what comes at you',
  'throw.default': 'aim an arc, throw at a target or hoop',
  'timing.stack': 'drop a swinging block onto a tower',
  'timing.precision': 'stop a sweeping marker in the zone',
  'timing.bridge': 'grow a plank across a gap',
  'rhythm.default': 'tap notes to music',
  'duel.default': 'one on one fight or argument',
  'flap.default': 'tap to fly up through gaps',
  'voyage.race': 'steer a vehicle or animal on a course',
  'voyage.land': 'fly with thrust, touch down softly',
  'platformer.default': 'jump ledge to ledge over gaps',
  'runner.default': 'runs forward by itself in lanes, nothing to cross',
  'arena.escape': 'roam while something hunts you',
  'arena.fight': 'roam and beat foes up close, no edge, no growing group',
  'arena.collect': 'roam and pick things up lying around',
};

/** Pořadí řádků žánru v promptu: pořadí `MODE_HINTS`, režim bez řádku na konec (test promptu ho shodí). */
const MODE_ORDER = Object.keys(MODE_HINTS);

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
    'genre: the game the sentence wants, {genre, mode}: the FIRST line below whose sign the sentence shows (the sign decides, not a final fight or the hero running), or null when none fits:',
    ...READY_GENRE_MODES.flatMap(({ genre, modes }) => modes.map((mode) => `${genre}.${mode}`))
      .sort((a, b) => (MODE_ORDER.indexOf(a) + 1 || 99) - (MODE_ORDER.indexOf(b) + 1 || 99))
      .map((id) => `- ${id}: ${MODE_HINTS[id] ?? ''}`),
    'sure: false when two genre lines fit about equally or you are guessing, else true.',
    'foe: who or what the hero fights, flees or dodges, 1-3 words, or null.',
    'item: the main thing the hero collects, throws or protects, or null.',
    `world: the look of the place, one of ${LOOK_IDS.map((id) => (LOOK_HINTS[id] === undefined ? id : `${id} (${LOOK_HINTS[id]})`)).join(', ')}; null when none fits.`,
    'title: a short game title in the sentence\'s own words (max 32 chars), never "<hero> Run".',
  ].join('\n');
}
