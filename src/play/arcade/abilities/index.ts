/**
 * Akce hrdiny (P46A): nejvýš dvě na hru, první na tlačítku A, druhá na B.
 * Každá akce je dílek ve vzoru doplňků (`AddonPiece`): `apply` přidá do úrovně
 * nepřátele a pravidla. Stav akcí (cooldown, aktivní okno) drží tělo-počítadlo
 * `abilityKeeper` za tělesy úrovně a píše ho obal ovládání (`state.ts`).
 * Svět bez `abilities` tělo ani obal nedostane, takže jeho hash se nepohne.
 *
 * Rozhraní (`AbilityPiece`, `applyAbilities`, `ABILITY_SLOTS`) je zmrazené
 * tagem `p46a-api`; staví na něm power-upy P46C a režisér P46E.
 */

import type { AbilityId, BodyInit } from '../contract';
import { type AddonContext, type ArcadeParts, baseControlOf, enemiesFor, hitParamsFor, wrapControl } from '../addons';
import { shootAbility } from './shoot';
import { strikeRule } from './strike';

export interface AbilityContext extends AddonContext {
  /** Index těla-počítadla `abilityKeeper`. */
  readonly keeper: number;
  /** Tlačítko akce: 0 = A, 1 = B. */
  readonly slot: number;
}

export interface AbilityPiece {
  readonly id: AbilityId;
  apply(parts: ArcadeParts, context: AbilityContext): ArcadeParts;
}

/** Je v úrovni koho udeřit? Bez nepřátel a pronásledovatele je akce dá jako `+shoot`. */
function withFoes(parts: ArcadeParts, context: AddonContext): ArcadeParts {
  if (parts.level.bodies.some((body) => body.role === 'enemy' || body.role === 'chaser')) return parts;
  const foes = enemiesFor(baseControlOf(parts.control).id, parts.level);
  if (foes.length === 0) return { ...parts, issues: [...(parts.issues ?? []), 'abilities: the level has no place for an enemy to strike'] };
  return {
    ...parts,
    level: { ...parts.level, bodies: [...parts.level.bodies, ...foes] },
    rules: [...parts.rules, { id: 'hit', params: hitParamsFor('enemy', context.health) }],
  };
}

export const strikeAbility: AbilityPiece = {
  id: 'strike',
  apply: (parts, context) => {
    const armed = withFoes(parts, context);
    return { ...armed, rules: [...armed.rules, { id: strikeRule.id, params: { keeper: context.keeper, slot: context.slot, verb: 'strike' } }] };
  },
};

export const ABILITY_PIECES: Readonly<Partial<Record<AbilityId, AbilityPiece>>> = {
  shoot: shootAbility,
  strike: strikeAbility,
};

export const ABILITY_RULES = { [strikeRule.id]: strikeRule } as const;

/**
 * Aplikuje akce ze `spec.abilities`: tělo-počítadlo za tělesy úrovně, dílky
 * akcí a obal ovládání. Střelba jde první bez ohledu na pořadí tlačítek –
 * přidá nepřátele, které pak úder najde a znovu je nepřidá.
 */
export function applyAbilities(parts: ArcadeParts, context: AddonContext): ArcadeParts {
  const ids = context.spec.abilities ?? [];
  if (ids.length === 0) return parts;
  const keeper = parts.level.bodies.length;
  const hero = parts.level.bodies[0] as BodyInit;
  // Mrtvá předloha jako počítadlo komba: nic ji nekreslí ani nesrazí.
  const counter: BodyInit = { role: 'thing', kind: hero.kind, x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  let next: ArcadeParts = { ...parts, level: { ...parts.level, bodies: [...parts.level.bodies, counter] } };
  const order = [...ids].sort((a, b) => Number(b === 'shoot') - Number(a === 'shoot'));
  for (const id of order) {
    const piece = ABILITY_PIECES[id];
    if (piece !== undefined) next = piece.apply(next, { ...context, keeper, slot: ids.indexOf(id) });
  }
  return { ...next, control: wrapControl(next, { abilities: { keeper, ids: [...ids] } }) };
}
