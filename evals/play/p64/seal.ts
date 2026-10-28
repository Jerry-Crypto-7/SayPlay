/**
 * Pečeť zapečetěné sady P64 (T1): 24 vět pro hru na výšku, otevře se jednou v T8. Logika je pečeť P55 (`openSealedOnce`,
 * `sha256Lf` nad LF bajty), seznam známých sad P58B; tady jen otisk P64.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { knownSets, textsOf } from '../p58b/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P64_HOLDOUT_SHA256 = '77c23c1f50f1a6588eb5538a75d54d801a6b754af92394a0c64bcd01b447d624';
