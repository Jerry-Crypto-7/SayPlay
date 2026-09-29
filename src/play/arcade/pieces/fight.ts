/**
 * Souboj – režim `arena.fight` (pahýl P32-0 T4, naplní P32E T3).
 *
 * Registrace je hotová: `fightArena` je generátor režimu `fight`, `fightControl`
 * ovládání a `FIGHT_RULES` pravidla v `ARCADE_LIBRARY`. Úder čte vstupní bit
 * `BUTTON.ATTACK`, zásah vydá efekt `hit` a HP drží `flags` těla (`bodyHp`).
 * Dokud je to pahýl, generátor úroveň odmítne a ovládání ani pravidla nic nedělají.
 */

import { z } from 'zod';

import type { ControlPiece, RulePiece } from '../contract';
import { modeStub } from './mode-stub';

export const fightArena = modeStub('fight');

export const fightControl: ControlPiece<Readonly<Record<string, unknown>>> = {
  id: 'fight',
  params: z.record(z.string(), z.unknown()),
  roles: ['player'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: () => undefined,
};

/** Pravidla souboje (chování nepřítele, výhra a prohra) – `library.ts` je rozbalí do `rules`. */
export const FIGHT_RULES: Readonly<Record<string, RulePiece>> = {};
