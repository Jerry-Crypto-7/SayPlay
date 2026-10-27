/**
 * Pečeť zapečetěné sady P61 (T1): 24 vět, otevře se jednou v T8. Logika je pečeť P55 (`openSealedOnce`, `sha256Lf`
 * nad LF bajty), seznam známých sad P58B; tady jen otisk P61.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { knownSets, textsOf } from '../p58b/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P61_HOLDOUT_SHA256 = 'e15ce81f8bb6b17c9411314419054ec8771ebbdb0fb8d30df96672b6ad3e4e0b';
