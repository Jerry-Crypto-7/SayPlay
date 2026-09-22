/**
 * `patrol`: postava obchází pevnou trasu; povahu určuje `disposition`.
 *
 * Trasa = `stops` soketů `<instance>_stop<i>` (bez tečky, `SYMBOL_PATTERN`) na
 * náhodných buňkách ze seedu, mysl v `state.agents` (`expandAgentMinds`).
 * Dotyk je `onCollide(hlídka, hráč)`; `none` nedělá nic.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { Cell } from '../layout';
import type { AgentDecl, MechanicAdapter, SurfaceAction, SurfaceRule } from '../types';
import { DAMAGE_COUNTER } from './health';

type Params = z.infer<(typeof MECHANICS)['patrol']['params']>;

export const patrol: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const sockets: Record<string, readonly [number, number]> = {};
  const agents: AgentDecl[] = [];
  const hasHealth = ctx.spec.mechanics.some((mechanic) => mechanic.id === 'health');
  const hit: SurfaceAction | null =
    params.touchEffect === 'none' ? null : params.touchEffect === 'damage' && hasHealth ? { kind: 'addCounter', ref: DAMAGE_COUNTER, by: 1 } : { kind: 'lose' };
  const [sx, sy] = ctx.layout.spawn;
  const between = (v: number, a: number, b: number): boolean => v >= Math.min(a, b) && v <= Math.max(a, b);
  /** Úsek trasy leží v obdélníku mezi dvěma zastávkami; ten se startu hráče vyhne. */
  const clearOfSpawn = (a: Cell, b: Cell): boolean => !(between(sx, a[0], b[0]) && between(sy, a[1], b[1]));

  for (const id of ctx.instances(params.role)) {
    const goals: string[] = [];
    const used = new Set<string>([`${sx},${sy}`]);
    const start = ctx.layout.cells.get(id) ?? ctx.layout.spawn;
    let previous: Cell = start;
    // Hlídka přes start zabila nečinného hráče v 6. tiku (P25B, duchové v `collect_exit`).
    // Trasa se startu vyhne, dokud to jde; po 400 pokusech stačí volná buňka.
    let attempts = 0;
    while (goals.length < params.stops) {
      const x = ctx.rng.int(0, ctx.layout.width - 1);
      const y = ctx.rng.int(0, ctx.layout.height - 1);
      if (used.has(`${x},${y}`)) continue;
      attempts += 1;
      const closing = goals.length === params.stops - 1 ? clearOfSpawn([x, y], sockets[goals[0] ?? ''] ?? [x, y]) : true;
      if (attempts <= 400 && (!clearOfSpawn(previous, [x, y]) || !closing)) continue;
      used.add(`${x},${y}`);
      previous = [x, y];
      const socket = `${id}_stop${goals.length + 1}`;
      sockets[socket] = [x, y];
      goals.push(socket);
    }
    agents.push({ id, disposition: params.disposition, goals });
    if (hit !== null) {
      const touch = `patrol.${id}.touch`;
      rules[touch] = { id: touch, phase: 1, priority: 0, event: { kind: 'onCollide', a: id, b: ctx.player }, condition: null, actions: [hit] };
    }
  }
  return { rules, sockets, agents };
};
