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
import type { MechanicAdapter, SurfaceCondition, SurfaceRule, WitnessStep } from '../types';

export const CARRY_SLOT = 0;

type Params = z.infer<(typeof MECHANICS)['carry']['params']>;

export const carry: MechanicAdapter<Params> = (params, ctx) => {
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
