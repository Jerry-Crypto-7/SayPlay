/**
 * Kompilátor simulace (P23-A, T3): `GameSpec` + seed → povrchový `sim`.
 *
 * Pořadí je pevné: rozvržení → základ (`baseSim`) → adaptér každé mechaniky
 * v pořadí specu → sloučení. Adaptér smí vydat jen události a akce z
 * `MECHANICS[id].capabilities`; porušení je chyba adaptéru, ne dat, a proto
 * se hází – tichý průchod by dal svět, který registr slíbil jinak.
 *
 * Svědka **píše kompilátor**, ne hledač: adaptéry vrátí kroky (`WitnessStep`),
 * `planWitness` je seřadí podle `stage` a otikuje podle vzdáleností na mřížce.
 * Hledač (`solveWitnessDetailed`) nad 7 sokety × 5 předměty stojí desítky sekund
 * (20. 9. 2026: 2 623 uzlů, 48 s); jeden replay autorské stopy stojí milisekundy
 * a certifikuje ho týž `verifyWitness`.
 */

import { TIERS, TIER_POLICY, type Tier } from '@/verify/tiers';

import type { MechanicBinding } from '../contracts';
import { MECHANICS, type MechanicEntry, type MechanicId, type RuntimeAction } from '../registry';
import type { GameRole, GameSpecV1 } from '../spec';
import { ADAPTERS, type AdapterTable } from './adapters';
import { layoutRoles, roleInstanceId } from './layout';
import { createCompileRng } from './rng';
import { PLAYER_SOCKET, baseSim } from './sim';
import type { AdapterContext, AdapterOutput, MechanicAdapter, SimCompileResult, SurfaceRule, SurfaceSim, WitnessOp, WitnessStep } from './types';

export type { AdapterContext, AdapterOutput, MechanicAdapter, SimCompilation, SimCompileResult, SurfaceSim } from './types';

/** Runtime ID slotů, jak je čte `writeSlot` (`src/sim/interpreter.ts:220`). */
const slotIds = (output: AdapterOutput): string[] => [
  ...Object.keys(output.counters ?? {}).map((id) => `c:${id}`),
  ...Object.keys(output.flags ?? {}).map((id) => `f:${id}`),
  ...Object.keys(output.timers ?? {}).map((id) => `t:${id}`),
];

function checkCapabilities(mechanicId: MechanicId, rules: Readonly<Record<string, SurfaceRule>>): void {
  const { events, actions } = MECHANICS[mechanicId].capabilities;
  for (const [id, rule] of Object.entries(rules)) {
    if (!events.includes(rule.event.kind)) throw new Error(`adapter ${mechanicId}: rule ${id} uses event ${rule.event.kind} outside capabilities`);
    for (const action of rule.actions) {
      if (!actions.includes(action.kind as RuntimeAction))
        throw new Error(`adapter ${mechanicId}: rule ${id} uses action ${action.kind} outside capabilities`);
    }
  }
}

/**
 * Tiky svědka: `moveTo` trvá 1 tik prodlevy + 1 tik na buňku (`settle`,
 * `src/sim/interpreter.ts:795`), akce bez pohybu se projeví týž tik; mezi kroky
 * jsou 2 tiky navíc, aby `onEnterZone` stihl hranu a `emit` doručení.
 */
function planWitness(sim: SurfaceSim, steps: readonly WitnessStep[]): WitnessOp[] {
  const ordered = [...steps].sort((a, b) => a.stage - b.stage);
  const ops: WitnessOp[] = [];
  let at = sim.sockets[PLAYER_SOCKET];
  let tick = 0;
  for (const step of ordered) {
    ops.push({ tick, actionId: step.actionId, target: step.target });
    if (step.actionId === 'moveTo') {
      const cell = sim.sockets[sim.entities[step.target].socket];
      tick += 1 + Math.abs(cell[0] - at[0]) + Math.abs(cell[1] - at[1]);
      at = cell;
    }
    tick += 2;
  }
  return ops;
}

