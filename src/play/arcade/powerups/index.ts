/**
 * Power-upy (P46C): magnet, štít, zrychlení a 2×. Těleso role `powerup` sebere pravidlo
 * `pickup` (parametr `powerup`) a počítadlo si zapíše časovaný stav (`POWERUP_SLOTS`) –
 * mění hru, takže je v hashi. Odpočet, magnet a zrychlení dělá obal ovládání
 * (`state.ts`), štít sdílí náboj i blok s akcí štítu, 2× násobí body vedle komba.
 * Svět bez power-upů nic z toho nemá a jeho hash se nepohne.
 */

import { shieldParts } from '../abilities';
import { type ArcadeParts, wrapControl } from '../addons';
import { type BodyInit, type PieceRef, type PowerupId, UNIT } from '../contract';
import type { SpeedParams } from './speed';

export { scoreFactor } from './double';
export { MAGNET } from './magnet';
export type { SpeedParams } from './speed';

/** Power-up na místě úrovně (střed spodní stěny). */
export interface PlacedPowerup {
  readonly id: PowerupId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Šířka a hloubka podložky (řízení: jako turbo); výchozí `POWERUP_SIZE`. */
  readonly size?: number;
}

/** Krychle, kterou hrdina sebere průchodem; `kind` vybírá model scény. */
export const POWERUP_SIZE = Math.round(0.8 * UNIT);
export const powerupKind = (id: PowerupId): string => `powerup_${id}`;

/** Počítadlo akcí, když svět akce má (`applyAbilities` obalí ovládání jako poslední). */
const abilityKeeperOf = (control: PieceRef): number | undefined =>
  control.id === 'addon_control' ? (control.params as { readonly abilities?: { readonly keeper: number } }).abilities?.keeper : undefined;

/**
 * Přidá power-upy `placed` do hotových částí hry, po akcích hrdiny. Stav nese počítadlo
 * akcí, svět bez akcí dostane stejné mrtvé tělo-počítadlo jen pro ně. Sebrání jde přes
 * `pickup`; svět, kde věci sbírá jiné pravidlo, dostane `pickup`, který sbírá jen power-upy.
 */
export function applyPowerups(parts: ArcadeParts, placed: readonly PlacedPowerup[], speed?: SpeedParams): ArcadeParts {
  if (placed.length === 0) return parts;
  const own = abilityKeeperOf(parts.control);
  const bodies = [...parts.level.bodies];
  let keeper = own;
  if (keeper === undefined) {
    keeper = bodies.length;
    const hero = bodies[0] as BodyInit;
    bodies.push({ role: 'thing', kind: hero.kind, x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true });
  }
  const at: [number, PowerupId][] = placed.map((item) => {
    const size = item.size ?? POWERUP_SIZE;
    bodies.push({ role: 'powerup', kind: powerupKind(item.id), x: item.x, y: item.y, z: item.z, w: size, h: POWERUP_SIZE, d: size, solid: false });
    return [bodies.length - 1, item.id];
  });
  const powerup = { keeper, at };
  const index = parts.rules.findIndex((rule) => rule.id === 'pickup');
  const rules =
    index < 0
      ? [...parts.rules, { id: 'pickup', params: { items: false, powerup } }]
      : parts.rules.map((rule, i) => (i === index ? { id: rule.id, params: { ...rule.params, powerup } } : rule));
  let next: ArcadeParts = { ...parts, level: { ...parts.level, bodies }, rules };
  if (placed.some((item) => item.id === 'shield')) next = shieldParts(next, keeper);
  return { ...next, control: wrapControl(next, { powerups: { keeper, ...(speed === undefined ? {} : { speed }) } }) };
}
