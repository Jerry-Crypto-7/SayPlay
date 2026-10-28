/**
 * Přežití ve vlnách (P66): hrdina se hýbe joystickem, střílí sám na nejbližšího nepřítele, vlny přicházejí z okrajů,
 * mezi vlnami výběr vylepšení (háčky `arcade/hooks`), poslední vlna je boss.
 *
 * Kostra z T2: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Úloha žánru (T5) přepíše jen tenhle soubor
 * a `survivor-bot.ts`; jména kusů (`survivor`, `survivor_waves`, `survivor_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const survivorControl = controlStub('survivor');
export const survivorWaves = modeStub('survivor_waves', 'survivor', 'survivor_bot');
export const SURVIVOR_RULES: Readonly<Record<string, RulePiece>> = {};
