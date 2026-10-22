/**
 * Pečeť zapečetěné sady P56A (T2): sada se otevře jednou, v T13. Logika je pečeť P55 (`openSealedOnce` bere
 * složku a otisk, `sha256Lf` počítá nad LF bajty); tady jen otisk P56A.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P56A_HOLDOUT_SHA256 = '3dd3b9ebcabaa72b2f7ee275e188e80fab213de44da24d474dd78ca227e64999';
