/**
 * Střelba jako akce hrdiny (P46A T4): nepřátelé, blaster a zásah přebírá
 * doplněk `+shoot` (`shootAddon`), akce jen přidá sloveso `shoot` k zásahu.
 * Spoušť z tlačítka akce zapisuje obal ovládání (`abilityButton`).
 * Chytání (P52 T7b): kořist je nepřítel, kterého střela nesebere (`spare`);
 * střílí se na včely na cestě k ní (`catchBees`), které hrdinu vrátí na start.
 */

import { type ArcadeParts, shootAddon } from '../addons';
import { type PieceRef, mapUnderlying, nativeRule } from '../contract';
import { arenaCatchContact, catchBees } from '../pieces/arena-catch';
import type { AbilityPiece } from './index';

/** Index kořisti chytání, nebo `undefined` mimo chytání. Robot akcí podle něj na kořist nestřílí. */
export const catchPreyOf = (parts: Pick<ArcadeParts, 'rules'>): number | undefined => nativeRule(parts.rules, arenaCatchContact.id)?.params.prey as number | undefined;

function withBees(parts: ArcadeParts): ArcadeParts {
  const contact = nativeRule(parts.rules, arenaCatchContact.id)!;
  const { startX, startZ } = contact.params as { readonly startX: number; readonly startZ: number };
  const sting = (native: PieceRef): PieceRef => (native.id === arenaCatchContact.id ? { ...native, params: { ...native.params, stings: true } } : native);
  return { ...parts, level: { ...parts.level, bodies: [...parts.level.bodies, ...catchBees(startX, startZ)] }, rules: parts.rules.map((rule) => mapUnderlying(rule, sting)) };
}

export const shootAbility: AbilityPiece = {
  id: 'shoot',
  apply: (parts, context) => {
    const prey = catchPreyOf(parts);
    const aimed = prey === undefined ? parts : withBees(parts);
    // Doplněk `+shoot` už blaster dal: akce ho jen převezme na své tlačítko.
    const armed = aimed.rules.some((rule) => rule.id === 'blaster') ? aimed : (shootAddon.apply?.(aimed, {}, context) ?? aimed);
    const verb = { verb: 'shoot', ...(prey === undefined ? {} : { spare: prey }) };
    return { ...armed, rules: armed.rules.map((rule) => (rule.id === 'shot_hit' || rule.id === 'glide_shot_hit' ? { id: rule.id, params: { ...rule.params, ...verb } } : rule)) };
  },
};
