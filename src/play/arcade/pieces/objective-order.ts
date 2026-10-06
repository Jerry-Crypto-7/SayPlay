/** Objective dependencies with real contact effects; no hidden completion ledger. */
import { z } from 'zod';
import { AXIS_MAX, BODY, BUTTON, COUNTER, HEADER, ROLE, FLAG, bodyBase, targetStateOf, type ArcadeEffect, type BotPiece, type ControlPiece, type RulePiece } from '../contract';
import { dependsOnSchema, phasesSchema, phaseSpeed } from '../../compose/progression';
import { walkerControl, walkerControlParams, walkerMapSchema, walkerVelocity, walkerWaypoint, walkerCell } from './walker';

export const objectiveNodeSchema = z.object({ goal: z.string(), body: z.int().min(1).max(255), action: z.enum(['collect', 'open', 'reach']), prerequisites: z.array(z.string()).max(39) }).strict();
export const orderedObjectivesSchema = z.array(objectiveNodeSchema).min(1).max(40).superRefine((nodes, context) => {
  const graph = new Map(nodes.map(node => [node.goal, node.prerequisites]));
  const seen = new Set<string>(), active = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id) || !graph.has(id)) return false;
    if (seen.has(id)) return true;
    active.add(id);
    for (const parent of graph.get(id)!) if (!visit(parent)) return false;
    active.delete(id); seen.add(id); return true;
  };
  if (graph.size !== nodes.length || nodes.some(node => !visit(node.goal))) context.addIssue({ code: 'custom', message: 'Invalid objective dependency graph' });
  if (new Set(nodes.map(node => node.body)).size !== nodes.length) context.addIssue({ code: 'custom', message: 'Each objective needs its own physical body' });
});
export type ObjectiveNode = z.infer<typeof objectiveNodeSchema>;
export const objectiveComplete = (state: Int32Array, node: ObjectiveNode): boolean => targetStateOf(state, node.body) === 1;
export function legalObjectives(state: Int32Array, nodes: readonly ObjectiveNode[]): ObjectiveNode[] {
  return nodes.filter(node => !objectiveComplete(state, node) && (state[bodyBase(node.body) + BODY.flags]! & FLAG.alive) !== 0 && node.prerequisites.every(id => {
    const parent = nodes.find(item => item.goal === id);
    return parent !== undefined && objectiveComplete(state, parent);
  }));
}
const objectiveParams = z.object({ nodes: orderedObjectivesSchema, allItems: z.boolean().optional() }).strict();
export const objectiveOrder: RulePiece<z.infer<typeof objectiveParams>> = {
  id: 'objective_order', params: objectiveParams, trigger: 'tick', roles: ['player', 'thing'], cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player }, { nodes, allItems }) {
    const p = bodyBase(player);
    for (const node of legalObjectives(state, nodes)) {
      const b = bodyBase(node.body);
      const contact = Math.abs(state[p + BODY.x]! - state[b + BODY.x]!) <= (state[p + BODY.w]! + state[b + BODY.w]!) / 2 + 1 &&
        Math.abs(state[p + BODY.z]! - state[b + BODY.z]!) <= (state[p + BODY.d]! + state[b + BODY.d]!) / 2 + 1 &&
        state[p + BODY.y]! <= state[b + BODY.y]! + state[b + BODY.h]! && state[p + BODY.y]! + state[p + BODY.h]! >= state[b + BODY.y]!;
      if (!contact) continue;
      if (allItems && node.action === 'reach' && Array.from({ length: state[HEADER.bodyCount]! }, (_, i) => bodyBase(i)).some(b => state[b + BODY.role] === ROLE.collectible && (state[b + BODY.flags]! & FLAG.alive))) continue;
      const effects: ArcadeEffect[] = [{ kind: 'stateChange', body: node.body, state: 1 }];
      if (node.action !== 'reach') effects.push({ kind: 'despawn', body: node.body });
      if (node.action === 'collect') effects.push({ kind: 'count', counter: 'items', amount: 1 });
      if (nodes.every(other => other === node || objectiveComplete(state, other))) effects.push({ kind: 'win' });
      return effects;
    }
    return [];
  },
};

const pacingFields = { phases: phasesSchema.optional(), phaseLength: z.int().positive().optional() };
export const pacedWalkerParams = walkerControlParams.extend(pacingFields).superRefine((params, context) => {
  if (params.phases !== undefined && params.phaseLength === undefined) context.addIssue({ code: 'custom', message: 'Phases need course length' });
});
export const pacedWalkerControl: ControlPiece<z.infer<typeof pacedWalkerParams>> = {
  ...walkerControl, id: 'paced_walker', params: pacedWalkerParams,
  step(state, player, input, params) {
    const speed = phaseSpeed(params.speed, state[bodyBase(player) + BODY.z]!, params.phaseLength ?? 1, params.phases);
    walkerControl.step(state, player, input, { ...params, speed });
  },
};
const botParams = walkerMapSchema.extend({ speed: z.int().min(80).max(160), nodes: orderedObjectivesSchema, ...pacingFields });
export const objectiveWalkerBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'objective_walker_bot', params: botParams, roles: ['player', 'thing'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }),
  decide({ state, player, recent }, params) {
    const p = bodyBase(player);
    let x = state[p + BODY.x]!, z0 = state[p + BODY.z]!;
    for (const input of recent) {
      const speed = phaseSpeed(params.speed, z0, params.phaseLength ?? 1, params.phases);
      const velocity = walkerVelocity(input, speed); x += velocity.vx; z0 += velocity.vz;
    }
    const legal = legalObjectives(state, params.nodes);
    const node = legal[0]; // stable topological tie-break; never visit a locked goal
    if (node === undefined) return { axis: 0, buttons: 0 };
    const b = bodyBase(node.body), goal = walkerCell(params, state[b + BODY.x]!, state[b + BODY.z]!);
    const target = walkerWaypoint(params, x, z0, goal);
    if (target === null) return { axis: 0, buttons: 0 };
    const speed = phaseSpeed(params.speed, z0, params.phaseLength ?? 1, params.phases);
    return walkerVelocityTo(target.x - x, target.z - z0, speed);
  },
};
function walkerVelocityTo(dx: number, dz: number, speed: number) {
  if (Math.abs(dx) > 80) return { axis: Math.round(Math.max(-1, Math.min(1, dx / speed)) * AXIS_MAX), buttons: 0 };
  // UP/DOWN use the native walker bits; imported constants avoid an input alias.
  return { axis: 0, buttons: Math.abs(dz) > 80 ? dz > 0 ? BUTTON.UP : BUTTON.DOWN : 0 };
}
