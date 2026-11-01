/**
 * Žánr Kresli a zachraň (P68, kategorie `stavba`, volitelný): hráč tahem prstu nakreslí zeď (posloupnost buněk
 * mřížky v ose s `HOLD` po dobu tahu, `DRAWSAVE_STROKE` v `p68-contract.ts`), z tahu vzniknou těla zdi a chráněná
 * postava z věty musí přežít hrozby do konce; pohled z boku (`side`) (ovládání `drawsave`, vlastní dotykový adaptér
 * `genres/drawsave/DrawsaveTouch.tsx`, generátor `drawsave_level` v `arcade/pieces/drawsave.ts`).
 * Kostra z P68-I T1 – hraje až po řezu kategorie a úloze „zapoj drawsave“ (P68-I T12).
 */

import { stagedGenre } from './contract';

export const drawsaveGenre = stagedGenre('drawsave', ['animal', 'humanoid', 'prop', 'robot'], { threats: { min: 1, max: 30 } });
