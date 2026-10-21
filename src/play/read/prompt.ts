/**
 * Systémový text čtečky (P29B T2). Krátký – malý model na 3090 má odpovědět
 * do stovek milisekund a tvar odpovědi drží gramatika z `READING_JSON_SCHEMA`,
 * ne text.
 */

import { CAPABILITIES } from '../capabilities';
import { READ_CONTROLS } from '../spec';
import { ROLE_KINDS, VERB_CLASSES } from './schema';

const VERB_HINTS: Record<(typeof VERB_CLASSES)[number], string> = {
  tap_go: 'tap a place or thing, the hero walks there (explore, collect, sneak, escape)',
  runner: 'hero runs by itself, swipe to jump or switch lanes',
  platform: 'move left/right and jump with gravity',
  flap: 'tap to fly up, gravity pulls down',
  steer: 'drive or fly a vehicle, race, park',
  aim_shoot: 'aim and shoot',
  throw: 'drag and release: throw, launch, golf, basketball',
  timing: 'tap or hold at the right moment: stack, cut, stop',
  rhythm: 'tap to the beat of music',
  melee: 'close fight: punch, sword, dodge',
  move_free: 'move freely in an arena, grow, eat, survive waves',
  manipulate: 'swap, match, sort or connect pieces on a board',
  build_place: 'place things: towers, clothes, furniture',
  idle: 'click, earn, upgrade, merge',
  sandbox: 'open world or multiplayer',
};

export function readerSystemPrompt(): string {
  return [
    'Read one game idea sentence and answer one JSON object. Never add words that are not implied by the sentence.',
    'control: the playable control that fits the main verb best:',
    ...READ_CONTROLS.map((id) => `- ${id}: ${CAPABILITIES[id].cues}`),
    'verbs: up to 4 verbs of the sentence, main verb first; word = the verb as written, class = one of:',
    ...VERB_CLASSES.map((id) => `- ${id}: ${VERB_HINTS[id]}`),
    'hero: who the player is, 1-3 words from the sentence, or null.',
    `roles: up to 6 other nouns that matter in play; kind = ${ROLE_KINDS.join('|')}; count = the number the sentence gives, else null.`,
    'setting: where it happens in English, or null. mood: one or two words, or null.',
    'numbers: seconds = a time limit in seconds, else null; counts = the other numbers in order.',
  ].join('\n');
}
