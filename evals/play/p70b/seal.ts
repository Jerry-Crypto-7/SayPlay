/**
 * Pečeť zapečetěné sady P70B (T1): 70 vět – 30 se zvířetem z knihovny (riggovaný model) jako hrdinou, 20 na golf
 * a 20 obecných přes ≥ 8 dosavadních žánrů – a jejich slepé štítky, zapečetěné před první změnou směrování a výběru
 * modelu v P70B; otevře je jednou T5. Sada P68T je od T3 otevřená a věty auditu 4. 11. (`dev.json`) jsou dev sada
 * T2–T3, proto jsou obě mezi známými sadami. Sada i štítky leží mimo repo v `SEALED_DIR`, v repu jsou jen otisky;
 * logika pečeti je P55 (`openSealedOnce`, `sha256Lf` nad LF bajty).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { knownSets as p68tKnownSets, textsOf } from '../p68t/seal';

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { textsOf } from '../p68/seal';

/** SHA-256 nad LF bajty `holdout.json` a `holdout-labels.json`, zapsané v README při zapečetění. */
export const P70B_HOLDOUT_SHA256 = '53351a03dcb64073137980095401905730da210ce6ea53a2b35c05e766ace371';
export const P70B_LABELS_SHA256 = 'c0cbf7360d111c08332e740029a7695b02b7637212e9b6fbfb4efd6d2e2c1b0d';

/** Složka se zapečetěnou sadou mimo repo (`P70B_SEALED_DIR` přepíše cestu, např. pro zálohu na `F:`). */
export const SEALED_DIR = process.env.P70B_SEALED_DIR ?? 'D:/caches/p70b/sealed';
export const HOLDOUT_PATH = join(SEALED_DIR, 'holdout.json');
export const LABELS_PATH = join(SEALED_DIR, 'holdout-labels.json');

/** Sady po P68T (cesty od `evals/play`), na kterých se ladí nebo které někdo otevřel. */
const LATER_SETS = ['p68t/holdout.json', 'p70b/dev.json'] as const;

/** Sady vět mimo zapečetěnou P70B, se kterými nesmí sdílet větu: seznam P68T a `LATER_SETS`. */
export const knownSets = (): string[] => [...new Set([...p68tKnownSets(), ...LATER_SETS])].filter((set) => textsOf(set).length > 0);

/** Je zapečetěná sada na tomto stroji? (Jinde test pečeti hlídá jen seznam známých sad.) */
export const holdoutPresent = (): boolean => existsSync(HOLDOUT_PATH);

/**
 * Riggovaná zvířata sady: druh → modely, které za něj platí (`src/assets/rigged*.json`, tag druhu). Věta psaná na
 * druh má hrdinu správně, když hrdina hry je jeden z těchto modelů. Zmrazené při zapečetění, stejně jako štítky.
 */
export const ANIMALS: Readonly<Record<string, readonly string[]>> = {
  rabbit: ['rigged:pet-bunny', 'rigged:q-big-bunny'],
  cat: ['rigged:pet-cat', 'rigged:q-blob-cat'],
  dog: ['rigged:pet-dog', 'rigged:q-husky', 'rigged:q-shiba', 'rigged:q-blob-dog'],
  penguin: ['rigged:pet-penguin', 'rigged:q-cute-penguin'],
  'polar bear': ['rigged:pet-polar-bear'],
  fox: ['rigged:q-fox'],
  wolf: ['rigged:q-wolf'],
  horse: ['rigged:q-horse', 'rigged:q-white-horse'],
  cow: ['rigged:q-cow'],
  deer: ['rigged:q-deer', 'rigged:q-cute-fawn', 'rigged:q-stag'],
  panda: ['rigged:q-cute-panda'],
  chicken: ['rigged:q-cute-chicken', 'rigged:q-blob-chicken'],
  crab: ['rigged:q-cute-crab'],
  alpaca: ['rigged:q-alpaca'],
  donkey: ['rigged:q-donkey'],
};

/** Kolik vět dostane který druh (30 celkem; králík víc – stížnost majitele). */
export const ANIMAL_COUNTS: Readonly<Record<string, number>> = {
  rabbit: 4, cat: 2, dog: 2, penguin: 2, 'polar bear': 2, fox: 2, wolf: 2, horse: 2, cow: 2, deer: 2, panda: 2, chicken: 2, crab: 2, alpaca: 1, donkey: 1,
};

/** Obecná třetina: 20 vět přes 14 dosavadních žánrů (bez her P68). */
export const GENERAL_COUNTS: Readonly<Record<string, number>> = {
  voyage: 2, platformer: 2, runner: 2, shooter: 2, throw: 2, quest: 2, arena: 1, catch: 1, whack: 1, defense: 1, flap: 1, duel: 1, rhythm: 1, hop: 1,
};
