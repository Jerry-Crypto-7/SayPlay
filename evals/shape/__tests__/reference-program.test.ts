/**
 * Pin referenčního tvaru (P13 vlna 1 T5).
 *
 * `mesh-budget.json` je časová řada a **řada dává smysl jen tehdy, když každý
 * řádek měří tutéž práci**. Kdyby se program přepsal, čísla by se pohnula a
 * vypadalo by to jako regrese prohlížeče. Tohle je jediná zábrana, protože
 * samotné měření je e2e a to se pouští ručně.
 */

import { describe, expect, it } from 'vitest';

import {
  OUT_OF_LADDER_GRIDS,
  REFERENCE_BOUNDS,
  REFERENCE_GRIDS,
  REFERENCE_SHAPE_FACTS,
  referenceProgram,
} from '../reference-program';
import { validateShapeProgram } from '../../../src/shape/schema';
import {
  MESH_DETAIL,
  SHAPE_LIMITS,
  depths,
  evaluationCounts,
  instanceCounts,
} from '../../../src/shape/types';

describe('referenční program pro rozpočet meshingu', () => {
  it('projde bránou jazyka', () => {
    const verdict = validateShapeProgram(referenceProgram());
    expect(verdict.issues).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('má připnutou velikost, hloubku, kopie i vyhodnocení', () => {
    const { nodes, root } = referenceProgram();

    expect(nodes).toHaveLength(REFERENCE_SHAPE_FACTS.nodeCount);
    expect(depths(nodes)[root]).toBe(REFERENCE_SHAPE_FACTS.depth);
    expect(instanceCounts(nodes)[root]).toBe(REFERENCE_SHAPE_FACTS.instances);
    expect(evaluationCounts(nodes)[root]).toBe(REFERENCE_SHAPE_FACTS.evaluationsPerCell);
  });

  it('nese všechny čtyři vlastnosti, o kterých design book §11.2 mluví', () => {
    const kinds = referenceProgram().nodes.map((node) => node.kind);

    // Plynulé sjednocení: `union` s `k > 0`, ne jen `union`.
    const smooth = referenceProgram().nodes.filter(
      (node) => node.kind === 'union' && (node.k ?? 0) > 0,
    );
    expect(smooth.length).toBeGreaterThan(0);

    expect(kinds).toContain('repeat');
    expect(kinds).toContain('twist');
    expect(kinds).toContain('subtract');
  });

  it('nechává rezervu ke všem pěti stropům jazyka', () => {
    // Program **na** stropu by měřil bránu, ne cenu: první úprava tvaru by ho
    // shodila na validaci místo na čase.
    const { nodes, root } = referenceProgram();

    expect(nodes.length).toBeLessThan(SHAPE_LIMITS.maxNodes);
    expect(depths(nodes)[root]).toBeLessThan(SHAPE_LIMITS.maxDepth);
    expect(instanceCounts(nodes)[root]).toBeLessThan(SHAPE_LIMITS.maxInstances);
    expect(evaluationCounts(nodes)[root]).toBeLessThan(SHAPE_LIMITS.maxEvaluations);
  });

  it('měří všechny mřížky ve stejném kvádru', () => {
    // Rezerva kolem tvaru, ne těsný opsaný kvádr — `paddedBounds` v
    // `surface-nets.ts` ukázal, že tvar přetékající svůj kvádr zmizí celý.
    const { targetBounds } = referenceProgram();
    expect(targetBounds).toEqual(REFERENCE_BOUNDS);

    expect([...REFERENCE_GRIDS]).toEqual([32, 48, 64, 96]);
  });

  it('měří obě příčky žebříku i obě mřížky, které z něj vypadly', () => {
    // Report by beze zbytku ztratil smysl, kdyby přestal měřit 64³: rozhodnutí
    // z 29. 8. 2026 stojí právě na tom čísle a bez něj by za rok nešlo poznat,
    // jestli se žebřík snížil kvůli měření, nebo kvůli náladě.
    const measured = new Set<number>(REFERENCE_GRIDS);

    expect(measured.has(MESH_DETAIL.rough.resolution)).toBe(true);
    expect(measured.has(MESH_DETAIL.high.resolution)).toBe(true);
    for (const resolution of OUT_OF_LADDER_GRIDS) {
      expect(measured.has(resolution)).toBe(true);
    }
  });

  it('drží žebřík detailu tam, kam ho posunulo měření', () => {
    // Rozhodnutí uživatele z 29. 8. 2026 po měření v prohlížeči. Kdyby se
    // někdo vrátil k 64³, spadne tohle dřív, než se pustí e2e měření na
    // deset minut — a spadne to s důvodem, ne s naměřenou milisekundou.
    expect(MESH_DETAIL.rough.resolution).toBe(32);
    expect(MESH_DETAIL.high.resolution).toBe(48);
    expect(OUT_OF_LADDER_GRIDS).toContain(64);

    // Tři hrdinské objekty ve vysokém detailu se musí vejít pod strop celé
    // scény z úlohy T2 (`renderer.info.render.triangles` pod 120 000), jinak
    // je rozpočet jednoho objektu splnitelný a rozpočet světa ne.
    expect(3 * MESH_DETAIL.high.maxTriangles).toBeLessThanOrEqual(120_000);
    expect(MESH_DETAIL.rough.maxTriangles).toBeLessThan(MESH_DETAIL.high.maxTriangles);
    expect(MESH_DETAIL.rough.maxMs).toBeLessThan(MESH_DETAIL.high.maxMs);
  });
});
