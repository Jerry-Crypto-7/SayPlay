/**
 * P61 T3: rychlá hra (návrh bez čtení) obleče každý žánr do prostředí a protivníka věty. Na žánr jedna věta
 * s výrazným místem a nepřítelem nebo věcí; test čte, co scéna opravdu vybere – sadu (`lookOf`, jak ji bere
 * `ArcadePlay`) a model slotu, ze kterého scéna žánru kreslí protivníka či věc (`enemyModel`, `chaserModel`,
 * `propModels`, věci pravidel ze `sceneModelOf`). Spec, který slovo nese a scéna ho přesto nekreslí
 * (holý terč střelnice, výchozí robot), tu neprojde.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { lookFor, lookOf } from '../../arcade/look';
import { chaserModel, enemyModel, propModels, sceneModelOf } from '../../arcade/models';
import { loadRapier } from '../../arcade/physics/world';
import { draftGameSpecWithMeta } from '../../draft/draft';
import type { GameSpecV1 } from '../../spec';
import { GENRES, type GenreId } from '../contract';
import { GENRE_MODULES } from '../modules';

/** Slot scény → model, jak ho skládá `ArcadePlay` (`cast`): nepřítel střelnice, pronásledovatel, rekvizity, věci pravidel. */
function sceneSlots(spec: GameSpecV1): Readonly<Record<string, string | undefined>> {
  const things = Object.fromEntries(spec.roles.map((role) => [`thing.${role.id}`, sceneModelOf(role.label, false)]));
  return { enemy: enemyModel(spec), chaser: chaserModel(spec), ...propModels(spec), ...things };
}

interface Row {
  readonly genre: GenreId;
  readonly sentence: string;
  /** Místo věty; sada scény = `lookFor` tohohle místa (regex `KEYWORDS`). */
  readonly place: string;
  /** Slot scény → slovo věty, které model slotu jmenuje (id modelu ho obsahuje). */
  readonly slots: Readonly<Record<string, string>>;
}

const ROWS: readonly Row[] = [
  { genre: 'runner', sentence: 'A hamster escaping a supermarket while a giant Roomba hunts me', place: 'supermarket', slots: { chaser: 'roomba' } },
  { genre: 'platformer', sentence: 'a monkey jumps between platforms in a jungle temple avoiding spiders', place: 'jungle temple', slots: { spikes: 'spider' } },
  { genre: 'arena', sentence: 'A knight must collect three keys in a haunted castle while dodging ghosts.', place: 'haunted castle', slots: { chaser: 'ghost', coin: 'key' } },
  { genre: 'voyage', sentence: 'a pirate ship sails across the ocean dodging sharks', place: 'ocean', slots: { 'thing.part_0': 'shark' } },
  { genre: 'quest', sentence: 'a knight frees five prisoners in a dungeon guarded by skeletons', place: 'dungeon', slots: { chaser: 'skeleton' } },
  // Dev věta 1 (s039): zombie na střelnici i ve vlnách, obchoďák – místo věty přebije hřbitov, který napovídají zombie.
  { genre: 'shooter', sentence: 'zombie shooter in a mall', place: 'mall', slots: { enemy: 'zombie', target: 'zombie' } },
  { genre: 'throw', sentence: 'throwing snowballs at kids behind a snow fort', place: 'snow fort', slots: { target: 'kid' } },
  { genre: 'timing', sentence: 'stack cheese wheels into a wobbly tower at a farm market', place: 'farm', slots: { block: 'cheese' } },
  { genre: 'rhythm', sentence: 'A drummer frog plays on lily pads and the pond lights up with every beat', place: 'pond', slots: { note: 'lily-pad' } },
  { genre: 'duel', sentence: 'boxing a kangaroo in the australian outback', place: 'outback', slots: { rival: 'kangaroo' } },
  { genre: 'flap', sentence: 'a bat flaps through a dark cave dodging spiders', place: 'cave', slots: { pipe: 'spider' } },
  { genre: 'catch', sentence: 'a bear catches falling honey jars in a forest while dodging bees', place: 'forest', slots: { coin: 'honey', hazard: 'bee' } },
  { genre: 'whack', sentence: 'whack the zombies popping out of graves in a graveyard', place: 'graveyard', slots: { target: 'zombie' } },
  { genre: 'defense', sentence: 'defend the castle from waves of goblins', place: 'castle', slots: { chaser: 'goblin' } },
  { genre: 'slice', sentence: 'a ninja slices flying pumpkins in a haunted forest', place: 'haunted forest', slots: { coin: 'pumpkin' } },
  { genre: 'hop', sentence: 'a chicken crosses a busy city road dodging taxis', place: 'city', slots: { obstacle: 'taxi' } },
  // Dav ve městě: „a horde of zombies“ dřív dala hřbitov – tvor věty nepřebije místo, které věta řekne.
  { genre: 'crowd', sentence: 'a horde of zombies grows through gates in a city and attacks a dragon', place: 'city', slots: { 'thing.boss': 'dragon' } },
  { genre: 'merge', sentence: 'merge fruits in a jar in a kitchen', place: 'kitchen', slots: { coin: 'fruit' } },
  { genre: 'push', sentence: 'a polar bear shoves penguins off an ice floe in the arctic', place: 'arctic', slots: { rival: 'penguin' } },
  // P66 T12: pět nových žánrů – nepřítel vln, věc, kterou díra polyká, kořist a strážce, druhy k třídění, kus v zácpě.
  { genre: 'survivor', sentence: 'a knight survives waves of skeletons in a castle courtyard', place: 'castle courtyard', slots: { enemy: 'skeleton', 'thing.enemy': 'skeleton' } },
  { genre: 'hole', sentence: 'a black hole swallows the cars of a busy city', place: 'busy city', slots: { 'thing.item1': 'car' } },
  { genre: 'steal', sentence: 'a fox steals eggs from the farm and runs them back to its den while the farmer chases it', place: 'farm', slots: { 'thing.loot': 'egg', 'thing.guard': 'farmer' } },
  { genre: 'sort', sentence: 'sort the apples and pears into the right baskets on a farm', place: 'farm', slots: { 'thing.sort0': 'apple', 'thing.sort1': 'pear' } },
  { genre: 'arrows', sentence: 'tap each car so it drives out of the jammed parking lot', place: 'parking lot', slots: { 'thing.piece': 'car' } },
  // P68 T9: řádek minigolfu platí, jen když registr hru pouští (T9 ji vrátil za bránu – `modules.ts`).
  ...(GENRE_MODULES.minigolf.availability('default') === 'ready'
    ? [{ genre: 'minigolf', sentence: 'a crazy golf course in a haunted mansion where the ball has to roll past sliding coffins into the hole', place: 'haunted mansion', slots: { 'thing.mover': 'coffin' } } as const]
    : []),
  // P68 T12: drawsave, stejná podmínka.
  ...(GENRE_MODULES.drawsave.availability('default') === 'ready'
    ? [{ genre: 'drawsave', sentence: 'draw a roof to save the cat from falling bombs in a desert canyon', place: 'desert canyon', slots: { 'thing.player': 'cat', 'thing.threat': 'bomb' } } as const]
    : []),
  // P68 T10: railfps (věta kategorie s02), stejná podmínka.
  ...(GENRE_MODULES.railfps.availability('default') === 'ready'
    ? [{ genre: 'railfps', sentence: 'look around and shoot the zombies shambling toward you in the abandoned mall', place: 'abandoned mall', slots: { 'thing.enemy': 'zombie' } } as const]
    : []),
];

