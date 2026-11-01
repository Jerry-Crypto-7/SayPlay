/**
 * Směna se stavbou obchodu (P68, kategorie `stavba`): mřížka obchodu, stanice na buňkách (klepnutí s buňkou v ose,
 * `cellAxisAt` jako šipky), zdroj, zákazníci a cíl směny.
 *
 * Kostra z P68-I T1: ovládání, generátor a pravidla jsou registrované v `library.ts`, ale nic nedělají a svět nevznikne
 * (`modeStub`), takže hra s nimi neprojde publikační branou. Kategorie přepíše jen tenhle soubor a `buildshift-bot.ts`;
 * jména kusů (`buildshift`, `buildshift_shop`, `buildshift_bot`) zůstávají.
 */

import type { RulePiece } from '../contract';
import { controlStub, modeStub } from './mode-stub';

export const buildshiftControl = controlStub('buildshift');
export const buildshiftShop = modeStub('buildshift_shop', 'buildshift', 'buildshift_bot');
export const BUILDSHIFT_RULES: Readonly<Record<string, RulePiece>> = {};
