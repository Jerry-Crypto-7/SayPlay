/**
 * Žánr Pouštění a slučování (P54C): předměty padají do nádoby a dva stejné se sloučí ve větší (ovládání `merge`).
 * Kostra z T4 – hraje až po úloze žánru (T11).
 */

import { stagedGenre } from './contract';

export const mergeGenre = stagedGenre('merge', ['prop', 'animal', 'humanoid', 'robot', 'monster']);
