/**
 * Seedovaná náhoda kompilátoru her (P23-A).
 *
 * Jediný zdroj je `layout` stream z `src/sim/rng.ts` – tentýž `pure-rand`, který
 * pohání runtime, takže `compileGame(spec, seed)` dá pro stejný seed vždy týž
 * `WorldDoc`. Nic tady nesmí sáhnout na globální generátor ani na čas.
 */

import type { JumpableRandomGenerator } from 'pure-rand/types/JumpableRandomGenerator';

import { createStreams, nextInt } from '@/sim/rng';

export interface CompileRng {
  /** Celé číslo z uzavřeného intervalu `[from, to]`. */
  int(from: number, to: number): number;
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates nad kopií; vstup se nemění. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createCompileRng(seed: number): CompileRng {
  const stream: JumpableRandomGenerator = createStreams(seed).layout;
  const int = (from: number, to: number): number => nextInt(stream, from, to);
  return {
    int,
    pick: (items) => items[int(0, items.length - 1)] as (typeof items)[number],
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        [copy[i], copy[j]] = [copy[j] as (typeof copy)[number], copy[i] as (typeof copy)[number]];
      }
      return copy;
    },
  };
}
