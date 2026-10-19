/**
 * Žánr Dav a brány (P54C): dav běží tratí, brány ho násobí a překážky ubírají (ovládání `crowd`).
 * Kostra z T4 – hraje až po úloze žánru (T10).
 */

import { stagedGenre } from './contract';

export const crowdGenre = stagedGenre('crowd', ['humanoid', 'animal', 'robot', 'monster']);
