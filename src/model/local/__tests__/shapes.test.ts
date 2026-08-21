/**
 * Rozpoznávač tvarů vět (P11 T7).
 *
 * Dvě vlastnosti, které se musí držet **současně**, protože každá zvlášť se dá
 * splnit podvodem:
 *
 * 1. **Co rozpozná, to projde produkční certifikací.** Ne „vrátil objekt" —
 *    svět se postaví, odkazy sedí a svědek dojde do výhry. Soudí to `emitLocally`,
 *    tedy týž řetěz, kterým jde emise z modelu i ze serveru.
 * 2. **Co nerozpozná, to vrátí `null`.** Bez tohohle by stačilo odpovídat na
 *    všechno jedním světem a projít každou bránou — přesně ta vakuózní past,
 *    kterou u fallbacku popisuje `CLAUDE.md` rozpor 9.
 *
 * Věty jsou skutečné, ze zmrazené sady `evals/corpus-v3`, ne vymyšlené k testu.
 */

import { describe, expect, it } from 'vitest';

import { emitLocally } from '../emit';
import { recognize, SHAPES, shapeIdFor } from '../shapes';

/** Model, jehož spuštění je chyba testu: rozpoznaná věta se ho nesmí dotknout. */
const forbiddenEngine = {
  modelId: 'nikdy',
  complete: () => Promise.reject(new Error('rozpoznaná věta se neměla ptát modelu')),
  unload: () => Promise.resolve(),
};

/** Jedna skutečná věta z korpusu na každý tvar. */
const SENTENCES: Record<string, string> = {
  'keys-to-door': 'a puzzle room where I have to find three keys to open the exit door',
  'lever-opens-the-way': 'a spaceship bridge where pulling the lever launches us and the stars streak past',
  'button-dispenses': 'a rainy cyberpunk alley with a vending machine that dispenses a can when I press the button',
  'fetch-then-open': 'a dungeon with a chest that only opens if I bring the torch from the other room',
  'pressure-plates': 'a door that needs three people standing on three pressure plates at the same time',
  'beat-the-clock': 'an escape room in a submarine that floods slowly, I have 60 seconds',
  'collect-to-score': 'a farm where I plant seeds, they grow over time, and I can harvest them for coins',
  'code-lock': 'a lock with a four digit code where wrong entries make an alarm sound',
  'patrolling-character': 'a stealth level where guards patrol and see me if I stand in the light',
  'reach-the-goal': 'a marble run where I place ramps and the marble has to reach the goal',
};

describe('rozsah rozpoznávače', () => {
  it('má aspoň osm tvarů a každý z nich má v testu skutečnou větu', () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(SENTENCES).sort()).toEqual(SHAPES.map((shape) => shape.id).sort());
  });

  it('věta mimo známé tvary vrátí null, ne náhradní svět', () => {
    // Kdyby tenhle test zezelenal i pro rozpoznávač, který odpovídá na všechno,
    // je celé měření v T7 bezcenné — proto je tu, a proto jsou ty věty ze sady.
    expect(recognize('a chess board where the pieces argue with each other before moving')).toBeNull();
    expect(recognize('a zen garden where raking the sand makes ripples that spread outward')).toBeNull();
    expect(recognize('')).toBeNull();
  });
});

describe('každý tvar dojde k certifikaci', () => {
  for (const [id, sentence] of Object.entries(SENTENCES)) {
    it(`${id} postaví svět, který projde celým řetězem`, async () => {
      expect(shapeIdFor(sentence)).toBe(id);

      const outcome = await emitLocally({ sentence, engine: forbiddenEngine, recognize });

      expect(outcome.kind).toBe('verdict');
      if (outcome.kind !== 'verdict') return;
      expect(outcome.body.outcome).toBe('CERTIFIED');
      expect(outcome.body.provenance).toEqual({ source: 'shapes' });
    });
  }
});

describe('parametry se čtou z věty, nejsou zapečené', () => {
  it('počet sbíraných věcí odpovídá tomu, kolik jich věta žádá', () => {
    const three = recognize('find three keys to open the exit door') as { sim: { entities: Record<string, unknown> } };
    const two = recognize('find 2 keys to open the exit door') as { sim: { entities: Record<string, unknown> } };

    const collectibles = (world: { sim: { entities: Record<string, unknown> } }): number =>
      Object.values(world.sim.entities).filter((e) => (e as { role: string }).role === 'collectible').length;

    expect(collectibles(three)).toBe(3);
    expect(collectibles(two)).toBe(2);
  });

  it('odpočet se počítá ze sekund ve větě, ne z konstanty', () => {
    const world = recognize('an escape room that floods slowly, I have 60 seconds') as {
      sim: { state: { timers: Record<string, { durationTicks: number }> } };
    };
    // 20 Hz podle `VERIFY.md` §3.3 — 60 s je 1200 tiků, strop horizontu 600.
    expect(world.sim.state.timers.deadline.durationTicks).toBe(600);

    const short = recognize('a countdown of 10 seconds before the roof falls') as {
      sim: { state: { timers: Record<string, { durationTicks: number }> } };
    };
    expect(short.sim.state.timers.deadline.durationTicks).toBe(200);
  });

  it('užší tvar rozhoduje dřív než širší', () => {
    // Věta nese „keys" i „escape"; klíče jsou konkrétnější a musí vyhrát.
    expect(shapeIdFor('I need three keys to escape through the exit door')).toBe('keys-to-door');
  });
});
