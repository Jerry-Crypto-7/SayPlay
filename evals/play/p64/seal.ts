/**
 * Pečeť zapečetěné sady P64 (T1): 24 vět pro hru na výšku, otevře se jednou v T8. Logika je pečeť P55 (`openSealedOnce`,
 * `sha256Lf` nad LF bajty), seznam známých sad P58B; tady jen otisk P64.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { knownSets, textsOf } from '../p58b/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P64_HOLDOUT_SHA256 = '77c23c1f50f1a6588eb5538a75d54d801a6b754af92394a0c64bcd01b447d624';

/** T8-R3: první sada je otevřená a kód se po ní změnil, brána potřebuje novou. SHA-256 nad LF bajty `r3/holdout.json`. */
export const P64_R3_HOLDOUT_SHA256 = '231f085e878745a0a8895a8559661aa6fe23bca62e94145c1cbe5f0168d4e455';
