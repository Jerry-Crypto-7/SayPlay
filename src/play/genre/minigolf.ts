/**
 * Žánr Minigolf (P68, kategorie `vozidla-sport`): míček odpálený nabitím a puštěním (vstup hodu `throw-rig`) do
 * jamky na dráhách s překážkami z věty, pohled přes rameno nebo shora (`shoulder`, `top`); počet úderů je počet
 * odpalů (ovládání `minigolf`, generátor `minigolf_course` v `arcade/pieces/minigolf.ts`).
 * Kostra z P68-I T1 – hraje až po řezu kategorie a úloze „zapoj minigolf“ (P68-I T9).
 */

import { stagedGenre } from './contract';

export const minigolfGenre = stagedGenre('minigolf', ['prop', 'animal', 'humanoid', 'robot']);
