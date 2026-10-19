/**
 * Žánr Vytlačování z ringu (P54C): hrdina výpadem vytlačí soupeře z kulatého ringu (ovládání `push`).
 * Kostra z T4 – hraje až po úloze žánru (T12).
 */

import { stagedGenre } from './contract';

export const pushGenre = stagedGenre('push', ['animal', 'humanoid', 'robot', 'monster', 'vehicle'], { rivals: { min: 1, max: 8 } });
