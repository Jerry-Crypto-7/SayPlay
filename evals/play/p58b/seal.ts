/**
 * Pečeť zapečetěné sady P58B (T1): sada se otevře jednou, v T8. Logika je pečeť P55 (`openSealedOnce` bere složku
 * a otisk, `sha256Lf` počítá nad LF bajty); tady jen otisk P58B.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P58B_HOLDOUT_SHA256 = '578463714c9cee6540eb7c4755a68ecfbb883905388ad741c3f0648058c117e8';
