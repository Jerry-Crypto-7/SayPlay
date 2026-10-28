/**
 * Žánr Přežití ve vlnách (P66): hrdina se hýbe joystickem a střílí sám na nejbližšího nepřítele, nepřátelé z věty
 * chodí ve vlnách, mezi vlnami hráč vybere 1 ze 3 vylepšení, poslední vlna je boss (ovládání `survivor`,
 * generátor `survivor_waves` v `arcade/pieces/survivor.ts`).
 * Kostra z T2 – hraje až po úloze žánru (T5).
 */

import { stagedGenre } from './contract';

export const survivorGenre = stagedGenre('survivor', ['humanoid', 'robot', 'animal', 'monster', 'vehicle'], { enemies: { min: 10, max: 120 } });
