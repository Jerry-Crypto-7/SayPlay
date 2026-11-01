/**
 * Minigolf (P68, kategorie `vozidla-sport`): dráhy s překážkami, míček, jamka; úder = nabití a puštění
 * (vstup hodu `throw-rig`), počet úderů = počet odpalů.
 *
 * Kostra z P68-I T1: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Kategorie přepíše jen tenhle soubor a `minigolf-bot.ts`;
 * jména kusů (`minigolf`, `minigolf_course`, `minigolf_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const minigolfControl = controlStub('minigolf');
export const minigolfCourse = modeStub('minigolf_course', 'minigolf', 'minigolf_bot');
export const MINIGOLF_RULES: Readonly<Record<string, RulePiece>> = {};
