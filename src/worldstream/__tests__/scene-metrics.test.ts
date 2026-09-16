import { describe, expect, it } from 'vitest';

import { GEOM_VERSION, type GeomProgram } from '../../geom/program';
import type { PlannedObject } from '../../model/worldstream-intent';
import type { SemanticObject } from '../schema';
import { sceneMetrics } from '../scene-metrics';

/**
 * „Medián 3 objekty" z P18 počítal deklarované objekty. Tenhle report se umí
 * splést stejně, a na snímku by to nikdo nepoznal — proto pin nad rozvinutím
 * a nad pokrytím objektů, které plán jmenoval.
 */

const geometry: GeomProgram = {
  version: GEOM_VERSION,
  nodes: [
    { kind: 'fixture', variant: 'crate', at: [0, 0, 0] },
    { kind: 'repeat', child: 0, count: 6, step: [2, 0, 0] },
    { kind: 'fixture', variant: 'bench', at: [0, 0, 5] },
    { kind: 'group', children: [1, 2] },
  ],
  root: 3,
} as GeomProgram;

const planned = (stableId: string, label: string, role: PlannedObject['role'] = 'prop'): PlannedObject => ({
  stableId,
  label,
  synonyms: [],
  role,
  importance: 2,
});

const placed = (object: PlannedObject, node: number): SemanticObject => ({
  ...object,
  synonyms: [],
  source: { kind: 'geom', node },
  targetBounds: { min: [0, 0, 0], max: [1, 1, 1] },
});

const crates = planned('crates', 'row of crates');
const bench = planned('bench', 'bench');
const aquarium = planned('aquarium', 'aquarium', 'hero');
const mist = planned('mist', 'mist', 'effect');

describe('scene metrics', () => {
  it('counts pieces after the repeat is expanded, not declared objects', () => {
    const report = sceneMetrics({ geometry, objects: [placed(crates, 1), placed(bench, 2)], shapes: [] }, [crates, bench]);
    expect(report.visiblePieces).toBe(7);
    expect(report.nounCoverage).toBe(1);
    expect(report.missing).toEqual([]);
  });

  it('names the aquarium the plan asked for and the blueprint does not have', () => {
    const report = sceneMetrics(
      { geometry, objects: [placed(crates, 1), placed(bench, 2)], shapes: [] },
      [crates, bench, aquarium],
    );
    expect(report.nounCoverage).toBeCloseTo(2 / 3);
    expect(report.missing).toEqual(['aquarium']);
  });

  it('counts an object made only of other objects as built, and leaves effects out', () => {
    const room = planned('room', 'room', 'architecture');
    const report = sceneMetrics(
      { geometry, objects: [placed(crates, 1), placed(bench, 2), placed(room, 3)], shapes: [] },
      [crates, bench, room, mist],
    );
    expect(report.nounCoverage).toBe(1);
  });

  it('sums support and collisions over the expanded pieces', () => {
    const report = sceneMetrics({ geometry, objects: [placed(crates, 1), placed(bench, 2)], shapes: [] }, [crates, bench]);
    const floating: GeomProgram = {
      version: GEOM_VERSION,
      nodes: [
        { kind: 'fixture', variant: 'crate', at: [0, 0.3, 0] },
        { kind: 'fixture', variant: 'crate', at: [0.1, 0.3, 0] },
        { kind: 'panel', variant: 'window', at: [5, 3, 0] },
        { kind: 'group', children: [0, 1, 2] },
      ],
      root: 3,
    } as GeomProgram;
    // Report měří scénu, jak ji uvidí kamera – po usazení (`src/geom/settle.ts`):
    // bedny stojí na podlaze a prolínají se, okno zůstává viset nahoře.
    const hanging = sceneMetrics({ geometry: floating, objects: [placed(crates, 3)], shapes: [] }, [crates]);
    expect(hanging.unsupportedPieces).toBe(1);
    expect(hanging.collisions).toBe(1);
    expect(report.collisions).toBe(0);
  });
});
