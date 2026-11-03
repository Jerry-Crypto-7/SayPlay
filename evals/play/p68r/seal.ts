/**
 * Pečeť zapečetěné sady P68R (T1): 105 vět (15 na každou z pěti nových her, 30 obecných přes ≥ 10 dosavadních žánrů)
 * a jejich slepé štítky, zapečetěné před první změnou směrování v P68R; otevře je jednou T6. Holdout P68 je od T15
 * otevřený a P68R na něm ladí, proto je mezi známými sadami. Sada i štítky leží mimo repo v `SEALED_DIR`, v repu jsou
 * jen otisky; logika pečeti je P55 (`openSealedOnce` nad `SEALED_DIR`, `sha256Lf` nad LF bajty).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { knownSets as p68KnownSets, textsOf } from '../p68/seal';

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { textsOf } from '../p68/seal';

/** SHA-256 nad LF bajty `holdout.json` a `holdout-labels.json`, zapsané v README při zapečetění. */
export const P68R_HOLDOUT_SHA256 = '2a62edae56cdb9c4536584b917af1d5dd4753d91bc3ab54f13dcfb841cb5d939';
export const P68R_LABELS_SHA256 = '35bbda7cc2d25737d83f5536fc6cef43e258fbacfb2721d2c5f003de7c85bccd';

/** Složka se zapečetěnou sadou mimo repo (`P68R_SEALED_DIR` přepíše cestu, např. pro zálohu na `F:`). */
export const SEALED_DIR = process.env.P68R_SEALED_DIR ?? 'D:/caches/p68r/sealed';
export const HOLDOUT_PATH = join(SEALED_DIR, 'holdout.json');
export const LABELS_PATH = join(SEALED_DIR, 'holdout-labels.json');

/** Sady po P68 (cesty od `evals/play`), na kterých se ladí nebo které někdo otevřel. */
const LATER_SETS = ['p68/holdout.json'] as const;

/** Sady vět mimo zapečetěnou P68R, se kterými nesmí sdílet větu: seznam P68 a `LATER_SETS`. */
export const knownSets = (): string[] => [...new Set([...p68KnownSets(), ...LATER_SETS])].filter((set) => textsOf(set).length > 0);

/** Je zapečetěná sada na tomto stroji? (Jinde test pečeti hlídá jen seznam známých sad.) */
export const holdoutPresent = (): boolean => existsSync(HOLDOUT_PATH);
