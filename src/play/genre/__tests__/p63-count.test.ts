/**
 * P63 T4: cíl počítá, co počítá věta. h11 „A little witch picks six glowing mushrooms“ hrálo „Collect 10 mushrooms
 * per wave, 3 waves.“ (P61 list, `main` i větev): návrh slovo „picks“ nezná a sbíral banány z bažiny, houby přidala
 * až skladba ze záměru věty – a počet nechala ležet. s002 „collect three keys … while dodging ghosts“ hrálo útěk
 * po vlnách: 3 klíče v každé ze 4 vln.
 *
 * Počet zapsaný do textu, ale ne do `objective.count` (nebo naopak), vypadá v HUD dobře a robot pak dohraje jinou
 * hru – proto test čte obojí a k tomu, co hra opravdu hraje (ladění generátoru), a pustí robota na semínkách
 * publikace. Rychlá hra (jen slova) i hra po čtení (uložené čtení astry, `evals/play/p63`).
 *
 * Žánry se sběrem nebo zásahem, jejichž cíl počítá roli věty. Běžec a plošinovka mají cílem doběhnout, věci jsou
 * navíc – ty tu nejsou. Žánry pruhů (chytání, bouchání, krájení) mají změřenou dolní mez délky hry (P54C T14br1:
 * 13, 13, 22 kusů, robot pod ní vyhraje pod 30 s) – počet pod ní se ořízne, proto tu stojí počet nad mezí.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { ARCADE_HZ } from '@/play/arcade/contract';
import { compileArcade } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft/draft';
import type { Reading } from '@/play/read/schema';
import type { GameSpecV1 } from '@/play/spec';

import oldReadings from '../../../../evals/play/p63/readings.astra.json';
import p63Readings from '../../../../evals/play/p63/readings.p63.astra.json';

/** Kde hra nese počet, který věta řekla: `objective.count`, nebo (střílečka) velikost vlny – výhra tam počítá vlny. */
type Where = 'objective' | 'waveSize';

const COUNTED: readonly { readonly sentence: string; readonly genre: string; readonly count: number; readonly where?: Where }[] = [
  { sentence: 'A little witch picks six glowing mushrooms in a dark swamp', genre: 'arena.collect', count: 6 },
  { sentence: 'A squirrel gathers five acorns before winter comes', genre: 'arena.collect', count: 5 },
  // Sloveso mimo hry („recovers“) dá cíl přenosu (`twistGoal`): „Collect the cells!“ počet zahodil.
  { sentence: 'An astronaut recovers three fuel cells scattered across Mars', genre: 'arena.collect', count: 3 },
  { sentence: 'A knight must collect three keys in a haunted castle while dodging ghosts.', genre: 'arena.escape', count: 3 },
  // „grabs“ by hrdinovi dal krádež (`ability_grab`), která počítá i okradené nepřátele – nález v README, ne tento test.
  { sentence: 'A diver collects 9 pearls while escaping two sharks', genre: 'arena.escape', count: 9 },
  { sentence: 'A knight fights two wolves in a castle', genre: 'arena.fight', count: 2 },
  { sentence: 'A wizard lights five candles in a dark forest', genre: 'quest.spatial', count: 5 },
  { sentence: 'A firefighter rescues 3 cats from a burning tower', genre: 'quest.spatial', count: 3 },
  { sentence: 'A space marine shoots four alien bugs in a mining colony', genre: 'shooter.default', count: 4, where: 'waveSize' },
  { sentence: 'Defend the castle from twelve zombies', genre: 'defense.default', count: 12 },
  { sentence: 'whack 20 moles popping out of the garden holes', genre: 'whack.default', count: 20 },
  { sentence: 'catch 15 falling apples but dodge the rotten ones', genre: 'catch.default', count: 15 },
  { sentence: 'swipe to cut 25 vegetables flying across the kitchen', genre: 'slice.default', count: 25 },
];

/** Žánry, jejichž cíl počítá vlny: počet věty je soupeřů v aréně naráz, resp. nepřátel ve vlně. */
const WAVES: ReadonlySet<string> = new Set(['arena.fight', 'shooter.default']);

