/**
 * Pečeť zapečetěné sady P66 (T1): 30 vět (15 na nové žánry, 15 obecných), otevře se jednou v T16. Logika je pečeť P55
 * (`openSealedOnce`, `sha256Lf` nad LF bajty), seznam známých sad P58B doplněný o sady P56C a P58B–P64 a dev sadu P66.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { knownSets as p58bKnownSets, textsOf } from '../p58b/seal';

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { textsOf } from '../p58b/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P66_HOLDOUT_SHA256 = '42bf10ccca56ea5dab0b0c06cca9401701b3bb3980794c31da9a853c99c9e611';

const PLAY = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Sady po P58B (cesty od `evals/play`); P64 až po sloučení – do té doby ji pečeť porovnala v T1 z worktree P64 (README). */
const LATER_SETS = ['p58b/holdout.json', 'p61/holdout.json', 'p62/holdout.json', 'p62/holdout-b.json', 'p63/holdout.json', 'p63/read-set.json', 'p63/reread-set.json', 'p64/holdout.json', 'p66/dev.json'] as const;

/** Sady vět mimo zapečetěnou P66, se kterými nesmí sdílet větu: seznam P58B, každá sada `p56c/*.json` a `LATER_SETS`. */
export const knownSets = (): string[] => {
  const p56c = existsSync(join(PLAY, 'p56c')) ? readdirSync(join(PLAY, 'p56c')).filter((name) => name.endsWith('.json')).map((name) => `p56c/${name}`) : [];
  return [...new Set([...p58bKnownSets(), ...p56c, ...LATER_SETS])].filter((set) => existsSync(join(PLAY, set)) && textsOf(set).length > 0);
};
