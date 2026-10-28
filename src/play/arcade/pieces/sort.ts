/**
 * Třídění (P66): fronty věcí z věty nahoře, nádoby dole; ťuk do sloupce fronty (vstup pruhů, `laneOfAxis`) pošle
 * její čelo do nádoby téhož druhu nebo barvy, jinak do odkladiště s omezeným místem.
 *
 * Kostra z T2: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Úloha žánru (T8) přepíše jen tenhle soubor
 * a `sort-bot.ts`; jména kusů (`sort`, `sort_bins`, `sort_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const sortControl = controlStub('sort');
export const sortBins = modeStub('sort_bins', 'sort', 'sort_bot');
export const SORT_RULES: Readonly<Record<string, RulePiece>> = {};
