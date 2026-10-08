/**
 * **Brána před připojením meshe** (P15 T19).
 *
 * Devět negativních fixtur proti jedné platné. Brána je poslední místo, kde se
 * dá zastavit ošklivý svět, takže **všechny její zajímavé cesty jsou failure
 * cesty** — a ty se v provozu nespustí náhodou, tedy ani nejsou náhodou
 * otestované.
 *
 * ## Platná fixtura je krychle, ne náhodná čísla
 *
 * Osm vrcholů a dvanáct trojúhelníků, ručně, s indexy, které na sebe sedí.
 * Každá negativní fixtura z ní pak mění **právě jednu věc**, takže když
 * zčervená, je jasné co — a když neprojde ta platná, je jasné, že se rozbila
 * brána, ne fixtura.
 */

import { describe, expect, it } from 'vitest';

import { MESH_DETAIL, type Bounds3 } from '../../shape/types';
import type { MeshResult } from '../../shape/mesh-client';
import { isRetryable } from '../cache';
import {
  admitMesh,
  MAX_BOUNDS_VOLUME_RATIO,
  MAX_SLOT_MATERIALS,
  MESH_REJECTIONS,
  REJECTION_FAULT,
  verifyAttached,
  type GateOrder,
} from '../mesh-gate';

/* ------------------------------------------------------------------ *
 * Platná fixtura.
 * ------------------------------------------------------------------ */

const ORDERED: Bounds3 = { min: [-1, -1, -1], max: [1, 1, 1] };

const ORDER: GateOrder = { bounds: ORDERED, level: 'rough' };

/** Jednotková krychle: 8 vrcholů, 12 trojúhelníků, indexy na sebe sedí. */
function cube(): MeshResult {
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ]);
  const normals = new Float32Array(positions.length).fill(0.577_35);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1,
    5, 6, 1, 6, 2,
  ]);

  return {
    shapeId: 'ribs',
    positions,
    normals,
    indices,
    vertexCount: 8,
    triangleCount: 12,
    bounds: ORDERED,
    elapsedMs: 41,
  };
}

function broken(overrides: Partial<MeshResult>): MeshResult {
  return { ...cube(), ...overrides };
}

/* ------------------------------------------------------------------ *
 * Platný mesh projde.
 * ------------------------------------------------------------------ */

describe('admitMesh', () => {
  it('platný mesh projde a vrátí, co naměřil', () => {
    const verdict = admitMesh(cube(), ORDER);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.triangles).toBe(12);
      expect(verdict.bounds).toEqual(ORDERED);
    }
  });

  /* ---------------------------------------------------------------- *
   * Devět negativních fixtur.
   * ---------------------------------------------------------------- */

  const negatives: readonly (readonly [string, MeshResult, string])[] = [
    ['prázdná geometrie', broken({ triangleCount: 0, indices: new Uint32Array() }), 'NO_TRIANGLES'],
    [
      'přetečení trojúhelníků',
      broken({ triangleCount: MESH_DETAIL.rough.maxTriangles + 1, indices: new Uint32Array((MESH_DETAIL.rough.maxTriangles + 1) * 3) }),
      'TRIANGLE_BUDGET',
    ],
    [
      'nekonečné číslo ve vrcholu',
      (() => {
        const result = cube();
        const positions = Float32Array.from(result.positions);
        positions[7] = Number.POSITIVE_INFINITY;
        return broken({ positions });
      })(),
      'NON_FINITE',
    ],
    [
      'NaN v naměřeném kvádru',
      broken({ bounds: { min: [-1, Number.NaN, -1], max: [1, 1, 1] } }),
      'NON_FINITE',
    ],
    [
      'nulové bounds',
      broken({ bounds: { min: [0, 0, 0], max: [0, 0, 0] } }),
      'DEGENERATE_BOUNDS',
    ],
    [
      'bounds přes dvojnásobek cílového objemu',
      broken({ bounds: { min: [-1.5, -1.5, -1.5], max: [1.5, 1.5, 1.5] } }),
      'BOUNDS_OVERRUN',
    ],
    [
      'chybějící normály',
      broken({ normals: new Float32Array(12) }),
      'NORMALS_MISSING',
    ],
    [
      'index mimo pole vrcholů',
      (() => {
        const result = cube();
        const indices = Uint32Array.from(result.indices);
        indices[3] = 99;
        return broken({ indices });
      })(),
      'INDEX_OUT_OF_RANGE',
    ],
    [
      'počet trojúhelníků nesedí na indexy',
      broken({ triangleCount: 11 }),
      'READBACK_MISMATCH',
    ],
  ];

  it.each(negatives)('odmítne: %s', (_name, result, rejection) => {
    const verdict = admitMesh(result, ORDER);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rejection).toBe(rejection);
      // Kód, ne volný text: `MeshFailure` z něj rozhoduje o opakování.
      expect(MESH_REJECTIONS).toContain(verdict.rejection);
      expect(verdict.fault).toBe(REJECTION_FAULT[verdict.rejection]);
    }
  });

  it('devět negativních fixtur je devět různých příčin', () => {
    const seen = new Set(negatives.map(([, , rejection]) => rejection));
    // `NON_FINITE` pokrývají dvě fixtury (vrchol a kvádr) schválně — jsou to
    // dvě různá místa, kde nekonečno vzniká, a každé si najde jiná kontrola.
    expect(seen.size).toBe(8);
    expect(negatives).toHaveLength(9);
  });

  it('break-it-on-purpose: bounds 18× cílového objemu se odmítnou', () => {
    // 18násobek objemu je 2,62násobek na každé ose.
    const edge = Math.cbrt(18);
    const huge: Bounds3 = { min: [-edge, -edge, -edge], max: [edge, edge, edge] };
    const verdict = admitMesh(broken({ bounds: huge }), ORDER);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection).toBe('BOUNDS_OVERRUN');
  });

  it('kvádr těsně pod prahem projde — dotknout se své krabice je normální', () => {
    const edge = Math.cbrt(MAX_BOUNDS_VOLUME_RATIO) * 0.99;
    const snug: Bounds3 = { min: [-edge, -edge, -edge], max: [edge, edge, edge] };
    expect(admitMesh(broken({ bounds: snug }), ORDER).ok).toBe(true);
  });

  it('jemná mřížka má vlastní rozpočet trojúhelníků', () => {
    const many = MESH_DETAIL.rough.maxTriangles + 100;
    const result = broken({ triangleCount: many, indices: new Uint32Array(many * 3) });

    expect(admitMesh(result, { bounds: ORDERED, level: 'rough' }).ok).toBe(false);
    expect(admitMesh(result, { bounds: ORDERED, level: 'high' }).ok).toBe(true);
  });

  it('nekonečno se najde dřív, než se z čísel začne počítat poměr', () => {
    // Kvádr s `NaN` by v poměru objemů prošel jakýmkoli porovnáním, protože
    // `NaN > x` je `false`. Musí spadnout na `NON_FINITE`, ne projít.
    const verdict = admitMesh(broken({ bounds: { min: [-1, -1, -1], max: [Number.NaN, 1, 1] } }), ORDER);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection).toBe('NON_FINITE');
  });
});

