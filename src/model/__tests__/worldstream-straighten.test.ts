/**
 * Narovnání programů před bránou (`worldstream-straighten.ts`).
 *
 * Každý případ je tvar odpovědi, který 12.–13. 9. 2026 stál placené opravné
 * kolo (`evals/worldstream/latency-report.json`), a každý má dvě půlky:
 * narovnaný program **projde** bránou a panel se dozví, co se stalo. Třetí
 * půlka je společná: platný program se nedotkne a nic se o něm nezapíše.
 */

import { describe, expect, it } from 'vitest';

import { GEOM_LIMITS, GEOM_VERSION, instanceCounts, parseGeomProgram, validateGeomProgram } from '../../geom/program';
import { validateShapeProgram } from '../../shape/schema';
import type { BlueprintAdjustment } from '../worldstream-compiler';
import { straightenGeometry, straightenShape } from '../worldstream-straighten';

const GEOMETRY: Record<string, unknown> = {
  version: GEOM_VERSION,
  nodes: [
    { kind: 'terrain', variant: 'plateau', extent: [20, 20], amplitude: 0.4, seed: 3 },
    { kind: 'column', variant: 'post', at: [-3, 0.5, 0] },
    { kind: 'repeat', child: 1, count: 4, step: [2, 0, 0] },
    { kind: 'fixture', variant: 'crate', at: [2, 0.3, 3] },
    { kind: 'group', children: [0, 2, 3] },
  ],
  root: 4,
};

const SHAPE: Record<string, unknown> = {
  shapeId: 'hivePost',
  stableId: 'tallHive',
  nodes: [
    { kind: 'prism', sides: 6, radius: 0.5, height: 1.4 },
    { kind: 'taper', child: 0, axis: 'y', amount: 0.6 },
  ],
  root: 1,
  targetBounds: { min: [-0.7, -0.9, -0.7], max: [0.7, 0.9, 0.7] },
  anchors: [],
  materialIntent: 'timber',
  priority: 8,
};

const nodesOf = (table: unknown): Record<string, unknown>[] =>
  (table as { nodes: Record<string, unknown>[] }).nodes;

function geometryWith(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...GEOMETRY, ...patch };
}

describe('a valid program is left exactly as written', () => {
  it('geometry: same table, no adjustment, identity remap', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const out = straightenGeometry(GEOMETRY, adjustments);
    expect(out.value).toEqual(GEOMETRY);
    expect(adjustments).toEqual([]);
    expect([0, 1, 2, 3, 4].map(out.remap)).toEqual([0, 1, 2, 3, 4]);
  });

  it('shape: same table, no adjustment', () => {
    const adjustments: BlueprintAdjustment[] = [];
    expect(straightenShape(SHAPE, 0, adjustments)).toEqual(SHAPE);
    expect(adjustments).toEqual([]);
  });

  it('something that is not a table passes through untouched', () => {
    const adjustments: BlueprintAdjustment[] = [];
    expect(straightenGeometry('a lighthouse', adjustments).value).toBe('a lighthouse');
    expect(straightenGeometry({ nodes: 'no', root: 0 }, adjustments).value).toEqual({ nodes: 'no', root: 0 });
    expect(straightenShape(null, 0, adjustments)).toBeNull();
    expect(adjustments).toEqual([]);
  });

  it('a root that is not a row index is left for the gate instead of throwing', () => {
    // Codex review 15. 9. 2026: kořen -1 prošel jen horní mezí a narovnání spadlo,
    // takže generování skončilo výjimkou místo odmítnutí a opravného kola.
    for (const root of [-1, 1.5]) {
      const table = { version: GEOM_VERSION, nodes: [{ kind: 'group', children: [] }], root };
      const adjustments: BlueprintAdjustment[] = [];
      expect(straightenGeometry(table, adjustments).value, `root ${root}`).toEqual(table);
      expect(validateGeomProgram(table).ok, `root ${root}`).toBe(false);
    }
  });
});

