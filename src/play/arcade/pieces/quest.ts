/**
 * Úkol – režimy `quest.spatial` a `quest.station` (pahýly P32-0 T4, naplní P32G T2).
 *
 * Oba generátory jsou registrované v `MODE_GENERATORS`; cíle mění stav pravidlem
 * `interact` (`rules/interact.ts`), stav 0..2 drží `flags` těla (`targetStateOf`).
 * Dokud jsou to pahýly, úroveň odmítnou.
 */

import { modeStub } from './mode-stub';

export const questSpatial = modeStub('quest_spatial');
export const questStation = modeStub('quest_station');
