/**
 * `patrol`: postava obchází pevnou trasu; povahu určuje `disposition`.
 *
 * Trasa = `stops` soketů `<instance>_stop<i>` (bez tečky, `SYMBOL_PATTERN`) na
 * náhodných buňkách ze seedu, mysl v `state.agents` (`expandAgentMinds`).
 * Dotyk je `onCollide(hlídka, hráč)`; `none` nedělá nic.
 *
 * S `sight` (plížení, P25B T3) je každý úsek okruhu zastávek zóna
 * `<instance>_beat<i>` – dva obdélníky cesty „nejdřív po x, pak po y“, tak jak
 * postava chodí (`settle`). Hlídka vidí po úseku, na kterém stojí: hráč, který
 * na něj vkročí, když je tam hlídka, prohraje (`spot`), a hlídka, která vkročí
 * na úsek s hráčem, také (`sees`). `start` chytí hráče postaveného do výhledu
 * vstřikem keypointu – `onEnterZone` je hrana a start by minul. Úseky se
 * vyhnou cestě svědka (spawn → cíl), jinak by hra nešla certifikovat.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import { GOAL_KINDS, type Cell, type Rect } from '../layout';
import type { AgentDecl, MechanicAdapter, SurfaceAction, SurfaceCondition, SurfaceRule } from '../types';
import { DAMAGE_COUNTER } from './health';

type Params = z.infer<(typeof MECHANICS)['patrol']['params']>;

const key = ([x, y]: Cell): string => `${x},${y}`;

/** Buňky pohybu z `a` do `b`: nejdřív po x, pak po y (týž tvar jako `movePath` rozvržení). */
function legCells(a: Cell, b: Cell): Cell[] {
  const cells: Cell[] = [];
  for (let x = a[0]; x !== b[0]; x += Math.sign(b[0] - a[0])) cells.push([x, a[1]]);
  for (let y = a[1]; y !== b[1]; y += Math.sign(b[1] - a[1])) cells.push([b[0], y]);
  cells.push(b);
  return cells;
}

function legRects(a: Cell, b: Cell): Rect[] {
  return [
    [Math.min(a[0], b[0]), a[1], Math.abs(b[0] - a[0]) + 1, 1],
    [b[0], Math.min(a[1], b[1]), 1, Math.abs(b[1] - a[1]) + 1],
  ];
}

export const patrol: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const sockets: Record<string, readonly [number, number]> = {};
  const zones: Record<string, readonly Rect[]> = {};
  const agents: AgentDecl[] = [];
  const hasHealth = ctx.spec.mechanics.some((mechanic) => mechanic.id === 'health');
  const hit: SurfaceAction | null =
    params.touchEffect === 'none' ? null : params.touchEffect === 'damage' && hasHealth ? { kind: 'addCounter', ref: DAMAGE_COUNTER, by: 1 } : { kind: 'lose' };
  const [sx, sy] = ctx.layout.spawn;
  const between = (v: number, a: number, b: number): boolean => v >= Math.min(a, b) && v <= Math.max(a, b);
  /** Úsek trasy leží v obdélníku mezi dvěma zastávkami; ten se startu hráče vyhne. */
  const clearOfSpawn = (a: Cell, b: Cell): boolean => !(between(sx, a[0], b[0]) && between(sy, a[1], b[1]));

  // Cesta svědka k cíli; hlídka s výhledem na ni nesmí vidět.
  const route = new Set<string>([key(ctx.layout.spawn)]);
  if (params.sight === true) {
    for (const role of ctx.spec.roles.filter((candidate) => GOAL_KINDS.includes(candidate.kind))) {
      for (const instance of ctx.instances(role.id)) {
        const goal = ctx.layout.cells.get(instance);
        if (goal !== undefined) for (const cell of legCells(ctx.layout.spawn, goal)) route.add(key(cell));
      }
    }
  }
  const clearOfRoute = (a: Cell, b: Cell): boolean => legCells(a, b).every((cell) => !route.has(key(cell)));
  const clear = (a: Cell, b: Cell): boolean => (params.sight === true ? clearOfRoute(a, b) : clearOfSpawn(a, b));

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
      const closing = goals.length === params.stops - 1 ? clear([x, y], sockets[goals[0] ?? ''] ?? [x, y]) : true;
      if (attempts <= 400 && (!clear(previous, [x, y]) || !closing)) continue;
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
    if (params.sight === true) {
      const together: SurfaceCondition[] = [];
      // Úsek 0 je první cesta ze startu; na něm keypoint staví hráče do výhledu.
      const legs: (readonly [Cell, Cell])[] = [
        [start, sockets[goals[0] as string] as Cell],
        ...goals.map((from, index) => [sockets[from] as Cell, sockets[goals[(index + 1) % goals.length] as string] as Cell] as const),
      ];
      legs.forEach(([from, to], index) => {
        const beat = `${id}_beat${index}`;
        zones[beat] = legRects(from, to);
        const guardOn = { kind: 'inZone', entity: id, zone: beat };
        const playerOn = { kind: 'inZone', entity: ctx.player, zone: beat };
        together.push({ kind: 'allOf', operands: [guardOn, playerOn] });
        rules[`patrol.${id}.spot${index}`] = {
          id: `patrol.${id}.spot${index}`,
          phase: 1,
          priority: 0,
          event: { kind: 'onEnterZone', entity: ctx.player, zone: beat },
          condition: guardOn,
          actions: [{ kind: 'lose' }],
        };
        rules[`patrol.${id}.sees${index}`] = {
          id: `patrol.${id}.sees${index}`,
          phase: 1,
          priority: 0,
          event: { kind: 'onEnterZone', entity: id, zone: beat },
          condition: playerOn,
          actions: [{ kind: 'lose' }],
        };
      });
      rules[`patrol.${id}.start`] = {
        id: `patrol.${id}.start`,
        phase: 1,
        priority: 0,
        event: { kind: 'onStart' },
        condition: { kind: 'anyOf', operands: together },
        actions: [{ kind: 'lose' }],
      };
    }
  }
  return { rules, sockets, zones, agents };
};
