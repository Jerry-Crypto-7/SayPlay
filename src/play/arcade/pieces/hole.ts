/**
 * Díra (P66): hráč táhne díru joystickem, věci z věty menší než díra do ní spadnou a díra roste po stupních.
 *
 * Kostra z T2: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Úloha žánru (T6) přepíše jen tenhle soubor
 * a `hole-bot.ts`; jména kusů (`hole`, `hole_swallow`, `hole_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const holeControl = controlStub('hole');
export const holeSwallow = modeStub('hole_swallow', 'hole', 'hole_bot');
export const HOLE_RULES: Readonly<Record<string, RulePiece>> = {};