/** Dev věty P61, které `main` prohrál na prostředí nebo protivníkovi (`evals/play/p61/baseline-dev.json`). */
const DEV_ROWS: readonly Row[] = [
  { genre: 'shooter', sentence: 'A space marine shoots alien bugs in a mining colony', place: 'mining colony', slots: { enemy: 'bug', target: 'bug' } },
  // s008: „temple“ sady neznaly – louka s větrnými mlýny místo chrámu v džungli.
  { genre: 'runner', sentence: "temple run but you're a banana running from a monkey", place: 'temple', slots: { chaser: 'monkey' } },
  // s021: věta bez místa s lávou stála na plážových ostrovech výchozího místa žánru.
  { genre: 'platformer', sentence: 'obby game with lava and spinning bars', place: 'lava', slots: { 'thing.part_0': 'lava' } },
];

beforeAll(async () => {
  await loadRapier();
});

describe('P61 T3: the quick game wears the sentence’s setting and foe', () => {
  it('covers every genre that plays once', () => {
    // Kostra (`staged`) řádek nemá – návrh ji nevybere. Pět žánrů P66 řádky dostalo s T12, kdy je klasifikátor pustil.
    const playing = GENRES.filter((genre) => GENRE_MODULES[genre].modes.some((mode) => GENRE_MODULES[genre].availability(mode as never) !== 'staged'));
    expect(ROWS.map((row) => row.genre).sort()).toEqual([...playing].sort());
  });

  it.each([...ROWS, ...DEV_ROWS].map((row) => [row.genre, row.sentence, row] as const))('%s: %s', (genre, sentence, row) => {
    const meta = draftGameSpecWithMeta(sentence, 1);
    expect(meta.genre?.genre, 'drafted genre').toBe(genre);
    const look = lookFor(row.place);
    expect(look, `place "${row.place}" is a known look`).not.toBeNull();
    expect(lookOf(meta.spec.theme), 'scene look').toBe(look);
    const slots = sceneSlots(meta.spec);
    for (const [slot, word] of Object.entries(row.slots)) expect(slots[slot], `${slot} draws the sentence's ${word}`).toContain(word);
  });

  // „against“ jmenuje soupeře, „against the clock“ ne – soupeř zůstane ten, koho věta porazí.
  it.each([
    ['a horde of zombies grows through gates in a city and marches against a dragon', 'dragon'],
    ['a horde of zombies grows through gates in a city against the clock and attacks a dragon', 'dragon'],
  ])('crowd boss from "%s" is %s', (sentence, boss) => {
    const meta = draftGameSpecWithMeta(sentence, 1);
    expect(meta.genre?.genre).toBe('crowd');
    expect(sceneSlots(meta.spec)['thing.boss']).toContain(boss);
  });

  // Věta bez místa: svět dají její slova, ne výchozí místo žánru („desert outpost“ střílečky).
  it('a sentence without a place plays in the world its words name', () => {
    const spec = draftGameSpecWithMeta('zombie shooter', 1).spec;
    expect(lookOf(spec.theme)).toBe('graveyard');
    expect(sceneSlots(spec).target).toContain('zombie');
  });
});
