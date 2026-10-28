/**
 * Krádež (P66): hráč doběhne k cizí základně, popadne kořist z věty, odnese ji na svou; strážci honí a při dotyku
 * kořist vezmou zpět, mezi koly výběr vylepšení (háčky `arcade/hooks`).
 *
 * Kostra z T2: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Úloha žánru (T7) přepíše jen tenhle soubor
 * a `steal-bot.ts`; jména kusů (`steal`, `steal_bases`, `steal_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const stealControl = controlStub('steal');
export const stealBases = modeStub('steal_bases', 'steal', 'steal_bot');
export const STEAL_RULES: Readonly<Record<string, RulePiece>> = {};
