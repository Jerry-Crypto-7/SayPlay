/**
 * Žánr Obrana pruhů (P54C): vlny nepřátel jdou pěti pruhy k hradu a hrdina je zastaví (ovládání `lanes`).
 * Kostra z T4 – hraje až po úloze žánru (T7).
 */

import { stagedGenre } from './contract';

export const defenseGenre = stagedGenre('defense', ['humanoid', 'robot', 'animal', 'monster', 'vehicle'], { enemies: { min: 10, max: 80 } });
