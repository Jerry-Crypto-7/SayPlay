/**
 * Střelba jako akce hrdiny (P46A T4): nepřátelé, blaster a zásah přebírá
 * doplněk `+shoot` (`shootAddon`), akce jen přidá sloveso `shoot` k zásahu.
 * Spoušť z tlačítka akce zapisuje obal ovládání (`abilityButton`).
 */

import { shootAddon } from '../addons';
import type { AbilityPiece } from './index';

export const shootAbility: AbilityPiece = {
  id: 'shoot',
  apply: (parts, context) => {
    // Doplněk `+shoot` už blaster dal: akce ho jen převezme na své tlačítko.
    const armed = parts.rules.some((rule) => rule.id === 'blaster') ? parts : (shootAddon.apply?.(parts, {}, context) ?? parts);
    return { ...armed, rules: armed.rules.map((rule) => (rule.id === 'shot_hit' ? { id: rule.id, params: { ...rule.params, verb: 'shoot' } } : rule)) };
  },
};
