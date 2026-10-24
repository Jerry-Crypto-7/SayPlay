/**
 * Pečeť zapečetěné sady P58A (T1): sada se otevře jednou, v T9. Logika je pečeť P55 (`openSealedOnce` bere složku
 * a otisk, `sha256Lf` počítá nad LF bajty); tady otisk P58A, sady, se kterými se nesmí překrývat, a co je „mimo katalog“.
 */

import { heroChoice } from '../../../src/play/arcade/models';
import { nounsOf } from '../p56a/visible.mjs';

export { openSealedOnce, sha256Lf } from '../p55/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P58A_HOLDOUT_SHA256 = '84812b185bf2091355d9a06df48863b9f726ab8be857a393a167f0747c7def16';

/** Každá sada v `evals/play`, na které se ladilo, nebo kterou kdo otevřel – včetně zapečetěné sady P56A (dnes dev). */
export const KNOWN_SETS = [
  'p30/dev.json', 'p30/test-200.json', 'p43/panel.json', 'p43/sealed-100.json', 'p45/panel.json', 'p45/sealed-100.json',
  'p52/dev.json', 'p52/holdout.json', 'p54c/dev.json', 'p54c/holdout.json', 'p55/holdout.json', 'demand/corpus.json',
  'p56a/audit-12.json', 'p56a/holdout.json', 'p56b/sentences.json', 'p57/audit-12.json',
] as const;

/** Katalog má pro slovo přesný model (stejný výběr jako protivník: bez hranic žánru). */
export const exactModel = (noun: string): boolean => heroChoice(noun, undefined, undefined, 'enemy').level === 'identity';

/** Věta je „mimo katalog“, když některé ze slov soudce (hrdina, protivník, bez něj věc) nemá přesný model. */
export const outsideCatalog = (sentence: { readonly hero: string | null; readonly foe: string | null; readonly item: string | null }): boolean =>
  !nounsOf(sentence).every(exactModel);
