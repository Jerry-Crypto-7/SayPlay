/**
 * P63 T2: hra po čtení hraje sloveso věty. Sedm vět P61, které po čtení hrály něco jiného (rytíř s drakem jízdou,
 * hasič bez plamenů, tuleň sbíráním, balón bez publikace), jde čtením nového promptu (`readings.p63.astra.json`)
 * návrhem jako na serveru (`diagnose.mjs`). Žánr, který „vypadá blízko“, projde okem; tady ho drží tabulka
 * sloveso → přípustné žánry. Regrese: 36 vět P61 proti výchozímu stavu `main` (`diagnosis.json`).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { chainReasons } from '../../chain/decide';
import diagnosis from '../../../../evals/play/p63/diagnosis.json';
import { admissible, EXPECT, gamesOf, loadDeps, namesCast } from '../../../../evals/play/p63/diagnose.mjs';
import readSet from '../../../../evals/play/p63/read-set.json';
import oldReadings from '../../../../evals/play/p63/readings.astra.json';
import p63Readings from '../../../../evals/play/p63/readings.p63.astra.json';

/** Sloveso, které věta hraje → žánry, které ho hrají (`runner` = každý režim běžce). */
const VERB_GENRES: Readonly<Record<string, readonly string[]>> = {
  fight: ['arena.fight', 'duel.default'],
  slay: ['arena.fight', 'duel.default'],
  race: ['runner', 'voyage.race'],
  spray: ['quest.spatial', 'platformer.default'],
  stack: ['timing.stack'],
  bounce: ['catch.default', 'timing.precision'],
  steer: ['flap.default', 'voyage.race'],
};

const SENTENCES = [
  { id: 'h02', verb: 'fight' },
  { id: 'h14', verb: 'race' },
  { id: 'h15', verb: 'spray' },
  { id: 'h18', verb: 'slay' },
  { id: 'h19', verb: 'stack' },
  { id: 'h23', verb: 'bounce' },
  { id: 'h24', verb: 'steer' },
] as const;

/** Věty, jejichž hru po čtení T2 cíleně mění: h18 souboj místo jízdy, h23 chytání místo sbírání; h24 se nově publikuje. */
const GENRE_CHANGED = ['h18', 'h23'];
const PUBLISH_CHANGED = ['h24'];

type Rows = { readonly rows: readonly { readonly id: string; readonly models: Record<string, { readonly reading: unknown }> }[] };

/** Čtení věty: nový prompt, kde ho T2 přečetl (19 vět), jinak čtení T1 – starý prompt, týž model. */
const readingOf = (id: string): unknown =>
  ((p63Readings as Rows).rows.find((row) => row.id === id) ?? (oldReadings as Rows).rows.find((row) => row.id === id))?.models['astra@openai'].reading ?? null;

const textOf = (id: string): string => readSet.sentences.find((row) => row.id === id)?.text ?? '';

let deps: unknown;
// Návrh i fyzika se načítají poprvé; pod zátěží celé sady to trvá déle než výchozích 10 s.
// P70A T2: řetěz jen na výslovné přání; diagnóza P63 (`diagnosis.json`) staví rychlou hru pravidlem před P70A.
beforeAll(async () => {
  const loaded = (await loadDeps()) as object;
  deps = { ...loaded, chainOrSingle: (...args: Parameters<typeof chainReasons>) => (chainReasons(...args).length > 0 ? 'chain' : 'single') };
}, 60_000);

describe('P63 T2: the reading game plays the verb and roles of the sentence', () => {
  it.each(SENTENCES)('$id plays "$verb" with the hero and roles of the sentence', ({ id, verb }) => {
    const { quickGame, readingGame, published } = gamesOf(textOf(id), readingOf(id), deps);
    const want = EXPECT[id];
    expect(readingGame?.genre, `${id} reading game genre`).toSatisfy((genre: string | null) => admissible(genre, VERB_GENRES[verb]));
    expect(namesCast(readingGame!.cast, want), `${id} reading cast ${JSON.stringify(readingGame!.cast)}`).toBe(true);
    // Hra, kterou hráč po čtení hraje: hra po čtení, když se publikuje, jinak zůstane rychlá.
    const played = published ? readingGame! : quickGame;
    expect(admissible(played.genre, VERB_GENRES[verb]) && namesCast(played.cast, want), `${id} played game ${played.genre}`).toBe(true);
  });

  it('keeps the reading game of the other 36 P61 sentences as on main', () => {
    const changed = diagnosis.all.flatMap((main) => {
      const { readingGame, published } = gamesOf(textOf(main.id), readingOf(main.id), deps);
      return [
        ...(readingGame?.genre === main.reading || GENRE_CHANGED.includes(main.id) ? [] : [`${main.id} genre ${main.reading} -> ${readingGame?.genre}`]),
        ...(published === main.published || PUBLISH_CHANGED.includes(main.id) ? [] : [`${main.id} published ${main.published} -> ${published}`]),
      ];
    });
    expect(diagnosis.all).toHaveLength(36);
    expect(changed).toEqual([]);
    // 72 návrhů: samotný ~45 s, pod zátěží celé sady přes výchozích 60 s.
  }, 240_000);

  it('changes exactly the sentences it targets', () => {
    for (const id of GENRE_CHANGED) {
      const main = diagnosis.all.find((row) => row.id === id)!;
      expect(gamesOf(textOf(id), readingOf(id), deps).readingGame?.genre, id).not.toBe(main.reading);
    }
    for (const id of PUBLISH_CHANGED) {
      const main = diagnosis.all.find((row) => row.id === id)!;
      expect(gamesOf(textOf(id), readingOf(id), deps).published, id).toBe(!main.published);
    }
  });
});
