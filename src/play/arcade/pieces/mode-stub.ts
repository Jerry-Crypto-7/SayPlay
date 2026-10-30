/**
 * Pahýl generátoru režimu (P32-0 T4): registrace je hotová, tělo ne. Stopy
 * P32E–G ho ve svém souboru nahradí skutečným generátorem pod stejným jménem.
 * Dokud je to pahýl, úroveň odmítne: `parts` vrátí hlášku a svět se nestaví.
 *
 * Kostry žánrů P66 (T2) mají pod pahýlem i vlastní ovládání a robota (`controlStub`, `botStub`), aby registrace
 * v `library.ts` byla hotová a úloha žánru (T5–T9) přepsala jen své soubory.
 */

import { z } from 'zod';

import { type BotPiece, type ControlPiece, type ModeGeneratorPiece, NO_INPUT } from '../contract';

/** Pahýl bere jakékoli parametry – svoje schéma dostane režim, až se postaví. */
const anyParams = z.record(z.string(), z.unknown());
type AnyParams = Readonly<Record<string, unknown>>;

export const modeNotBuilt = (id: string): string => `generator: the ${id} mode is not built yet`;

/** `control` a `bot` = kusy, které režim vydá, až se postaví; bez nich pohyb a robot arény. */
export function modeStub(id: string, control = 'move_free', bot = 'arena_bot'): ModeGeneratorPiece<AnyParams> {
  return {
    id,
    params: anyParams,
    roles: ['player'],
    cost: () => ({ bodies: 0, rules: 0 }),
    generate: () => ({ bodies: [], length: 0 }),
    parts: () => ({
      control: { id: control, params: {} },
      bot: { id: bot, params: {} },
      level: { bodies: [], length: 0 },
      rules: [],
      issues: [modeNotBuilt(id)],
    }),
  };
}

/** Ovládání kostry: hráčem nehýbe – svět s ním nikdy nevznikne, pahýl režimu ho odmítne dřív. */
export function controlStub(id: string): ControlPiece<AnyParams> {
  return { id, params: anyParams, roles: ['player'], cost: () => ({ bodies: 0, rules: 0 }), step: () => undefined };
}

/** Robot kostry: nemačká nic. Reakce 8 tiků jako každý robot knihovny – s tolika počítá obal `addon_bot`. */
export function botStub(id: string): BotPiece<AnyParams> {
  return { id, params: anyParams, roles: ['player'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT };
}
