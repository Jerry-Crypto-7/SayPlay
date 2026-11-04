/**
 * Pečeť zapečetěné sady P68T (T1): 90 vět (15 na `railfps`, `buildshift`, `drawsave`, 15 na `minigolf` jako hlídání,
 * 30 obecných přes ≥ 10 dosavadních žánrů) a jejich slepé štítky, zapečetěné před první změnou směrování v P68T;
 * otevře je jednou T3. Sada P68R je od T6 otevřená a P68T na ní ladí, proto je mezi známými sadami. Sada i štítky leží
 * mimo repo v `SEALED_DIR`, v repu jsou jen otisky; logika pečeti je P55 (`openSealedOnce`, `sha256Lf` nad LF bajty).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { knownSets as p68rKnownSets, textsOf } from '../p68r/seal';

export { openSealedOnce, sha256Lf } from '../p55/seal';
export { textsOf } from '../p68/seal';

/** SHA-256 nad LF bajty `holdout.json` a `holdout-labels.json`, zapsané v README při zapečetění. */
export const P68T_HOLDOUT_SHA256 = 'a3875ef969fb76eee7edf1625e1f5996fe7b1d716ef678fff02d38093e5c6935';
export const P68T_LABELS_SHA256 = 'a469a4e7b4e125c3fccc4dd5cf202a3f27826c2fb4e72a603177f9573c101186';

/** Složka se zapečetěnou sadou mimo repo (`P68T_SEALED_DIR` přepíše cestu, např. pro zálohu na `F:`). */
export const SEALED_DIR = process.env.P68T_SEALED_DIR ?? 'D:/caches/p68t/sealed';
export const HOLDOUT_PATH = join(SEALED_DIR, 'holdout.json');
export const LABELS_PATH = join(SEALED_DIR, 'holdout-labels.json');

/** Sady po P68R (cesty od `evals/play`), na kterých se ladí nebo které někdo otevřel. */
const LATER_SETS = ['p68r/holdout.json'] as const;

/** Sady vět mimo zapečetěnou P68T, se kterými nesmí sdílet větu: seznam P68R a `LATER_SETS`. */
export const knownSets = (): string[] => [...new Set([...p68rKnownSets(), ...LATER_SETS])].filter((set) => textsOf(set).length > 0);

/** Je zapečetěná sada na tomto stroji? (Jinde test pečeti hlídá jen seznam známých sad.) */
export const holdoutPresent = (): boolean => existsSync(HOLDOUT_PATH);
