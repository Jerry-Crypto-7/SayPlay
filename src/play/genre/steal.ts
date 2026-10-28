/**
 * Žánr Krádež (P66): hrdina doběhne k cizí základně, popadne věc z věty a odnese ji na svou, strážci ho honí
 * a při dotyku věc vezmou zpět (ovládání `steal`, generátor `steal_bases` v `arcade/pieces/steal.ts`).
 * Kostra z T2 – hraje až po úloze žánru (T7).
 */

import { stagedGenre } from './contract';

export const stealGenre = stagedGenre('steal', ['humanoid', 'animal', 'robot', 'monster'], { loot: { min: 3, max: 20 }, guards: { min: 1, max: 8 } });
