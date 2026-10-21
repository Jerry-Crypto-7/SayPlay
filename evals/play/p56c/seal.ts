/**
 * Pečeť sad P56C (T2): otisk zapečetěného holdoutu a rodiny vět. Otevření jednou je `openSealedOnce` z P55 –
 * zapíše `holdout-opened.json` před prvním čtením a druhé otevření odmítne.
 */

export { openSealedOnce, sha256Lf } from '../p55/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P56C_HOLDOUT_SHA256 = 'f8197a6cd96febc4edddaf88016495ad8de40e92a3522d3f8a03a9ebfc4b3b2e';

/** Rodiny vět v obou sadách: víc sloves, jedno jasné sloveso, bez slovesa, jen svět. */
export const P56C_FAMILY_COUNTS = { multi_verb: 12, single_verb: 10, no_verb: 10, world_only: 8 } as const;
export type P56CFamily = keyof typeof P56C_FAMILY_COUNTS;