describe('a group wider than 16 children is nested, not refused', () => {
  // 20 sloupů v jednom `group` — naměřeno u `gpt-5.6-terra@low`, věta c13.
  const columns = Array.from({ length: 20 }, (_, i) => ({ kind: 'column', variant: 'post', at: [i, 0, 0] }));
  const wide = geometryWith({ nodes: [...columns, { kind: 'group', children: columns.map((_, i) => i) }], root: 20 });

  it('validates after straightening and keeps every column reachable', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const out = straightenGeometry(wide, adjustments);
    expect(validateGeomProgram(out.value)).toEqual({ ok: true, issues: [] });
    expect(instanceCounts(parseGeomProgram(out.value).nodes)[(out.value as { root: number }).root]).toBe(20);
    expect(adjustments.map((a) => a.path)).toEqual(['geometry/nodes/20/children']);
    expect(adjustments[0].reason).toContain('20 children');
  });

  it('remaps the root and the placements that pointed at it', () => {
    const out = straightenGeometry(wide, []);
    // Držák se vložil pod kořen, takže kořen se posunul o jedna; sloupy ne.
    expect(out.remap(20)).toBe(21);
    expect(out.remap(3)).toBe(3);
    expect((out.value as { root: number }).root).toBe(21);
  });

  it('refuses to guess when the rejection is a different one', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const broken = geometryWith({ nodes: [{ kind: 'group', children: [1] }, { kind: 'mass', variant: 'block' }], root: 0 });
    const out = straightenGeometry(broken, adjustments);
    expect(validateGeomProgram(out.value).ok).toBe(false);
    expect(adjustments).toEqual([]);
  });
});

describe('a union wider than 8 children is nested', () => {
  const balls = Array.from({ length: 10 }, (_, i) => ({ kind: 'sphere', radius: 0.2 + i * 0.01 }));

  it('union: the last children move into a union of their own', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const wide = { ...SHAPE, nodes: [...balls, { kind: 'union', children: balls.map((_, i) => i) }], root: 10 };
    const out = straightenShape(wide, 2, adjustments);
    expect(validateShapeProgram(out)).toEqual({ ok: true, issues: [] });
    expect(nodesOf(out)[10]).toEqual({ kind: 'union', children: [7, 8, 9] });
    expect(nodesOf(out)[11]).toEqual({ kind: 'union', children: [0, 1, 2, 3, 4, 5, 6, 10] });
    expect(adjustments.map((a) => a.path)).toEqual(['shapes/2/nodes/10/children']);
  });

  it('subtract: the holder is a union, so a − b − c stays a − (b ∪ c)', () => {
    const wide = { ...SHAPE, nodes: [...balls, { kind: 'subtract', children: balls.map((_, i) => i) }], root: 10 };
    const out = straightenShape(wide, 0, []);
    expect(validateShapeProgram(out).ok).toBe(true);
    expect(nodesOf(out)[10].kind).toBe('union');
    expect(nodesOf(out)[11].kind).toBe('subtract');
  });
});

describe('numbers past a limit are clamped and said so', () => {
  it('geometry scale above 8 and below 0.1', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const nodes = [...nodesOf(GEOMETRY)];
    nodes[1] = { ...nodes[1], scale: [12, 0.05, 1] };
    const out = straightenGeometry(geometryWith({ nodes }), adjustments);
    expect(validateGeomProgram(out.value).ok).toBe(true);
    expect(nodesOf(out.value)[1].scale).toEqual([8, 0.1, 1]);
    expect(adjustments).toEqual([
      expect.objectContaining({ path: 'geometry/nodes/1/scale/0', from: 12, to: 8 }),
      expect.objectContaining({ path: 'geometry/nodes/1/scale/1', from: 0.05, to: 0.1 }),
    ]);
  });

  it('shape scale factor above 20', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const nodes = [...nodesOf(SHAPE), { kind: 'scale', child: 1, factor: [1, 40, 1] }];
    const out = straightenShape({ ...SHAPE, nodes, root: 2 }, 0, adjustments);
    expect(validateShapeProgram(out).ok).toBe(true);
    expect(nodesOf(out)[2].factor).toEqual([1, 20, 1]);
    expect(adjustments[0].path).toBe('shapes/0/nodes/2/factor/1');
  });
});

describe('a curve with more than 8 points keeps its ends and thins the middle', () => {
  it('shape arrayAlongCurve.points 12 → 8', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const points = Array.from({ length: 12 }, (_, i) => [i, 0, 0]);
    const nodes = [...nodesOf(SHAPE), { kind: 'arrayAlongCurve', child: 1, count: 4, points }];
    const out = straightenShape({ ...SHAPE, nodes, root: 2 }, 0, adjustments);
    expect(validateShapeProgram(out).ok).toBe(true);
    const picked = nodesOf(out)[2].points as number[][];
    expect(picked).toHaveLength(8);
    expect(picked[0]).toEqual([0, 0, 0]);
    expect(picked[7]).toEqual([11, 0, 0]);
    expect(adjustments[0]).toEqual(expect.objectContaining({ path: 'shapes/0/nodes/2/points', from: 12, to: 8 }));
  });

  it('geometry sweep profile 10 → 8', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const profile = Array.from({ length: 10 }, (_, i) => [Math.cos((i / 10) * Math.PI * 2), Math.sin((i / 10) * Math.PI * 2)]);
    const sweep = { kind: 'sweep', profile, path: [[0, 0, 0], [0, 4, 0]], segments: 4, swatch: 'sand' };
    const nodes = [...nodesOf(GEOMETRY), sweep, { kind: 'group', children: [4, 5] }];
    const out = straightenGeometry(geometryWith({ nodes, root: 6 }), adjustments);
    expect(validateGeomProgram(out.value)).toEqual({ ok: true, issues: [] });
    expect(nodesOf(out.value)[5].profile).toHaveLength(8);
  });
});

