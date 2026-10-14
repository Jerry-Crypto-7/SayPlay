/**
 * Silnice závodu ve scéně (P46D R2): asfalt ve skutečné šířce úseků a souvislé
 * mantinely, takže zúžení, šikany a rozcestí jsou vidět.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { UNIT } from '@/play/arcade/contract';
import { STEER_SHAPE } from '@/play/arcade/pieces/steer';
import { draftGameSpecWithMeta } from '@/play/draft';

import { BARRIER_W, roadShapeOf } from '../road-shape';

function race(text: string, style: string, seed = 3): ArcadeWorld {
  const spec = draftGameSpecWithMeta(text, 1).spec;
  expect((spec.controlParams as { style?: string }).style, text).toBe(style);
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('silnice závodu ve scéně', () => {
  it('kreslí každý úsek v jeho šířce: ulice se zúží proti široké první třetině', () => {
    const { segments } = roadShapeOf(race('A car races through the city', 'streets'));
    expect(segments.length).toBeGreaterThan(10);
    const widths = segments.map((segment) => segment.width);
    expect(Math.min(...widths)).toBeLessThan(0.5 * (widths[0] as number));
    // Úseky na sebe navazují bez mezery.
    for (let i = 1; i < segments.length; i += 1) expect(segments[i]!.near).toBeCloseTo(segments[i - 1]!.far, 3);
  });

  it('má souvislé mantinely: podél obou hran každého úseku a příčný kus na každém schodu', () => {
    const { segments, barriers } = roadShapeOf(race('A car races through the city', 'streets'));
    for (const segment of segments) {
      const mid = (segment.near + segment.far) / 2;
      for (const x of [segment.center - segment.width / 2 - BARRIER_W / 2, segment.center + segment.width / 2 + BARRIER_W / 2]) {
        expect(barriers.some((barrier) => Math.abs(barrier.x - x) < 1e-6 && Math.abs(barrier.z - mid) < 1e-6 && barrier.d === segment.far - segment.near), `${segment.near}/${x}`).toBe(true);
      }
    }
    for (let i = 1; i < segments.length; i += 1) {
      const [a, b] = [segments[i - 1]!, segments[i]!];
      for (const [from, to] of [[a.center - a.width / 2, b.center - b.width / 2], [a.center + a.width / 2, b.center + b.width / 2]] as const) {
        if (Math.abs(from - to) < 1e-6) continue;
        // Příčný kus leží na hranici úseků a pokryje celý schod.
        const covers = barriers.some((barrier) => barrier.d === BARRIER_W && Math.abs(barrier.z - b.near) < 1e-6 && barrier.x - barrier.w / 2 <= Math.min(from, to) + 1e-6 && barrier.x + barrier.w / 2 >= Math.max(from, to) - 1e-6);
        expect(covers, `step at ${b.near} m from ${from} to ${to}`).toBe(true);
      }
    }
  });

  it('kreslí ostrůvek rozcestí uprostřed úseku', () => {
    const world = race('shopping cart race in a supermarket', 'aisles');
    const { segments, barriers } = roadShapeOf(world);
    const islands = barriers.filter((barrier) => barrier.w === STEER_SHAPE.divider / UNIT);
    expect(islands.length).toBeGreaterThan(0);
    for (const island of islands) {
      const host = segments.find((segment) => island.z > segment.near && island.z < segment.far)!;
      expect(Math.abs(island.x - host.center)).toBeLessThan(host.width / 4);
      expect(island.d).toBeGreaterThan(10);
    }
  });
});
