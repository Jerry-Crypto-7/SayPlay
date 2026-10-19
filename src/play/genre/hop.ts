/**
 * Žánr Přeskákání silnice (P54C): hrdina skáče po polích přes silnice, vodu a koleje (ovládání `hop`).
 * Kostra z T4 – hraje až po úloze žánru (T9).
 */

import { stagedGenre } from './contract';

export const hopGenre = stagedGenre('hop', ['animal', 'bird', 'humanoid', 'robot', 'monster']);