/* ------------------------------------------------------------------ *
 * Kódy selhání a opakovatelnost.
 * ------------------------------------------------------------------ */

describe('kódy selhání', () => {
  it('každá příčina má `MeshFailure`, a jen kontrolní přečtení se opakuje', () => {
    for (const rejection of MESH_REJECTIONS) {
      const fault = REJECTION_FAULT[rejection];
      expect(fault).toBeDefined();
      // Meshovač je deterministický, takže druhý pokus dá totéž — jediná
      // příčina, u které opakování něco změní, je porucha mezi bránou
      // a zápisem.
      expect(isRetryable(fault)).toBe(rejection === 'READBACK_MISMATCH');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Kontrolní přečtení.
 * ------------------------------------------------------------------ */

const EXPECTED = {
  contentHash: 'hash-a',
  triangles: 12,
  bounds: ORDERED,
  anchors: ['base', 'top'],
} as const;

function readBack(overrides: Partial<Parameters<typeof verifyAttached>[1]> = {}) {
  return { ...EXPECTED, materials: 1, ...overrides };
}

describe('verifyAttached', () => {
  it('shoda ve všech čtyřech projde', () => {
    expect(verifyAttached(EXPECTED, readBack()).ok).toBe(true);
  });

  it.each([
    ['jiný hash', { contentHash: 'hash-b' }],
    ['jiný počet trojúhelníků', { triangles: 11 }],
    ['jiný kvádr', { bounds: { min: [-1, -1, -1], max: [1, 1, 2] } as Bounds3 }],
    ['chybějící kotva', { anchors: ['base'] }],
  ])('odmítne %s jako `READBACK_MISMATCH`', (_name, overrides) => {
    const verdict = verifyAttached(EXPECTED, readBack(overrides));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rejection).toBe('READBACK_MISMATCH');
      expect(verdict.fault).toBe('ARTIFACT_MISMATCH');
    }
  });

  it('exploze materiálů má vlastní kód a soudí se dřív než hash', () => {
    const verdict = verifyAttached(EXPECTED, readBack({
      materials: MAX_SLOT_MATERIALS + 1,
      contentHash: 'hash-b',
    }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection).toBe('MATERIAL_EXPLOSION');
  });

  it('kotva navíc nevadí, chybějící ano', () => {
    expect(verifyAttached(EXPECTED, readBack({ anchors: ['base', 'top', 'mouth'] })).ok).toBe(true);
  });
});
