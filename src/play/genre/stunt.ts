/**
 * Žánr Závod s triky (P68, kategorie `vozidla-sport`): vozidlo z věty jede trať se skoky a rampami, kamera za ním
 * (`chase`), náraz rozhází trosky (nejvýš `STUNT_DEBRIS_MAX` těl, `p68-contract.ts`); vyhrává průjezd cílem do 90 s
 * (ovládání `stunt`, vstup náklonu `steer`, generátor `stunt_track` v `arcade/pieces/stunt.ts`).
 * Kostra z P68-I T1 – hraje až po řezu kategorie a úloze „zapoj stunt“ (P68-I T8).
 */

import { stagedGenre } from './contract';

export const stuntGenre = stagedGenre('stunt', ['vehicle', 'animal', 'humanoid', 'robot']);
