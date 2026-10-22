/**
 * Kontrakt řetězu mikroher (P56C T5): posloupnost obyčejných světů jádra, mezi koly karta se slovesem.
 * Jádro se nemění – kolo je `ArcadeWorld` ze `GameSpecV1`, řetěz je čistá funkce nad nimi (`run.ts`).
 */

import { type ArcadeWorld, START_LIVES } from '../arcade/contract';
import type { GameSpecV1 } from '../spec';
import type { MicroKey } from './micro';

/** Verze přehrávače řetězu; mění se s každou změnou, která pohne `hashChain`. */
export const CHAIN_RUNTIME_VERSION = 'chain-v1';

/** Karta se slovesem mezi koly: 1 s při 60 Hz. Vstupy během ní se zahodí. */
export const CARD_TICKS = 60;

/** Životy celého řetězu; prohra kola stojí jeden. */
export const CHAIN_LIVES = START_LIVES;

/**
 * Kola 2 až N−1 dostanou jeden mutátor z `mutator-compat.json` (T16); `false` = řetěz jako v T14.
 * Vypnuto: slepý soud s mutátory proti bez nich dal 12 remíz z 12 – na snímcích je soudce nerozezná (`evals/play/p56c/mutators.md`).
 */
export const CHAIN_MUTATORS = false;

/** Tempo přehrávání kol v promile (1000 = 60 tiků za sekundu). Jen klient – hash ani záznam ho nevidí. */
export const RATE_STEPS = [1000, 1075, 1150, 1225, 1300] as const;

export interface ChainRound {
  readonly spec: GameSpecV1;
  readonly world: ArcadeWorld;
  readonly key: MicroKey;
  readonly card: string;
  readonly rate: number;
  readonly boss: boolean;
  /** Mutátor kola (`MUTATOR_IDS`); svět kola ho už nese (`mutateWorld`). */
  readonly mutator?: string;
  /** Karta mutátoru pod slovesem („Mirror!“) – uložená při stavbě, klient `mutators.ts` nenačte. */
  readonly twist?: string;
}

export interface ChainWorld {
  readonly runtimeVersion: typeof CHAIN_RUNTIME_VERSION;
  readonly seed: number;
  readonly lives: number;
  readonly cardTicks: number;
  readonly rounds: readonly ChainRound[];
}
