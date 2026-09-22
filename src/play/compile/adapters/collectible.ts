/**
 * `collectible`: sběr předmětu role přičítá čítač, plný čítač vyšle signál.
 *
 * Jedno pravidlo `onPickup {entity}` **na instanci**, ne `onPickup {role}`:
 * rolový tvar se snižuje na jediný složený predikát `p.onPickup.<klíč>` a
 * hledač svědka čte abecedu jen z `p.onAction.<hráč>.<akce>.<cíl>`
 * (`src/verify/solve.ts:188`) – svět by byl hratelný, ale nedokazatelný.
 *
 * Entita se nedespawnuje ani nemění stav, takže „už sebráno“ drží čítač
 * `<instance>_taken` s `max: 1` a stráž `counterIs = 0`; bez ní by týž
 * předmět šel sebrat pětkrát a svědek by hru vyhrál z místa.
 *
 * Skrýše (`hiddenIn`, P25D T2): runtime nezná „neaktivní od startu“, proto
 * `onStart` všechny předměty despawnuje – neaktivní entita se nevykreslí
 * (`WorldstreamStage`), ale runtime akci na ni přijme, takže sebrání hlídá
 * i čítač `<instance>_found`. Vstup hráče do i-té skrýše i-tý předmět v ní
 * spawne a čítač nastaví. Každý předmět má vlastní pool (jméno =
 * ID instance); `buildTags` hledá pool podle prefixu jména, proto delší jména
 * první – jinak by `gem_10` spadl do poolu `gem_1`.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { AdapterOutput, CounterDecl, MechanicAdapter, SurfaceAction, SurfaceCondition, SurfaceRule, WitnessStep } from '../types';

type Params = z.infer<(typeof MECHANICS)['collectible']['params']>;

export const collectible: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const witness: WitnessStep[] = [];
  const counters: Record<string, CounterDecl> = { [params.counter]: { min: 0, max: params.count, init: 0 } };
  const items = ctx.instances(params.role);
  const spots = params.hiddenIn === undefined ? [] : ctx.instances(params.hiddenIn);
  items.forEach((instance, index) => {
    const id = `collectible.${instance}.pick`;
    const taken = `${instance}_taken`;
    const spot = spots[index];
    const found = `${instance}_found`;
    counters[taken] = { min: 0, max: 1, init: 0 };
    if (witness.length < params.count * (spot === undefined ? 1 : 2)) {
      if (spot !== undefined) witness.push({ actionId: 'moveTo', target: spot, stage: 0 });
      witness.push({ actionId: 'pickup', target: instance, stage: 0 });
    }
    const free: SurfaceCondition = { kind: 'counterIs', ref: taken, op: '=', value: 0 };
    const isFound: SurfaceCondition = { kind: 'counterIs', ref: found, op: '=', value: 1 };
    rules[id] = {
      id,
      phase: 0,
      priority: 0,
      event: { kind: 'onPickup', entity: instance },
      // Neaktivní entitu runtime k akci pustí (nevidí ji jen jeviště a svědek),
      // proto schovaný předmět hlídá i čítač „nalezeno“.
      condition: spot === undefined ? free : { kind: 'allOf', operands: [free, isFound] },
      actions: [
        { kind: 'addCounter', ref: taken, by: 1 },
        { kind: 'addCounter', ref: params.counter, by: 1 },
      ],
    };
    if (spot !== undefined) {
      counters[found] = { min: 0, max: 1, init: 0 };
      rules[`collectible.${instance}.reveal`] = {
        id: `collectible.${instance}.reveal`,
        phase: 0,
        priority: 0,
        event: { kind: 'onEnterZone', entity: ctx.player, zone: spot },
        condition: { kind: 'counterIs', ref: found, op: '=', value: 0 },
        actions: [
          { kind: 'spawn', poolTag: instance, socket: spot },
          { kind: 'addCounter', ref: found, by: 1 },
        ],
      };
    }
  });
  const full = `collectible.${params.role}.full`;
  rules[full] = {
    id: full,
    phase: 1,
    priority: 0,
    event: { kind: 'onCounterReaches', ref: params.counter, threshold: params.count },
    condition: null,
    actions: [{ kind: 'emit', signal: `${params.counter}Full` }],
  };
  const output: AdapterOutput = { counters, rules, witness };
  if (spots.length === 0) return output;

  const hidden = items.slice(0, spots.length);
  rules[`collectible.${params.role}.hide`] = {
    id: `collectible.${params.role}.hide`,
    phase: 0,
    priority: 0,
    event: { kind: 'onStart' },
    condition: null,
    actions: hidden.map((instance): SurfaceAction => ({ kind: 'despawn', target: instance })),
  };
  const pool = Object.fromEntries(
    [...hidden].sort((a, b) => b.length - a.length).map((instance) => [instance, { size: 1, tag: instance }] as const),
  );
  return { ...output, pool };
};
