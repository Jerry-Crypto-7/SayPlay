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
import { type AddonContext, type ArcadeParts, baseControlOf, enemiesFor, hitParamsFor, wrapBot, wrapControl } from '../addons';
import { grabRule } from './grab';
import { dashRule, shieldRule } from './guard';
import { HARMFUL_ROLES } from './state';
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
  return parts.level.bodies.some((body) => body.role === 'enemy' || body.role === 'chaser') ? parts : addFoes(parts, context);
}

/** Nepřátelé ovládání a jejich náraz (`hit`). */
function addFoes(parts: ArcadeParts, context: AddonContext): ArcadeParts {
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

/** Krádež potřebuje co sebrat: věci úrovně stačí, bez nich nepřátelé jako u úderu. */
export const grabAbility: AbilityPiece = {
  id: 'grab',
  apply: (parts, context) => {
    const loot = parts.level.bodies.some((body) => body.role === 'collectible' && body.template !== true);
    const armed = loot ? parts : withFoes(parts, context);
    return { ...armed, rules: [...armed.rules, { id: grabRule.id, params: { keeper: context.keeper, slot: context.slot, verb: 'grab' } }] };
  },
};

/** Nárazy, které hrdinovi ublíží: `hit` a náraz do svodidel řízení. */
const isCrash = (id: string): boolean => id === 'hit' || id === 'steer_crash';

/** Role, které hrdinovi ublíží nárazem – ty dash prorazí a štít odrazí. */
const harmOf = (parts: ArcadeParts): (typeof HARMFUL_ROLES)[number][] =>
  HARMFUL_ROLES.filter((role) => parts.rules.some((rule) => (rule.id === 'hit' && rule.params.role === role) || (rule.id === 'steer_crash' && role === 'obstacle')));

/** Dash a štít: náraz dostane ochranu, pravidlo akce pohlcení provede. Úroveň bez nárazu dostane nepřátele jako u úderu. */
function guardAbility(id: 'dash' | 'shield'): AbilityPiece {
  return {
    id,
    apply: (start, context) => {
      // Soupeři řízení jsou `enemy` bez nárazu, proto nepřátele přidat i vedle nich (jako `+shoot`).
      const parts = harmOf(start).length === 0 ? addFoes(start, context) : start;
      const roles = harmOf(parts);
      if (roles.length === 0) return parts;
      const guard = id === 'dash' ? { dash: context.slot } : { shield: true };
      const rules = parts.rules.map((rule) =>
        isCrash(rule.id) ? { id: rule.id, params: { ...rule.params, guard: { ...((rule.params.guard as object | undefined) ?? {}), keeper: context.keeper, ...guard } } } : rule,
      );
      const own = id === 'dash' ? { id: dashRule.id, params: { keeper: context.keeper, slot: context.slot, roles, verb: 'dash' } } : { id: shieldRule.id, params: { keeper: context.keeper, roles, verb: 'shield' } };
      return { ...parts, rules: [...rules, own] };
    },
  };
}

export const ABILITY_PIECES: Readonly<Record<AbilityId, AbilityPiece>> = {
  shoot: shootAbility,
  strike: strikeAbility,
  grab: grabAbility,
  dash: guardAbility('dash'),
  shield: guardAbility('shield'),
};

export const ABILITY_RULES = { [strikeRule.id]: strikeRule, [grabRule.id]: grabRule, [dashRule.id]: dashRule, [shieldRule.id]: shieldRule } as const;

/** Pořadí skládání: kdo přidává nepřátele (střelba, úder, krádež), jde před dashem a štítem, které chrání před jejich nárazy. */
const APPLY_ORDER: readonly AbilityId[] = ['shoot', 'strike', 'grab', 'dash', 'shield'];

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
  for (const id of APPLY_ORDER) if (ids.includes(id)) next = ABILITY_PIECES[id].apply(next, { ...context, keeper, slot: ids.indexOf(id) });
  // Robot akcí (T6) zná role, před kterými dash a štít chrání – stejné jako jejich pravidla.
  const harm = [...new Set(next.rules.flatMap((rule) => (rule.id === dashRule.id || rule.id === shieldRule.id ? (rule.params.roles as (typeof HARMFUL_ROLES)[number][]) : [])))];
  return { ...next, control: wrapControl(next, { abilities: { keeper, ids: [...ids] } }), bot: wrapBot(next, { keeper, ids: [...ids], harm }) };
}
