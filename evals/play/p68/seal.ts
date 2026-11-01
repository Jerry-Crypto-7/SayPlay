/**
 * Pečeť zapečetěné sady P68 (T1): 105 vět (15 na každou z pěti nových her, 30 obecných přes ≥ 10 dosavadních žánrů),
 * otevře se jednou v T15. Na rozdíl od P66 sada nežije v repu ani ve worktree kategorií: leží v `HOLDOUT_PATH` mimo
 * repo a v repu je jen její otisk. Logika pečeti je P55 (`openSealedOnce`, `sha256Lf` nad LF bajty), známé sady jsou
 * seznam P66 doplněný o zapečetěnou sadu P66 a dev sadu P68.
 */

import { existsSync } from 'node:fs';

import { knownSets as p66KnownSets, textsOf } from '../p66/seal';

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { textsOf } from '../p66/seal';

/** SHA-256 nad LF bajty zapečetěné sady, zapsaný v README při zapečetění. */
export const P68_HOLDOUT_SHA256 = 'f24fadb05ce96ae1a14816eef66d751ddd41ea3eeedc07a4f43f4139ffd43c61';

/** Zapečetěná sada mimo repo (`P68_HOLDOUT_PATH` přepíše cestu, např. pro zálohu na `F:`). */
export const HOLDOUT_PATH = process.env.P68_HOLDOUT_PATH ?? 'D:/caches/p68/sealed/holdout.json';

/** Sady po P66 (cesty od `evals/play`), na kterých se ladilo nebo které někdo otevřel. */
const LATER_SETS = ['p66/holdout.json', 'p68/dev.json'] as const;

/** Sady vět mimo zapečetěnou P68, se kterými nesmí sdílet větu: seznam P66 a `LATER_SETS`. */
export const knownSets = (): string[] => [...new Set([...p66KnownSets(), ...LATER_SETS])].filter((set) => textsOf(set).length > 0);

/** Je zapečetěná sada na tomto stroji? (CI a cizí stroje ji nemají; test pečeti pak hlídá jen dev sadu.) */
export const holdoutPresent = (): boolean => existsSync(HOLDOUT_PATH);
