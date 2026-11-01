/**
 * Žánr Směna se stavbou obchodu (P68, kategorie `stavba`): hráč staví stanice obchodu z věty na buňkách mřížky
 * (klepnutí, buňka v ose jako šipky – vstup `lanes`, `cellAxisAt`), stavba ubírá zdroj, obsloužení zákazníci plní
 * cíl směny; pohled shora (`top`) (ovládání `buildshift`, generátor `buildshift_shop` v `arcade/pieces/buildshift.ts`).
 * Kostra z P68-I T1 – hraje až po řezu kategorie a úloze „zapoj buildshift“ (P68-I T11).
 */

import { stagedGenre } from './contract';

export const buildshiftGenre = stagedGenre('buildshift', ['humanoid', 'animal', 'robot']);
