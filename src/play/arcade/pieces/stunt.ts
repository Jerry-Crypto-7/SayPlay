/**
 * Závod s triky (P68, kategorie `vozidla-sport`): trať se skoky a rampami, trosky po nárazu (nejvýš
 * `STUNT_DEBRIS_MAX` těl), cílová čára. Vstup náklonu `steer`.
 *
 * Kostra z P68-I T1: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Kategorie přepíše jen tenhle soubor a `stunt-bot.ts`;
 * jména kusů (`stunt`, `stunt_track`, `stunt_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const stuntControl = controlStub('stunt');
export const stuntTrack = modeStub('stunt_track', 'stunt', 'stunt_bot');
export const STUNT_RULES: Readonly<Record<string, RulePiece>> = {};
