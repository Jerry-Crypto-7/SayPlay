/**
 * Žánr Střelnice z očí na kolejích (P68, kategorie `prvni-osoba`): hráč jede po kolejích pohledem z očí (`first`),
 * natáčí se jednou kvantovanou osou (`yawStep` −16..16, `RAILFPS_YAW_STEPS` v `p68-contract.ts`) a střílí terče
 * z věty; nečinný hráč přijde o životy (ovládání `railfps`, vlastní dotykový adaptér `genres/railfps/RailfpsTouch.tsx`,
 * generátor `railfps_rail` v `arcade/pieces/railfps.ts`).
 * Kostra z P68-I T1 – hraje až po řezu kategorie a úloze „zapoj railfps“ (P68-I T10).
 */

import { stagedGenre } from './contract';

export const railfpsGenre = stagedGenre('railfps', ['humanoid', 'robot', 'animal', 'monster'], { targets: { min: 3, max: 60 } });
