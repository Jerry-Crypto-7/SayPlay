/**
 * Žánr Díra (P66): hráč táhne díru joystickem po místě z věty, věci menší než díra do ní spadnou a díra roste
 * (ovládání `hole`, generátor `hole_swallow` v `arcade/pieces/hole.ts`).
 * Kostra z T2 – hraje až po úloze žánru (T6).
 */

import { stagedGenre } from './contract';

export const holeGenre = stagedGenre('hole', ['prop', 'monster', 'animal', 'vehicle', 'robot', 'humanoid'], { items: { min: 10, max: 120 } });
