/**
 * Žánr Šipky (P66): mřížka kusů z věty, každý se šipkou směru; klepnutý kus odletí, když má ve směru šipky volnou
 * cestu ven, jinak narazí a hráč ztratí srdce (ovládání `arrows`, vstup pruhů s buňkou v ose – `cellAxisAt`,
 * generátor `arrows_grid` v `arcade/pieces/arrows.ts`).
 * Kostra z T2 – hraje až po úloze žánru (T9).
 */

import { stagedGenre } from './contract';

export const arrowsGenre = stagedGenre('arrows', ['vehicle', 'animal', 'prop', 'humanoid', 'robot', 'monster']);
