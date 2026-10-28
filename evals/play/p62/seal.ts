/**
 * Pečeť zapečetěné sady P62 (T1): 24 vět o místě, otevře se jednou v T7. Logika je pečeť P55 (`openSealedOnce`,
 * `sha256Lf` nad LF bajty), seznam známých sad P58B; tady jen otisk P62.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { knownSets, textsOf } from '../p58b/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P62_HOLDOUT_SHA256 = '7863a64004efbc746fbec880a06f5ec04c16d114e32153c60541e4c413ca99a9';

/** SHA-256 nad LF bajty `holdout-b.json` (sada B, T9 – otevře se jednou v T12), zapsaný v README při zapečetění. */
export const P62_HOLDOUT_B_SHA256 = 'd62f5010f3dcabe025f4cb9f74449095273a51a11e41c04e7a03312d62719ece';
