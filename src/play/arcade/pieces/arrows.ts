/**
 * Šipky (P66): mřížka kusů z věty se šipkami směru; klepnutý kus odletí, má-li ve směru šipky volnou cestu ven,
 * jinak narazí a hráč ztratí srdce. Ťuk nese buňku v ose záznamu (`cellOfAxis` v `lanes.ts`, plátno ji spočítá
 * z `data-lane-cells` – `cellAxisAt`), takže hra nepotřebuje nový vstup.
 *
 * Kostra z T2: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Úloha žánru (T9) přepíše jen tenhle soubor
 * a `arrows-bot.ts`; jména kusů (`arrows`, `arrows_grid`, `arrows_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const arrowsControl = controlStub('arrows');
export const arrowsGrid = modeStub('arrows_grid', 'arrows', 'arrows_bot');
export const ARROWS_RULES: Readonly<Record<string, RulePiece>> = {};
