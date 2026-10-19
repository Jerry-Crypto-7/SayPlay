/**
 * Žánr Bouchání (P54C): cíle vyskakují z pěti děr a hrdina je bouchá (ovládání `lanes`).
 * Kostra z T4 – hraje až po úloze žánru (T6).
 */

import { stagedGenre } from './contract';

export const whackGenre = stagedGenre('whack', ['animal', 'humanoid', 'robot', 'monster'], { targets: { min: 10, max: 60 } });
