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
 * Žánry se znakem ve větě jdou proto první, obecné režimy až za nimi (`MODE_ORDER`). Žánr čtení gpt-oss-20b (`low`):
 * p55 holdout-opened 13 → 35/60, p54c dev 32 → 50/64.
 *
 * P58B T6: řádek říká, co hráč ve hře dělá („you …“), ne slovo, které věta použije – past láká slovem („catch the bus“,
 * „shoot pics“, „card battle“). Obrana od střílečky se liší cestami k bráněnému místu, úkol od útěku předměty, na kterých
 * hráč něco dělá.
 */
export const MODE_HINTS: Readonly<Record<string, string>> = {
  // P68 R7: kvůli stropu 6 000 znaků pryč jen slova, která řádek říká dvakrát (merge, catch, whack, slice, defense,
  // timing.stack) – rozdíly mezi žánry beze změny.
  'merge.default': 'you drop items in a box and two alike fuse into a bigger one',
  'crowd.default': 'you lead a group through gates (x2, +5) that grow or shrink it, then it fights',
  'push.default': 'you shove, ram or bump rivals off a ring, island, edge or plate',
  // P66 T13: pět žánrů P66 – každý má ve větě svůj znak, proto před obecnými režimy. Krátké: prompt má strop 6 000 znaků.
  'survivor.default': 'foes swarm in waves, the hero shoots by itself',
  'hole.default': 'a hole swallows smaller things and grows',
  'steal.default': 'you grab loot and run it home past guards',
  'sort.default': 'you tap things into bins of their kind',
  'arrows.default': 'you tap stuck pieces out the way they point',
  // P68 R7 (`stavba/integration.md` → Pitch, zkrácený na strop): kresba je znak hry, proto před chytáním (`catch`).
  'drawsave.default': 'you draw lines to shield someone from falling things',
  // P68 R9 (`prvni-osoba/integration.md` → Popis, zkrácený na strop): pohled z očí nebo jízda je znak hry, proto před
  // bouchnutím (`whack` – „clowns popping up along the track“), obranou i střílečkou.
  'railfps.default': 'first person or on a rail ride, you turn to shoot foes',
  'hop.default': 'you hop forward row by row across roads, rails or rivers past traffic',
  // P68 R9: kvůli stropu 6 000 znaků (řádek `railfps` a ovládání `railfps`) pryč jen slova navíc – řádky catch, duel
  // a flap a pokyny control, verbs, count, seconds, sure, world a title v `readerSystemPrompt`; rozdíly mezi žánry beze změny.
  'catch.default': 'things fall and you move under them to catch or bounce them back up',
  'whack.default': 'things pop up from holes and you hit them before they hide',
  'slice.default': 'things are tossed or fly and you cut them midair',
  'defense.default': 'foes come in waves down paths or lanes at a wall, base or home you guard; you hold every path',
  'quest.spatial': 'you walk to objects one by one and act on each (light, fix, pop, free, clean, deliver), even with a chaser',
  // P68 T11: před stanovištěm, ať „serve customers in my diner“ nevezme jedno pracoviště. V promptu je až s R5 (brána
  // `READER_PENDING`); pak prompt přeroste strop 6 000 znaků o ~170 a věta „genre is null … managing a shop“ se změní.
  'buildshift.default': 'you build a small shop (ovens, counters, shelves) on a grid, open it and serve customers who come for one food or drink before they walk out',
  'quest.station': 'you stay at one stove, bench or workplace and cook, brew, fix or craft, order after order',
  'shooter.default': 'you stand, aim and shoot foes or targets coming at you',
  // P68 T9: před hodem, ať „sink the ball“ u golfu nevezme koš. V promptu je až s R6 (brána `READER_PENDING`).
  'minigolf.default': 'you putt a ball along a walled lane past bumpers into a hole in as few strokes as you can',
  'throw.default': 'you aim an arc and throw at a target, hoop or stack',
  'timing.stack': 'you stack a tower, dropping each swinging piece onto the last',
  'timing.precision': 'you stop a sweeping marker inside a small zone',
  'timing.bridge': 'you grow a plank long enough to span a gap',
  'rhythm.default': 'you tap notes as they reach a line, in time with music',
  'duel.default': 'you fight one rival face to face in real time: dodge, strike back',
  'flap.default': 'you tap to flap up, flying forward through gaps',
  'voyage.race': 'you steer a vehicle, animal or board along a course or in a race',
  'voyage.land': 'you fly with thrust and touch down softly',
  'platformer.default': 'you jump ledge to ledge over gaps to a goal',
  'runner.default': 'the hero runs forward by itself; you switch lanes, jump and slide, nothing to cross',
  'arena.escape': 'you roam an area and survive while something hunts you',
  'arena.fight': 'you roam and beat several foes up close, no edge, no growing group',
  'arena.collect': 'you roam and pick up things lying around',
};

