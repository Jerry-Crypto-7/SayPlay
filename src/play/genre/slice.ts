/**
 * Žánr Krájení (P54C): věci vylétají po obloucích a hrdina je švihem rozsekne (ovládání `lanes`).
 * Kostra z T4 – hraje až po úloze žánru (T8).
 */

import { stagedGenre } from './contract';

export const sliceGenre = stagedGenre('slice', ['humanoid', 'robot', 'animal', 'monster'], { items: { min: 10, max: 60 } });
