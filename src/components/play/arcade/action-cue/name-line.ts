/**
 * Popisek jména (P58A T5): hrdina a nejbližší protivník/věc dostanou při prvním
 * objevení na 1,5 s své jméno, ať divák pozná, co je co, i když model jen
 * připomíná („crocodile“ kreslený ještěrkou nebo robotem). Jméno je slovo
 * z věty (popisek role), nikdy id modelu. Obě těla stojí ve scéně od začátku
 * běhu, takže „první objevení“ je začátek hry: jména jdou po řádku se slovesem,
 * jedno za druhým, aby se štítky nepřekryly.
 *
 * Štítek visí nad tělem, které jmenuje (`NameAnchor` ve stage): scéna značí těla slotem
 * (`userData.item` – `enemy`, `chaser`, `coin`, `rival`…), a jméno slotu je popisek role,
 * ze které scéna model toho slotu bere. Štítek nad psem tak nemůže říct „Fish“.
 */

import { chaserName, enemyLabel } from '@/play/arcade/models';
import type { GameSpecV1 } from '@/play/spec';

import { VERB_LINE_SECONDS } from './verb-line';

/** Jak dlouho visí jedno jméno. */
export const NAME_LINE_SECONDS = 1.5;

export type NameSlot = 'hero' | 'foe';

export interface Names {
  /** Jméno hrdiny, nebo `null`, když věta hrdinu nejmenuje. */
  readonly hero: string | null;
  /** Slot těla ve scéně (`userData.item`) → jméno z věty; slot bez jména tu není. */
  readonly bodies: Readonly<Record<string, string>>;
}

const capital = (label: string | undefined): string | undefined => {
  const name = label?.trim() ?? '';
  return name === '' ? undefined : name.charAt(0).toUpperCase() + name.slice(1);
};

export function nameLines(spec: GameSpecV1): Names {
  const roles = spec.roles ?? [];
  const bodies: Record<string, string> = {};
  const put = (slot: string, label: string | undefined) => {
    const name = capital(label);
    if (name !== undefined) bodies[slot] = name;
  };
  for (const role of roles) if (role.kind !== 'player' && role.kind !== 'exit') put(role.id, role.label);
  // Sloty, které scéna kreslí modelem jiné role (`enemyModel`, `chaserModel`, mince z `namedProps`, boss režiséra).
  put('enemy', enemyLabel(spec));
  const chaser = chaserName(spec);
  put('chaser', chaser);
  put('foe', chaser);
  put('boss', spec.boss?.name);
  const generator = typeof spec.controlParams?.generator === 'string';
  put('coin', (roles.find((role) => role.id === 'coin') ?? (generator ? roles.find((role) => role.kind === 'collectible') : undefined))?.label);
  if (spec.control === 'glide') put('rival', roles.find((role) => role.id === 'glide_rival')?.label);
  return { hero: capital(roles.find((role) => role.kind === 'player')?.label) ?? null, bodies };
}

/**
 * Který štítek visí na tiku `tick`, nebo `null`. Jen v běhu hráče (jako řádek se slovesem); začíná, když
 * řádek se slovesem zmizí, a bez něj po prvním tahu – tik 0 patří výzvě „Tap to start“.
 */
export function nameSlotAt(tick: number, hz: number, playerRun: boolean, verbLine: boolean): NameSlot | null {
  if (!playerRun) return null;
  const start = verbLine ? VERB_LINE_SECONDS * hz : 1;
  const slot = Math.floor((tick - start) / (NAME_LINE_SECONDS * hz));
  return tick < start ? null : slot === 0 ? 'hero' : slot === 1 ? 'foe' : null;
}
