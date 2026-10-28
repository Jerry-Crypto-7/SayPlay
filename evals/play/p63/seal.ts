/**
 * Pečeť zapečetěné sady P63 (T1): 24 vět pro hru po čtení, otevře se jednou v T6. Logika je pečeť P55 (`openSealedOnce`,
 * `sha256Lf` nad LF bajty), seznam známých sad P58B; tady jen otisk P63.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { knownSets, textsOf } from '../p58b/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P63_HOLDOUT_SHA256 = 'e03e39a08c2a3e4ba2ea98054ce367b08e2ffcd9f66dc815d92222740538051b';
