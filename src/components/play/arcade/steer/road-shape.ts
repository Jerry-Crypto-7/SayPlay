/**
 * Silnice závodu z mantinelů světa (P46D R2): asfalt úsek po úseku ve skutečné
 * šířce mezi mantinely a souvislé mantinely podél jejich vnitřních hran, i přes
 * schody mezi úseky a kolem ostrůvků rozcestí. Osa trati (`course`) má šířku
 * prvního úseku a na rozcestí jede po pravé větvi, a tak by zúžení, šikany ani
 * rozcestí nebyly vidět. Jen vzhled: čte počáteční stav, hash světa se nehne.
 * Metry, x zrcadlené jako ve scéně.
 */

import { type ArcadeWorld, BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';

export interface RoadSegment {
  readonly near: number;
  readonly far: number;
  readonly center: number;
  /** Šířka mezi vnitřními hranami mantinelů. */
  readonly width: number;
}

/** Kvádr mantinelu na zemi: střed `x`, `z`, šířka `w` do strany a délka `d` po trati. */
export interface RoadBarrier {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
}

/** Tloušťka kresleného mantinelu (m); stojí vně silnice, na vnitřní hraně těla jádra. */
export const BARRIER_W = 0.5;

interface Wall {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
}

/** Úseky a mantinely silnice; trať bez pneumatik (plavba) dá prázdné seznamy. */
export function roadShapeOf(world: ArcadeWorld): { readonly segments: RoadSegment[]; readonly barriers: RoadBarrier[] } {
  const state = instantiate(world);
  const groups = new Map<string, Wall[]>();
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    const at = (slot: keyof typeof BODY): number => state[base + BODY[slot]] as number;
    if ((at('flags') & FLAG.alive) === 0 || at('role') !== ROLE.obstacle || world.kinds[at('kind')] !== 'tire-barrier') continue;
    const key = `${at('z')}/${at('d')}`;
    groups.set(key, [...(groups.get(key) ?? []), { x: -at('x') / UNIT, z: at('z') / UNIT, w: at('w') / UNIT, d: at('d') / UNIT }]);
  }
  const sides: { readonly near: number; readonly far: number; readonly low: number; readonly high: number }[] = [];
  const barriers: RoadBarrier[] = [];
  for (const walls of groups.values()) {
    // Osamělý mantinel je ostrůvek rozcestí: kreslí se celý.
    if (walls.length === 1) barriers.push(walls[0] as Wall);
    if (walls.length !== 2) continue;
    const [a, b] = walls as [Wall, Wall];
    const [low, high] = a.x < b.x ? [a, b] : [b, a];
    sides.push({ near: a.z - a.d / 2, far: a.z + a.d / 2, low: low.x + low.w / 2, high: high.x - high.w / 2 });
  }
  sides.sort((p, q) => p.near - q.near);
  const segments = sides.map((side) => ({ near: side.near, far: side.far, center: (side.low + side.high) / 2, width: side.high - side.low }));
  sides.forEach((side, index) => {
    const z = (side.near + side.far) / 2;
    const d = side.far - side.near;
    barriers.push({ x: side.low - BARRIER_W / 2, z, w: BARRIER_W, d }, { x: side.high + BARRIER_W / 2, z, w: BARRIER_W, d });
    // Schod mezi úseky: příčný kus od hrany předchozího úseku k hraně tohoto, ať mantinel nemá díru.
    const previous = sides[index - 1];
    if (previous === undefined) return;
    for (const [from, to, out] of [[previous.low, side.low, -1], [previous.high, side.high, 1]] as const) {
      if (from === to) continue;
      const min = Math.min(from, to) + (out < 0 ? -BARRIER_W : 0);
      const max = Math.max(from, to) + (out > 0 ? BARRIER_W : 0);
      barriers.push({ x: (min + max) / 2, z: side.near, w: max - min, d: BARRIER_W });
    }
  });
  return { segments, barriers };
}
