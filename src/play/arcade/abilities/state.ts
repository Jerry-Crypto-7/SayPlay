/**
 * Stav akcí hrdiny (P46A T1/T4) v těle-počítadle `abilityKeeper`. Píše ho jen
 * obal ovládání (`addon_control`), protože jen ovládání smí sahat do stavu
 * přímo: každý tik odečte cooldown a aktivní okno a stisk tlačítka akce při
 * nulovém cooldownu akci spustí. Pravidla akcí stav jen čtou. Bez importu
 * doplňků, ať je `addons.ts` může volat bez kruhu.
 */

import { z } from 'zod';

import { ABILITIES, ABILITY_SLOTS, type AbilityId, ARCADE_HZ, ARCADE_LIMITS, type ArcadeEffect, BUTTON, type PieceRef, bodyBase, powerupOf } from '../contract';

/** Cooldown a délka aktivního okna v tikách (60 Hz). */
export const ABILITY_TIMING: Readonly<Record<AbilityId, { readonly cooldown: number; readonly active: number }>> = {
  // Střelba má rozestup ran v blasteru (`gunTick`); tady jen okno pro scénu.
  shoot: { cooldown: 0, active: 1 },
  strike: { cooldown: Math.round(ARCADE_HZ / 2), active: 6 },
  dash: { cooldown: ARCADE_HZ, active: 18 },
  // Blok, ne trvalý náboj: náboj drží jen po okno 40 tiků. Náboj do zásahu by skákačku
  // úplně zjednodušil (novice 10/10 proti 5/10 bez akce, i s cooldownem 4 s).
  shield: { cooldown: 2 * ARCADE_HZ, active: 40 },
  grab: { cooldown: Math.round(ARCADE_HZ / 3), active: 6 },
};

/** Akce A a B: tlačítko, cooldown a aktivní okno podle pořadí v `spec.abilities`. */
export const ABILITY_BUTTONS = [BUTTON.ACTION_A, BUTTON.ACTION_B] as const;
const COOLDOWN = [ABILITY_SLOTS.cooldownA, ABILITY_SLOTS.cooldownB] as const;
const ACTIVE = [ABILITY_SLOTS.activeA, ABILITY_SLOTS.activeB] as const;

export const abilityControlParams = z
  .object({
    keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
    ids: z.array(z.enum(ABILITIES)).min(1).max(2),
  })
  .strict();
export type AbilityControl = z.infer<typeof abilityControlParams>;

/** Role, které hrdinovi ublíží nárazem – ty dash prorazí a štít odrazí. */
export const HARMFUL_ROLES = ['obstacle', 'chaser', 'hazard', 'enemy'] as const;

/** Robot akcí (P46A T6): totéž co obal ovládání a role, před kterými dash a štít chrání. */
export const abilityBotParams = abilityControlParams.extend({ harm: z.array(z.enum(HARMFUL_ROLES)).max(HARMFUL_ROLES.length) });
export type AbilityBot = z.infer<typeof abilityBotParams>;

/** Obaly ovládání, pod kterými může ležet obal akcí (`baseControlOf` v `addons.ts`). */
const WRAPPERS = new Set(['addon_control', 'phase_control', 'pacing_control', 'assembly_control']);

/**
 * Akce hrdiny ovládání v pořadí tlačítek A, B (P46A T8). Díly složené hry
 * (`assembly_control`) a průběh obalí ovládání až po akcích, takže se hledá
 * pod obaly; hra bez akcí vrátí prázdný seznam.
 */
export function abilityIdsOf(control: PieceRef): readonly AbilityId[] {
  for (let ref: PieceRef | undefined = control; ref !== undefined && WRAPPERS.has(ref.id); ref = (ref.params as { readonly base?: PieceRef }).base) {
    const own = (ref.params as { readonly abilities?: AbilityControl }).abilities;
    if (ref.id === 'addon_control' && own !== undefined) return own.ids;
  }
  return [];
}

/** Tlačítko akce `id` ve hře s akcemi `ids`; 0 = hra ji nemá. */
export const abilityButton = (ids: readonly AbilityId[], id: AbilityId): number => {
  const slot = ids.indexOf(id);
  return slot < 0 ? 0 : (ABILITY_BUTTONS[slot] as number);
};

/** Tik akcí v obalu ovládání: odpočet a spuštění akce na stisk. */
export function tickAbilities(state: Int32Array, buttons: number, params: AbilityControl): void {
  const k = bodyBase(params.keeper);
  params.ids.forEach((id, slot) => {
    const cooldown = k + (COOLDOWN[slot] as number);
    const active = k + (ACTIVE[slot] as number);
    if ((state[cooldown] as number) > 0) state[cooldown] = (state[cooldown] as number) - 1;
    if ((state[active] as number) > 0) state[active] = (state[active] as number) - 1;
    // Štít: náboj platí jen v okně; spotřebuje ho zásah (pravidlo `ability_shield`), nebo konec okna.
    // Power-up štít (P46C) sdílí týž náboj a drží ho po své trvání.
    if (id === 'shield' && (state[active] as number) === 0 && powerupOf(state, params.keeper) !== 'shield') state[k + ABILITY_SLOTS.shield] = 0;
    if ((buttons & (ABILITY_BUTTONS[slot] as number)) === 0 || (state[cooldown] as number) > 0) return;
    state[active] = ABILITY_TIMING[id].active;
    state[cooldown] = ABILITY_TIMING[id].cooldown;
    if (id === 'shield') state[k + ABILITY_SLOTS.shield] = 1;
  });
  state[k + ABILITY_SLOTS.held] = buttons & (BUTTON.ACTION_A | BUTTON.ACTION_B);
}

/** Ochrana nárazu (`hit`, `steer_crash`) dashem ve slotu `dash` nebo štítem (P46A T5). */
export const guardParams = z
  .object({ keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), dash: z.int().min(0).max(1).optional(), shield: z.literal(true).optional() })
  .strict();

/**
 * Co hrdinu před nárazem chrání: dash (náraz nic nevezme), nabitý štít (náraz platí, jen
 * když ho blok téhož tiku nepohltil – `ifAlive`), nebo nic. Pohlcení samo (zmizení těla,
 * spotřebu náboje) dělají pravidla akcí.
 */
export function guardOf(state: Int32Array, guard: z.infer<typeof guardParams>): 'dash' | 'shield' | undefined {
  if (guard.dash !== undefined && abilityActive(state, guard.keeper, guard.dash) > 0) return 'dash';
  return guard.shield === true && (state[bodyBase(guard.keeper) + ABILITY_SLOTS.shield] as number) > 0 ? 'shield' : undefined;
}

/** Efekty nárazu do těla `other` pod ochranou `guard` (`hit`, `steer_crash`). */
export function guardedHit(state: Int32Array, guard: z.infer<typeof guardParams> | undefined, other: number, effects: ArcadeEffect[]): ArcadeEffect[] {
  const by = guard === undefined ? undefined : guardOf(state, guard);
  if (by === 'dash') return [];
  return by === 'shield' && effects.length > 0 ? [{ kind: 'ifAlive', body: other, effects }] : effects;
}

/** Zbývající aktivní tiky akce ve slotu `slot` (0 = A, 1 = B). */
export const abilityActive = (state: Int32Array, keeper: number, slot: number): number => state[bodyBase(keeper) + (ACTIVE[slot] as number)] as number;

/** Zbývající cooldown akce ve slotu `slot`. */
export const abilityCooldown = (state: Int32Array, keeper: number, slot: number): number => state[bodyBase(keeper) + (COOLDOWN[slot] as number)] as number;
