/**
 * Žánr Chytání (P54C): věci padají v pěti pruzích a hrdina je chytá (ovládání `lanes`).
 * Kostra z T4 – hraje až po úloze žánru (T5).
 */

import { stagedGenre } from './contract';

export const catchGenre = stagedGenre('catch', ['animal', 'humanoid', 'robot', 'monster', 'vehicle'], { items: { min: 10, max: 60 } });