/**
 * Nejkratší tier, jehož horizont pokryje svědka i nejdelší časovač s rezervou
 * – výhra z `onTimerEnd` přijde tik po doběhnutí a horizont musí být ostře větší.
 */
function chooseTier(sim: SurfaceSim, ops: readonly WitnessOp[]): Tier {
  const lastInput = ops.length > 0 ? (ops[ops.length - 1] as WitnessOp).tick : 0;
  const longestTimer = Math.max(0, ...Object.values(sim.state.timers).map((timer) => timer.durationTicks));
  const needed = Math.max(lastInput, longestTimer) + 60;
  return TIERS.find((tier) => TIER_POLICY[tier].maxHorizonTicks >= needed) ?? 'long';
}

export function compileSim(spec: GameSpecV1, seed: number, adapters: AdapterTable = ADAPTERS): SimCompileResult {
  const unsupported = spec.mechanics.filter((mechanic) => adapters[mechanic.id] === null).map((mechanic) => mechanic.id);
  if (unsupported.length > 0) {
    return { ok: false, reason: 'MECHANIC_UNSUPPORTED', issues: unsupported.map((id) => `mechanic ${id} has no compile adapter`) };
  }

  const placed = layoutRoles(spec, seed);
  if (!placed.ok) return placed;
  const layout = placed.value;
  const { sim, roles, player } = baseSim(spec, layout);

  const rolesById = new Map<string, GameRole>(spec.roles.map((role) => [role.id, role]));
  const ctx: AdapterContext = {
    spec,
    layout,
    rng: createCompileRng(seed),
    player,
    role: (roleId) => rolesById.get(roleId) as GameRole,
    instances: (roleId) => {
      const role = rolesById.get(roleId) as GameRole;
      return Array.from({ length: role.count }, (_, i) => roleInstanceId(role, i));
    },
  };

  const mechanics: MechanicBinding[] = [];
  const steps: WitnessStep[] = [];
  const agents = [...(sim.state.agents ?? [])];
  let slots = sim.state.slots;
  for (const mechanic of spec.mechanics) {
    const entry = MECHANICS[mechanic.id] as MechanicEntry<unknown>;
    const params = entry.params.parse(mechanic.params);
    const output = (adapters[mechanic.id] as MechanicAdapter)(params, ctx);
    checkCapabilities(mechanic.id, output.rules);

    for (const [id, rule] of Object.entries(output.rules)) {
      if (id in sim.rules) throw new Error(`adapter ${mechanic.id}: rule ${id} already declared`);
      sim.rules[id] = rule;
    }
    for (const [id, entity] of Object.entries(output.entities ?? {})) {
      if (id in sim.entities) throw new Error(`adapter ${mechanic.id}: entity ${id} already declared`);
      sim.entities[id] = entity;
    }
    Object.assign(sim.state.counters, output.counters ?? {});
    Object.assign(sim.state.flags, output.flags ?? {});
    Object.assign(sim.state.timers, output.timers ?? {});
    Object.assign(sim.state.zones, output.zones ?? {});
    Object.assign(sim.state.pool, output.pool ?? {});
    agents.push(...(output.agents ?? []));
    steps.push(...(output.witness ?? []));
    slots = Math.max(slots, output.slots ?? 0);

    mechanics.push({
      mechanicId: mechanic.id,
      ruleIds: Object.keys(output.rules),
      entityIds: Object.keys(output.entities ?? {}),
      slotIds: slotIds(output),
    });
  }

  const state = { ...sim.state, slots, ...(agents.length > 0 ? { agents } : {}) };
  const ops = planWitness(sim, steps);
  const tier = chooseTier({ ...sim, state }, ops);
  const witness = { tier, H_cert: TIER_POLICY[tier].maxHorizonTicks, ops };
  return { ok: true, value: { sim: { ...sim, state, witness }, layout, mechanics, roles } };
}
