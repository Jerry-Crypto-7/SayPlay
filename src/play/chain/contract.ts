/**
 * Kontrakt řetězu mikroher (P56C T5): posloupnost obyčejných světů jádra, mezi koly karta se slovesem.
 * Jádro se nemění – kolo je `ArcadeWorld` ze `GameSpecV1`, řetěz je čistá funkce nad nimi (`run.ts`).
 */

import type { ArcadeWorld } from '../arcade/contract';
import type { GameSpecV1 } from '../spec';
import type { MicroKey } from './micro';

/** Verze přehrávače řetězu; mění se s každou změnou, která pohne `hashChain`. */
export const CHAIN_RUNTIME_VERSION = 'chain-v1';

/** Karta se slovesem mezi koly: 1 s při 60 Hz. Vstupy během ní se zahodí. */
export const CARD_TICKS = 60;

/**
 * Životy každého kola, bosse taky (P70A T3): kolo postavené s jedním životem (`microSpec`) jich v řetězu dostane
 * tolik (`roundWorld`), zásah stojí jeden a kolo jede dál. Prohrané kolo řetěz zastaví a „Try again“ ho hraje znovu.
 */
export const CHAIN_LIVES = 2;

/**
 * Kola 2 až N−1 dostanou jeden mutátor z `mutator-compat.json` (T16); `false` = řetěz jako v T14.
 * Vypnuto: slepý soud s mutátory proti bez nich dal 12 remíz z 12 – na snímcích je soudce nerozezná (`evals/play/p56c/mutators.md`).
 */
export const CHAIN_MUTATORS = false;

/**
 * Kolo řetězu. Všechna kola hrají 60 tiků za sekundu – zrychlování pozdějších kol (`rate` do P70A T3) je pryč;
 * řetěz uložený dřív `rate` ještě nese, klient ho nečte.
 */
export interface ChainRound {
  readonly spec: GameSpecV1;
  readonly world: ArcadeWorld;
  readonly key: MicroKey;
  readonly card: string;
  readonly boss: boolean;
  /** Mutátor kola (`MUTATOR_IDS`); svět kola ho už nese (`mutateWorld`). */
  readonly mutator?: string;
  /** Karta mutátoru pod slovesem („Mirror!“) – uložená při stavbě, klient `mutators.ts` nenačte. */
  readonly twist?: string;
}

export interface ChainWorld {
  readonly runtimeVersion: typeof CHAIN_RUNTIME_VERSION;
  readonly seed: number;
  /** Životy každého kola (`CHAIN_LIVES`); řetěz uložený před P70A T3 nese 3. */
  readonly lives: number;
  readonly cardTicks: number;
  readonly rounds: readonly ChainRound[];
}
