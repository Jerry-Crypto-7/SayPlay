/**
 * `carry`: sebraný předmět role putuje v inventáři do cíle; křehký se rozbije
 * dotykem s hlídkou nebo pronásledovatelem.
 *
 * Tři pravidla na předmět: sběr dá předmět do slotu 0, vstup do cíle s
 * předmětem vyhraje a sběr **v cíli** vyhraje rovnou – stráže vidí stav před
 * tikem, takže `hasItem` po sběru v témž tiku ještě neplatí a keypoint
 * `placeAt: {player: table}` + `pickup` by jinak nikdy nevyhrál. `fragile`
 * přidá `onCollide(hráč, chodec)` se stráží `hasItem → lose` na každou
 * instanci rolí druhu `patrol` a `chaser`; bez chodců se nic nepřidá.
 * Odložení (`onDrop`/`takeItem`) se nekompiluje: `drop` by jen rozšířil
 * abecedu hledače a registr ho v ceně nepočítá.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { AdapterOutput, CounterDecl, MechanicAdapter, SurfaceCondition, SurfaceRule, WitnessStep } from '../types';

export const CARRY_SLOT = 0;

type Params = z.infer<(typeof MECHANICS)['carry']['params']>;

/** Počet obsloužených objednávek (`carry.menu`). */
export const ORDERS_COUNTER = 'orders_served';

export const carry: MechanicAdapter<Params> = (params, ctx) => (params.menu === undefined ? carryOne(params, ctx) : takeOrders(params.menu, params, ctx));

/**
 * Objednávky (P25B T5): každé jídlo je výdejna – sběr dá do slotu jídlo
 * (ID role, ne instance, takže platí kterákoli výdejna téže role). Zákazník
 * chce `menu[i mod délka]`: `use` na něj s tím jídlem v ruce jídlo odebere a
 * přičte `orders_served` a `<zákazník>_served` (max 1 – obsloužený podruhé
 * nic nechce). Předávka je `use`, ne vstup do zóny – cesta k jednomu
 * zákazníkovi vede často přes jiného a ten by si jídlo vzal cestou. Špatné jídlo nic neudělá. Obsloužení všech vyhraje; prohru
 * dodá časovač směny (`timer`), ne tahle mechanika.
 */
function takeOrders(menu: readonly string[], params: Params, ctx: Parameters<MechanicAdapter<Params>>[1]): AdapterOutput {
  const rules: Record<string, SurfaceRule> = {};
  const counters: Record<string, CounterDecl> = {};
  const witness: WitnessStep[] = [];
  const customers = ctx.instances(params.destinationRole);
  for (const dish of new Set(menu)) {
    for (const station of ctx.instances(dish)) {
      const id = `carry.${station}.pick`;
      rules[id] = { id, phase: 0, priority: 0, event: { kind: 'onPickup', entity: station }, condition: null, actions: [{ kind: 'giveItem', slot: CARRY_SLOT, item: dish }] };
    }
  }
  customers.forEach((customer, index) => {
    const dish = menu[index % menu.length] as string;
    const served = `${customer}_served`;
    counters[served] = { min: 0, max: 1, init: 0 };
    const id = `carry.${customer}.serve`;
    rules[id] = {
      id,
      phase: 0,
      priority: 0,
      event: { kind: 'onAction', actor: ctx.player, actionId: 'use', target: customer },
      condition: { kind: 'allOf', operands: [{ kind: 'hasItem', slot: CARRY_SLOT, item: dish }, { kind: 'counterIs', ref: served, op: '=', value: 0 }] },
      actions: [
        { kind: 'takeItem', slot: CARRY_SLOT, item: dish },
        { kind: 'addCounter', ref: served, by: 1 },
        { kind: 'addCounter', ref: ORDERS_COUNTER, by: 1 },
      ],
    };
    const [station] = ctx.instances(dish);
    if (station !== undefined) witness.push({ actionId: 'pickup', target: station, stage: 0 }, { actionId: 'use', target: customer, stage: 0 });
  });
  counters[ORDERS_COUNTER] = { min: 0, max: customers.length, init: 0 };
  rules['carry.orders.done'] = {
    id: 'carry.orders.done',
    phase: 1,
    priority: 0,
    event: { kind: 'onCounterReaches', ref: ORDERS_COUNTER, threshold: customers.length },
    condition: null,
    actions: [{ kind: 'win' }],
  };
  return { rules, witness, counters, slots: 1 };
}

const carryOne: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const witness: WitnessStep[] = [];
  const items = ctx.instances(params.itemRole);
  const destinations = ctx.instances(params.destinationRole);
  const movers = ctx.spec.roles.filter((role) => role.kind === 'patrol' || role.kind === 'chaser').flatMap((role) => ctx.instances(role.id));
  const holding = (item: string): SurfaceCondition => ({ kind: 'hasItem', slot: CARRY_SLOT, item });
  const inDestination: SurfaceCondition[] = destinations.map((zone) => ({ kind: 'inZone', entity: ctx.player, zone }));

  for (const item of items) {
    const pick = `carry.${item}.pick`;
    rules[pick] = {
      id: pick,
      phase: 0,
      priority: 0,
      event: { kind: 'onPickup', entity: item },
      condition: null,
      actions: [{ kind: 'giveItem', slot: CARRY_SLOT, item }],
    };
    const pickAtDestination = `carry.${item}.deliver_here`;
    rules[pickAtDestination] = {
      id: pickAtDestination,
      phase: 1,
      priority: 0,
      event: { kind: 'onPickup', entity: item },
      condition: inDestination.length === 1 ? (inDestination[0] as SurfaceCondition) : { kind: 'anyOf', operands: inDestination },
      actions: [{ kind: 'win' }],
    };
    for (const destination of destinations) {
      const deliver = `carry.${item}.deliver_${destination}`;
      rules[deliver] = {
        id: deliver,
        phase: 2,
        priority: 0,
        event: { kind: 'onEnterZone', entity: ctx.player, zone: destination },
        condition: holding(item),
        actions: [{ kind: 'win' }],
      };
    }
    if (params.fragile) {
      for (const mover of movers) {
        const breakId = `carry.${item}.break_${mover}`;
        rules[breakId] = {
          id: breakId,
          phase: 1,
          priority: 0,
          event: { kind: 'onCollide', a: ctx.player, b: mover },
          condition: holding(item),
          actions: [{ kind: 'lose' }],
        };
      }
    }
  }

  // Svědek sebere první předmět a donese ho do prvního cíle.
  const [item] = items;
  const [destination] = destinations;
  if (item !== undefined && destination !== undefined) {
    witness.push({ actionId: 'pickup', target: item, stage: 0 }, { actionId: 'moveTo', target: destination, stage: 1 });
  }
  return { rules, witness, slots: 1 };
};
