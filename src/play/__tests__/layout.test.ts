/**
 * Rozvržení rolí na mřížku (P23-A, T2).
 *
 * Rozvržení vypadá dobře i s cílem, ke kterému se nedá dojít – proto se
 * dosažitelnost, vzdálenost cíle a determinismus pinují tady, ne okem.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GOAL_KINDS, ZONE_KINDS, layoutJson, layoutRoles, roleInstanceId, type Cell, type Layout } from '../compile/layout';
import { readGameSpec, type GameSpecV1 } from '../spec';

const FIXTURES = [
  'chase_escape',
  'checkpoint_race',
  'collect_exit',
  'combat_lite',
  'delivery',
  'hazard_crossing',
  'survival_timer',
  'switch_puzzle',
] as const;
const SEEDS = [1, 2, 3, 4, 5] as const;

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): GameSpecV1 {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8'));
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function layout(spec: GameSpecV1, seed: number): Layout {
  const result = layoutRoles(spec, seed);
  if (!result.ok) throw new Error(`${spec.title}/${seed}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

const key = ([x, y]: Cell): string => `${x},${y}`;
const manhattan = ([ax, ay]: Cell, [bx, by]: Cell): number => Math.abs(ax - bx) + Math.abs(ay - by);

function rectCells([x, y, w, h]: readonly [number, number, number, number]): Cell[] {
  const cells: Cell[] = [];
  for (let dx = 0; dx < w; dx += 1) for (let dy = 0; dy < h; dy += 1) cells.push([x + dx, y + dy]);
  return cells;
}

/** BFS po neblokovaných buňkách čtyřokolím – totéž, co má později projít hráč. */
function reachable(result: Layout): Set<string> {
  const blocked = new Set(result.blocked.map(key));
  const seen = new Set<string>([key(result.spawn)]);
  const queue: Cell[] = [result.spawn];
  while (queue.length > 0) {
    const [x, y] = queue.shift() as Cell;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as Cell[]) {
      if (nx < 0 || ny < 0 || nx >= result.width || ny >= result.height) continue;
      const k = key([nx, ny]);
      if (blocked.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

describe('layoutRoles', () => {
  it('places all 8 fixtures × seeds 1..5 without LAYOUT_FAILED and keeps every invariant', () => {
    for (const name of FIXTURES) {
      const spec = fixture(name);
      for (const seed of SEEDS) {
        const result = layout(spec, seed);
        const label = `${name}/${seed}`;
        const blocked = new Set(result.blocked.map(key));
        const seen = new Set<string>();

        // Každá instance role (role × count) má vlastní, neblokovanou buňku uvnitř mřížky.
        for (const role of spec.roles) {
          for (let i = 0; i < role.count; i += 1) {
            const id = roleInstanceId(role, i);
            const cell = result.cells.get(id);
            expect(cell, `${label}: ${id} has a cell`).toBeDefined();
            const [x, y] = cell as Cell;
            expect(x >= 0 && y >= 0 && x < result.width && y < result.height, `${label}: ${id} inside grid`).toBe(true);
            expect(blocked.has(key([x, y])), `${label}: ${id} on a blocked cell`).toBe(false);
            expect(seen.has(key([x, y])), `${label}: ${id} shares a cell`).toBe(false);
            seen.add(key([x, y]));
          }
        }
        expect(result.cells.size).toBe(spec.roles.reduce((sum, role) => sum + role.count, 0));

        // Hráč stojí na spawnu.
        const player = spec.roles.find((role) => role.kind === 'player') as GameSpecV1['roles'][number];
        expect(result.cells.get(roleInstanceId(player, 0))).toEqual(result.spawn);

        // Cíl leží aspoň ⌈max(w,h)/2⌉ od hráče.
        const minGoal = Math.ceil(Math.max(result.width, result.height) / 2);
        const goals: Cell[] = [];
        for (const role of spec.roles) {
          if (!GOAL_KINDS.includes(role.kind)) continue;
          for (let i = 0; i < role.count; i += 1) {
            const cell = result.cells.get(roleInstanceId(role, i)) as Cell;
            goals.push(cell);
            expect(manhattan(cell, result.spawn), `${label}: ${role.id} far from spawn`).toBeGreaterThanOrEqual(minGoal);
          }
        }

        // Zóny: 1×1 nebo 2×2, uvnitř mřížky, kotva role je v obdélníku; hazard nekryje spawn ani cíl.
        for (const role of spec.roles) {
          if (!ZONE_KINDS.includes(role.kind)) continue;
          for (let i = 0; i < role.count; i += 1) {
            const id = roleInstanceId(role, i);
            const rect = result.zones[id];
            expect(rect, `${label}: ${id} has a zone`).toBeDefined();
            const [x, y, w, h] = rect as readonly [number, number, number, number];
            expect(w === h && (w === 1 || w === 2), `${label}: ${id} zone is 1×1 or 2×2`).toBe(true);
            expect(x >= 0 && y >= 0 && x + w <= result.width && y + h <= result.height, `${label}: ${id} zone inside`).toBe(true);
            const cells = rectCells(rect as readonly [number, number, number, number]).map(key);
            expect(cells, `${label}: ${id} anchor inside its zone`).toContain(key(result.cells.get(id) as Cell));
            if (role.kind === 'hazard') {
              expect(cells, `${label}: ${id} covers spawn`).not.toContain(key(result.spawn));
              for (const goal of goals) expect(cells, `${label}: ${id} covers goal`).not.toContain(key(goal));
            }
          }
        }
        expect(Object.keys(result.zones).length).toBe(
          spec.roles.filter((role) => ZONE_KINDS.includes(role.kind)).reduce((sum, role) => sum + role.count, 0),
        );

        // Od spawnu se BFS po neblokovaných buňkách dostane ke každé instanci.
        const open = reachable(result);
        for (const [id, cell] of result.cells) expect(open.has(key(cell)), `${label}: ${id} reachable`).toBe(true);
      }
    }
  });

  it('is byte-identical for the same spec and seed', () => {
    const spec = fixture('collect_exit');
    expect(JSON.stringify(layoutJson(layout(spec, 7)))).toBe(JSON.stringify(layoutJson(layout(spec, 7))));
  });

  it('moves at least one role between seeds 7 and 8', () => {
    const spec = fixture('collect_exit');
    const a = layout(spec, 7);
    const b = layout(spec, 8);
    const moved = [...a.cells].some(([id, cell]) => key(cell) !== key(b.cells.get(id) as Cell));
    expect(moved).toBe(true);
  });

  it('fails closed with LAYOUT_FAILED when the roles do not fit any grid', () => {
    const spec = fixture('collect_exit');
    const roles = Array.from({ length: 20 }, (_, i) => ({ id: `crowd${i}`, kind: 'prop' as const, label: 'crowd', count: 50 }));
    const result = layoutRoles({ ...spec, roles: [...spec.roles, ...roles] }, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('LAYOUT_FAILED');
  });
});
