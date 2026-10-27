/**
 * Pečeť zapečetěné sady P62 (T1): 24 vět o místě, otevře se jednou v T7. Logika je pečeť P55 (`openSealedOnce`,
 * `sha256Lf` nad LF bajty), seznam známých sad P58B; tady jen otisk P62.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { knownSets, textsOf } from '../p58b/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P62_HOLDOUT_SHA256 = '7863a64004efbc746fbec880a06f5ec04c16d114e32153c60541e4c413ca99a9';