/** Táž věta bez počtu: výchozí hodnota žánru, žádné `counts`, cíl jako dřív. */
const PLAIN: readonly { readonly sentence: string; readonly genre: string; readonly goal: RegExp; readonly count: number | undefined }[] = [
  // P83A T3: sprška `treasure_rush` – sběr první minuty má 8 věcí ve vlně (`FIRST_MINUTE`).
  { sentence: 'A little witch picks glowing mushrooms in a dark swamp', genre: 'arena.collect', goal: /^Collect 8 mushrooms per wave, \d waves\.$/, count: 8 },
  { sentence: 'A knight must collect keys in a haunted castle while dodging ghosts.', genre: 'arena.escape', goal: /^Grab 10 keys per wave, \d waves\. Don't get caught\.$/, count: 10 },
  { sentence: 'A knight fights wolves in a castle', genre: 'arena.fight', goal: /^Knock out \d waves of wolves\.$/, count: 1 },
  { sentence: 'A wizard lights candles in a dark forest', genre: 'quest.spatial', goal: /^Light all \d candles/, count: undefined },
  { sentence: 'Defend the castle from zombies', genre: 'defense.default', goal: /^Hold the castle! Stop every zombie\.$/, count: 30 },
];

const draft = (sentence: string, reading: Reading | null = null) => draftGameSpecWithMeta(sentence, 1, { reading });
const genreOf = (meta: ReturnType<typeof draft>): string => `${String(meta.genre?.genre)}.${String(meta.genre?.mode)}`;
const waveSize = (spec: GameSpecV1): unknown => (spec.controlParams as { readonly waveSize?: number }).waveSize;
/** Číslo věty v textu: číslicí („6 mushrooms“), ne jiné číslo vedle („10 per wave“). */
const numbers = (text: string): number[] => (text.match(/\d+/g) ?? []).map(Number);

/** Robot vyhraje na prvním semínku publikace, které hru vydá (jako `_publish`), za 30–90 s. */
function botWinSeconds(spec: GameSpecV1, sentence: string): number {
  for (const seed of derivedSeeds(seedFrom(sentence))) {
    const compiled = compileArcade(spec, seed);
    if (compiled.ok && compiled.value.winsAtTick !== null) return compiled.value.winsAtTick / ARCADE_HZ;
  }
  throw new Error(`${sentence}: no publish seed gives a robot win`);
}

type Rows = { readonly rows: readonly { readonly id: string; readonly models: Record<string, { readonly reading: unknown }> }[] };
const readingOf = (id: string): Reading =>
  ((p63Readings as Rows).rows.find((row) => row.id === id) ?? (oldReadings as Rows).rows.find((row) => row.id === id))!.models['astra@openai'].reading as Reading;

beforeAll(async () => {
  await loadRapier();
}, 60_000);

describe('P63 T4: the goal counts what the sentence counts (quick game, words only)', () => {
  it.each(COUNTED)('$genre: "$sentence" → $count in the goal, the objective and the game', ({ sentence, genre, count, where = 'objective' }) => {
    const meta = draft(sentence);
    const spec = meta.spec;
    expect(genreOf(meta), sentence).toBe(genre);
    // Souboj a střílečka hrají vlny („Knock out 5 waves of 2 wolves.“); ostatní žánry říkají jen počet věty.
    if (WAVES.has(genre)) expect(numbers(spec.tutorial.goalLine), spec.tutorial.goalLine).toContain(count);
    else expect(numbers(spec.tutorial.goalLine), spec.tutorial.goalLine).toEqual([count]);
    expect(numbers(spec.objective.description), spec.objective.description).toContain(count);
    if (where === 'objective') expect(spec.objective.count, sentence).toBe(count);
    else expect(waveSize(spec), sentence).toBe(count);
  });

  it.each(COUNTED)('$genre: the robot wins "$sentence" in 30–90 s', ({ sentence }) => {
    const seconds = botWinSeconds(draft(sentence).spec, sentence);
    expect(seconds, sentence).toBeGreaterThanOrEqual(30);
    expect(seconds, sentence).toBeLessThanOrEqual(90);
  }, 60_000);

  it.each(PLAIN)('$genre: "$sentence" without a count keeps the genre default', ({ sentence, genre, goal, count }) => {
    const meta = draft(sentence);
    expect(genreOf(meta), sentence).toBe(genre);
    expect(meta.genre?.counts, sentence).toBeUndefined();
    expect(meta.spec.tutorial.goalLine).toMatch(goal);
    expect(meta.spec.objective.count, sentence).toBe(count);
  });
});

describe('P63 T4: the reading game keeps the count too (recorded astra readings)', () => {
  it.each([
    { id: 'h11', sentence: 'A little witch picks six glowing mushrooms in a dark swamp', count: 6 },
    { id: 's002', sentence: 'A knight must collect three keys in a haunted castle while dodging ghosts.', count: 3 },
  ])('$id: $count in the goal and the objective', ({ id, sentence, count }) => {
    const spec = draft(sentence, readingOf(id)).spec;
    expect(numbers(spec.tutorial.goalLine), spec.tutorial.goalLine).toEqual([count]);
    expect(spec.objective.count).toBe(count);
  });
});
