/**
 * Kresli a zachraň (P68, kategorie `stavba`, volitelný): tah přes buňky mřížky (`DRAWSAVE_STROKE`, `p68-contract.ts`)
 * postaví těla zdi, chráněné tělo z věty musí přežít hrozby do konce.
 * Vlastní dotykový adaptér (`genres/drawsave/DrawsaveTouch.tsx`) posílá buňku v ose a drží `HOLD` po dobu tahu.
 *
 * Kostra z P68-I T1: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Kategorie přepíše jen tenhle soubor a `drawsave-bot.ts`;
 * jména kusů (`drawsave`, `drawsave_level`, `drawsave_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const drawsaveControl = controlStub('drawsave');
export const drawsaveLevel = modeStub('drawsave_level', 'drawsave', 'drawsave_bot');
export const DRAWSAVE_RULES: Readonly<Record<string, RulePiece>> = {};
