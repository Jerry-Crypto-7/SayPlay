/**
 * Žánr Třídění (P66): nahoře fronty věcí z věty, dole nádoby; klepnutí na frontu pošle její čelo do nádoby téhož
 * druhu nebo barvy, jinak do odkladiště s omezeným místem (ovládání `sort`, vstup pruhů – sloupec je fronta,
 * generátor `sort_bins` v `arcade/pieces/sort.ts`).
 * Kostra z T2 – hraje až po úloze žánru (T8).
 */

import { stagedGenre } from './contract';

export const sortGenre = stagedGenre('sort', ['humanoid', 'animal', 'robot', 'monster', 'prop'], { items: { min: 6, max: 60 } });
