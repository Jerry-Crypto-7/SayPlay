/**
 * Pahýl generátoru režimu (P32-0 T4): registrace je hotová, tělo ne. Stopy
 * P32E–G ho ve svém souboru nahradí skutečným generátorem pod stejným jménem.
 * Dokud je to pahýl, úroveň odmítne: `parts` vrátí hlášku a svět se nestaví.
 */

import { z } from 'zod';

import type { ModeGeneratorPiece } from '../contract';

/** Pahýl bere jakékoli parametry – svoje schéma dostane režim, až se postaví. */
const anyParams = z.record(z.string(), z.unknown());

export const modeNotBuilt = (id: string): string => `generator: the ${id} mode is not built yet`;

export function modeStub(id: string): ModeGeneratorPiece<Readonly<Record<string, unknown>>> {
  return {
    id,
    params: anyParams,
    roles: ['player'],
    cost: () => ({ bodies: 0, rules: 0 }),
    generate: () => ({ bodies: [], length: 0 }),
    parts: () => ({
      control: { id: 'move_free', params: {} },
      bot: { id: 'arena_bot', params: {} },
      level: { bodies: [], length: 0 },
      rules: [],
      issues: [modeNotBuilt(id)],
    }),
  };
}
