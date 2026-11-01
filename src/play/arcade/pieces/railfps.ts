/**
 * Střelnice z očí na kolejích (P68, kategorie `prvni-osoba`): jízda po kolejích, terče z věty, natočení jednou
 * kvantovanou osou (`yawStep` v `RAILFPS_SLOTS` na držáku `RAILFPS_KEEPER_ROLE`, `p68-contract.ts`), `FIRE` střílí.
 * Vlastní dotykový adaptér (`genres/railfps/RailfpsTouch.tsx`) posílá jen hodnoty `RAILFPS_AXES`.
 *
 * Kostra z P68-I T1: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Kategorie přepíše jen tenhle soubor a `railfps-bot.ts`;
 * jména kusů (`railfps`, `railfps_rail`, `railfps_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const railfpsControl = controlStub('railfps');
export const railfpsRail = modeStub('railfps_rail', 'railfps', 'railfps_bot');
export const RAILFPS_RULES: Readonly<Record<string, RulePiece>> = {};
