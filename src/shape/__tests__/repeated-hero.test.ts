import { readFileSync, readdirSync, existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { validateShapeProgram } from '../schema';
import type { ShapeProgram } from '../types';

/** Případ c07 z galerie kvality 13. 9. 2026, zkrácený na to, co bránu rozhoduje:
 *  jeden strom o 5,3 m (torus se žebrem 15 cm) zopakovaný 3× a 2× do 14,5 m. */
function ribcageTrees(): ShapeProgram {
  return {
    shapeId: 'ribcageTrees',
    stableId: 'ribcageTrees',
    nodes: [
      { kind: 'torus', majorRadius: 1.65, minorRadius: 0.15 },
      { kind: 'capsule', height: 4.5, radius: 0.24 },
      { kind: 'union', children: [0, 1], k: 0.12 },
      { kind: 'translate', child: 2, offset: [-3.5, 0, -5] },
      { kind: 'repeat', child: 3, count: 3, step: [0, 0, 5] },
      { kind: 'repeat', child: 4, count: 2, step: [7, 0, 0] },
    ],
    root: 5,
    targetBounds: { min: [-5.5, -2.75, -7.25], max: [5.5, 2.75, 7.25] },
    anchors: [],
    materialIntent: 'bone',
    priority: 1,
  };
}

/** Řada dvou krychlí o hraně 2 m v krabici 3,5 m — poměr 1,75×, pod prahem. */
function boxRow(): ShapeProgram {
  return {
    shapeId: 'boxRow',
    stableId: 'boxRow',
    nodes: [
      { kind: 'box', size: [2, 2, 2] },
      { kind: 'translate', child: 0, offset: [-0.75, 0, 0] },
      { kind: 'repeat', child: 1, count: 2, step: [1.5, 0, 0] },
    ],
    root: 2,
    targetBounds: { min: [-1.75, -1, -1], max: [1.75, 1, 1] },
    anchors: [],
    materialIntent: 'stone',
    priority: 1,
  };
}

/** Týž program zabalený do `scale` a s krabicí zvětšenou stejně — na plátně je to tentýž tvar. */
function scaledBy(program: ShapeProgram, factor: number): ShapeProgram {
  return {
    ...program,
    nodes: [...program.nodes, { kind: 'scale', child: program.root, factor: [factor, factor, factor] }],
    root: program.nodes.length,
    targetBounds: {
      min: program.targetBounds.min.map((value) => value * factor) as [number, number, number],
      max: program.targetBounds.max.map((value) => value * factor) as [number, number, number],
    },
  };
}

const repeatsIssue = (program: ShapeProgram) =>
  validateShapeProgram(program).issues.some((value) => value.includes('repeats one'));

describe('a hero repeated inside its own shape', () => {
  /**
   * Revize před `/ship` 15. 9. 2026 (Codex P2, `ship-shapescale`): jednotka se
   * měřila v souřadnicích pod `scale`, krabice nad ním. `scale 2` s dvojnásobnou
   * krabicí tak z poměru 1,75× udělal 3,5× a odmítl tvar, který bez obalu
   * prošel; `scale 0,5` naopak pustil c07.
   */
  it.each([
    ['boxRow', 2, boxRow],
    ['boxRow', 0.5, boxRow],
    ['ribcageTrees', 2, ribcageTrees],
    ['ribcageTrees', 0.5, ribcageTrees],
  ] as const)('judges %s wrapped in scale %s like the same shape unwrapped', (_name, factor, make) => {
    expect(repeatsIssue(scaledBy(make(), factor))).toBe(repeatsIssue(make()));
  });

  it('keeps the two unwrapped shapes on either side of the threshold', () => {
    expect(repeatsIssue(boxRow())).toBe(false);
    expect(repeatsIssue(ribcageTrees())).toBe(true);
  });

  it('refuses c07 and names the unit, the copies and the cell it would get', () => {
    const result = validateShapeProgram(ribcageTrees());
    expect(result.ok).toBe(false);
    const issue = result.issues.find((value) => value.includes('repeats one'));
    // 14,5 m krabice / 32³ = 45 cm buňka proti žebru 15 cm.
    expect(issue).toMatch(/repeats one 5\.\d m unit 6 times/);
    expect(issue).toContain('45 cm cells');
    expect(issue).toContain('place the 6 copies in the composition');
  });

  it('says nothing about the same tree written once', () => {
    const single = ribcageTrees();
    const one: ShapeProgram = {
      ...single,
      nodes: single.nodes.slice(0, 4),
      root: 3,
      targetBounds: { min: [-2.7, -2.75, -2.7], max: [2.7, 2.75, 2.7] },
    };
    expect(validateShapeProgram(one)).toMatchObject({ ok: true });
  });

  /**
   * **Rozsah brány, ne její správnost.** Práh 2,0 vznikl z těchhle archivů, a
   * tenhle test je pojistka proti tomu, aby ho někdo posunul a nevšiml si, koho
   * tím odmítl. Když číslo poroste, není to samo o sobě chyba — je to důvod
   * podívat se, který tvar přibyl a proč.
   */
  it('touches two of the sixty-two shapes on disk and no more', () => {
    const programs: { id: string; program: unknown }[] = [];
    const visit = (value: unknown, origin: string): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) visit(item, origin); return; }
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.nodes) && typeof record.root === 'number' && record.targetBounds)
        programs.push({ id: `${origin}:${String(record.stableId ?? '?')}`, program: record });
      for (const item of Object.values(record)) visit(item, origin);
    };
    for (const path of ['evals/worldstream/create-raw.json', 'src/worldstream/authored-worlds.json'])
      if (existsSync(path)) visit(JSON.parse(readFileSync(path, 'utf8')), path);

    const refused = new Set<string>();
    for (const { id, program } of programs) {
      const result = validateShapeProgram(program);
      if (!result.ok && result.issues.some((value) => value.includes('repeats one'))) refused.add(id);
    }
    // Naměřeno 14. 9. 2026: `hangingHouses` 2,90× a `ribcageTrees` 2,52×.
    // Třetí tvar s polem u kořene (`sortingChutes`) je na 1,01× a projde.
    expect([...new Set([...refused].map((value) => value.split(':')[1]))].sort())
      .toEqual(['hangingHouses', 'ribcageTrees']);
    expect(programs.length).toBeGreaterThan(40);
  });
});
