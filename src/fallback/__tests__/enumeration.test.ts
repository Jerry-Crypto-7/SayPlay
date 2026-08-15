import { describe, expect, it } from 'vitest';

import { A1 } from '../archetypes/a1-collect-unlock';
import { A2 } from '../archetypes/a2-sort-match';
import { A3 } from '../archetypes/a3-guide-avoid';
import { runTrace, type Archetype } from '../loop';

const ARCHETYPES: readonly Archetype[] = [A1, A2, A3];

/**
 * Seed n-tice. Musí být funkcí indexu, ne náhodou — jinak by „všech 624 n-tic
 * prošlo" platilo o jiné sadě světů při každém běhu.
 */
function seedFor(index: number): number {
  return 1000 + index * 7;
}

describe.each(ARCHETYPES.map((archetype) => [archetype.id, archetype] as const))(
  'enumerace %s',
  (_id, archetype) => {
    const tuples = archetype.tuples();

    it('vyčerpá deklarovanou doménu a každá n-tice je jiná', () => {
      expect(tuples.length).toBe(archetype.manifest.tupleCount);
      const seen = new Set(tuples.map((tuple) => JSON.stringify(tuple)));
      expect(seen.size).toBe(tuples.length);
    });

    it('žádná n-tice nevede k nedohratelnému světu', () => {
      // 624 n-tic celkem je malé číslo a to je celý smysl fallbacku: dá se
      // projít vyčerpávajícím způsobem, takže „každá kombinace je dohratelná"
      // je měření, ne odhad.
      const broken: string[] = [];
      tuples.forEach((tuple, index) => {
        const seed = seedFor(index);
        const trace = archetype.solve(tuple, seed);
        if (trace === null) {
          broken.push(`${JSON.stringify(tuple)}: řešitel nenašel stopu`);
          return;
        }
        const result = runTrace(archetype.game(tuple), seed, trace);
        if (result.view.phase !== 'won') {
          broken.push(`${JSON.stringify(tuple)}: stopa skončila ${result.view.phase}`);
        }
      });
      expect(broken).toEqual([]);
    });

    it('žádná n-tice nevede k insta-win světu', () => {
      // Insta-win = svět, který vyhraje sám, bez jediného hráčova záměru.
      // Kontroluje se přes celý časový strop, ne jen na tiku nula.
      const instant: string[] = [];
      tuples.forEach((tuple, index) => {
        const result = runTrace(archetype.game(tuple), seedFor(index), []);
        if (result.view.phase === 'won') instant.push(JSON.stringify(tuple));
      });
      expect(instant).toEqual([]);
    });

    it('každá n-tice je deterministická na seed', () => {
      const drifted: string[] = [];
      tuples.forEach((tuple, index) => {
        const seed = seedFor(index);
        const trace = archetype.solve(tuple, seed)!;
        const first = runTrace(archetype.game(tuple), seed, trace);
        const second = runTrace(archetype.game(tuple), seed, trace);
        if (JSON.stringify(first) !== JSON.stringify(second)) drifted.push(JSON.stringify(tuple));
      });
      expect(drifted).toEqual([]);
    });
  },
);

describe('spike jako celek', () => {
  it('má 624 n-tic k vyčerpávající enumeraci', () => {
    const total = ARCHETYPES.reduce((sum, archetype) => sum + archetype.tuples().length, 0);
    expect(total).toBe(624);
  });
});