/**
 * P58B T6: ručně psané příklady – žádný nesdílí pět slov za sebou s dev, otevřenou ani zapečetěnou sadou (test promptu).
 * Každý učí jeden rozdíl, na kterém čtečka nebo slovník na dev chyboval: slovo pasti, obrana × střílečka, úkol
 * s pronásledovatelem, tahová nebo rozhovorová hra bez žánru.
 */
export const PROMPT_EXAMPLES: readonly { readonly sentence: string; readonly genre: string | null }[] = [
  { sentence: 'a turtle must catch the ferry, so hop him over the dock lanes between rolling forklifts', genre: 'hop.default' },
  { sentence: 'a lighthouse keeper fires flares at the ghost ships drifting toward him', genre: 'shooter.default' },
  { sentence: 'goblins stomp down three trails to the bakery, put a cannon on each trail', genre: 'defense.default' },
  { sentence: 'a janitor mops every puddle in the dark school while the principal stalks the halls', genre: 'quest.spatial' },
  { sentence: 'two sumo cats square off on a round mat, shove the other one out', genre: 'push.default' },
  { sentence: 'a kangaroo bounces down the outback road by itself and i only swap lanes to dodge trucks', genre: 'runner.default' },
  { sentence: 'a ranger hikes up the frozen valley and defeats the yeti waiting at the top', genre: 'duel.default' },
  { sentence: 'chess against a grumpy owl, each captured piece turns into a feather', genre: null },
  { sentence: 'a talk show where a nervous robot answers the host and you pick every reply', genre: null },
  // P66 T13: příklad focení netopýrů pryč kvůli stropu 6 000 znaků – focení jmenuje řádek žánru („shoot photos“) i řádek null.
];

/** Pořadí řádků žánru v promptu: pořadí `MODE_HINTS`, režim bez řádku na konec (test promptu ho shodí). */
const MODE_ORDER = Object.keys(MODE_HINTS);

/** Co sada vzhledu pokrývá, když to id samo neřekne (louka je i farma, ne vesmír). */
const LOOK_HINTS: Partial<Record<LookId, string>> = { meadow: 'farm/park', living_room: 'home', underwater: 'reef', space: 'moon/planets', graveyard: 'haunted' };

export function readerSystemPrompt(): string {
  return [
    'Read one game idea sentence and answer one JSON object. Never add words the sentence does not imply.',
    `control: the one that fits the main verb best: ${READ_CONTROLS.join('|')}.`,
    'verbs: up to 4 of the sentence, main verb first; word = the verb as written, class = one of:',
    ...VERB_CLASSES.map((id) => `- ${id}: ${VERB_HINTS[id]}`),
    'hero: who the player is, 1-3 words from the sentence; null for you/I/my.',
    `roles: up to 6 other nouns that matter in play; kind = ${ROLE_KINDS.join('|')}; count = the number given, else null.`,
    'setting: where it happens in English, or null. mood: one or two words, or null.',
    'numbers: seconds = a time limit, else null; counts = the other numbers in order.',
    'genre: the game the sentence wants, {genre, mode}. Judge by what the player keeps doing in play, not by a word in the sentence: "catch the bus" is not catching, "shoot photos" is not shooting, a "race" in a story is not racing. Take the FIRST line below that fits. How the hero gets somewhere (runs, rides, flies) does not decide; slaying or beating the foe the sentence names does, unless the sentence is a race and the fight only ends it:',
    ...READY_GENRE_MODES.flatMap(({ genre, modes }) => modes.map((mode) => `${genre}.${mode}`))
      .sort((a, b) => (MODE_ORDER.indexOf(a) + 1 || 99) - (MODE_ORDER.indexOf(b) + 1 || 99))
      .map((id) => `- ${id}: ${MODE_HINTS[id] ?? ''}`),
    'genre is null when the play is none of these: turn-based cards, board games or chess, quizzes, riddles, choosing what to say, dating or story choices, managing a shop, farm or city, math or logic puzzles, taking photos, slow fishing. A word of a line inside such a game ("battle", "race", "band", "shoot") does not make that line fit. Any other sentence that names an action a line plays (stack a tower, cook, fix, pop, deliver) takes the closest line even without its details.',
    'Examples (sentence => genre):',
    ...PROMPT_EXAMPLES.map(({ sentence, genre }) => `"${sentence}" => ${genre ?? 'null'}`),
    'sure: false only when two lines fit the play about equally; a lure word alone is no reason; else true.',
    'foe: who or what the hero fights, flees or dodges, 1-3 words, or null.',
    'item: the main thing the hero collects, throws or protects, or null.',
    `world: the look of the place: ${LOOK_IDS.map((id) => (LOOK_HINTS[id] === undefined ? id : `${id} (${LOOK_HINTS[id]})`)).join(', ')}; null when none fits.`,
    'title: a short title in the sentence\'s own words (max 32 chars), never "<hero> Run".',
  ].join('\n');
}