describe('an unknown variant is read as the nearest known one', () => {
  it.each([
    ['oilBarrel', 'barrel'],
    ['Crates', 'crate'],
    ['chandelier', 'crate'],
  ])('%s → %s', (written, expected) => {
    const adjustments: BlueprintAdjustment[] = [];
    const nodes = [...nodesOf(GEOMETRY)];
    nodes[3] = { ...nodes[3], variant: written };
    const out = straightenGeometry(geometryWith({ nodes }), adjustments);
    expect(validateGeomProgram(out.value).ok).toBe(true);
    expect(nodesOf(out.value)[3].variant).toBe(expected);
    expect(adjustments[0].reason).toContain(written);
  });

  it('never touches a kind without variants or a valid variant', () => {
    const adjustments: BlueprintAdjustment[] = [];
    straightenGeometry(GEOMETRY, adjustments);
    expect(adjustments).toEqual([]);
  });
});

describe('a row nothing reaches', () => {
  it('geometry: below the root group it is added to it', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const nodes = [...nodesOf(GEOMETRY)];
    nodes[4] = { kind: 'group', children: [0, 2] }; // řádek 3 (bedna) vypadl z kořene
    const out = straightenGeometry(geometryWith({ nodes }), adjustments);
    expect(validateGeomProgram(out.value)).toEqual({ ok: true, issues: [] });
    expect(nodesOf(out.value)[4].children).toEqual([0, 2, 3]);
    expect(adjustments[0].reason).toContain('rows 3');
  });

  it('geometry: above the root it is left out and the rows after it move down', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const nodes = [...nodesOf(GEOMETRY), { kind: 'mass', variant: 'block', at: [0, 0, 0] }];
    const out = straightenGeometry(geometryWith({ nodes }), adjustments);
    expect(validateGeomProgram(out.value)).toEqual({ ok: true, issues: [] });
    expect(nodesOf(out.value)).toHaveLength(5);
    expect(adjustments[0]).toEqual(expect.objectContaining({ path: 'geometry/nodes', from: 6, to: 5 }));
  });

  it('geometry: a row a placement points at is never dropped, so the gate still says why', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const nodes = [...nodesOf(GEOMETRY), { kind: 'mass', variant: 'block', at: [0, 0, 0] }];
    const out = straightenGeometry(geometryWith({ nodes }), adjustments, new Set([5]));
    expect(validateGeomProgram(out.value).issues.join(' ')).toContain('cannot be reached');
    expect(adjustments).toEqual([]);
  });

  it('shape: it is dropped and the indices after it move down', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const nodes = [{ kind: 'sphere', radius: 1 }, ...nodesOf(SHAPE).map((n) => ('child' in n ? { ...n, child: 1 } : n))];
    const out = straightenShape({ ...SHAPE, nodes, root: 2 }, 0, adjustments);
    expect(validateShapeProgram(out)).toEqual({ ok: true, issues: [] });
    expect(nodesOf(out)).toEqual(nodesOf(SHAPE));
    expect((out as { root: number }).root).toBe(1);
  });
});

describe('a program over the instance budget is trimmed by the widest multiplier', () => {
  it('repeat 16 over scatter 24 = 384 comes down to at most maxInstances, one copy at a time', () => {
    const adjustments: BlueprintAdjustment[] = [];
    const nodes = [
      { kind: 'organic', variant: 'shrub', at: [0, 0, 0] },
      { kind: 'scatter', child: 0, count: 24, radius: 6, seed: 1 },
      { kind: 'repeat', child: 1, count: 16, step: [0, 0, 8] },
      { kind: 'group', children: [2] },
    ];
    const out = straightenGeometry(geometryWith({ nodes, root: 3 }), adjustments);
    expect(validateGeomProgram(out.value)).toEqual({ ok: true, issues: [] });
    const expanded = instanceCounts(parseGeomProgram(out.value).nodes)[3];
    expect(expanded).toBeLessThanOrEqual(GEOM_LIMITS.maxInstances);
    expect(expanded).toBeGreaterThan(GEOM_LIMITS.maxInstances / 2);
    expect(adjustments.every((a) => a.reason.includes('maxInstances'))).toBe(true);
    expect(adjustments.map((a) => a.path).sort()).toEqual(['geometry/nodes/1/count', 'geometry/nodes/2/count']);
  });
});
