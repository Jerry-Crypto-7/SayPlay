import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Box3 } from 'three';
import { describe, expect, it } from 'vitest';

import { compileGeomProgram, trianglesOfGeometry } from '@/geom/compile';
import { FAMILIES } from '@/geom/families';
import type { GeomProgram } from '@/geom/program';

import { FAMILY_REACH } from '../blueprint';
import { compileGame } from '../index';
import { readGameSpec } from '../../spec';

/**
 * Kulisy gridu vcelku (P28D T5, F-28). Řez `carve` zahazuje trojúhelníky podle
 * těžiště, takže z velkých stěn a strmého terénu rodiny, které zasáhl, zbyly
 * zubaté šedé střepy přes pozadí. Rodina proto stojí za plochou tak daleko, že
 * řez z ní neubere ani jeden trojúhelník – a tohle to hlídá přes všechny
 * čtyři rodiny a největší mřížky.
 */

const fixturesDir = fileURLToPath(new URL('../../__fixtures__/', import.meta.url));
const GRID_FIXTURES = ['collect_exit', 'delivery', 'chase_escape', 'hazard_crossing', 'combat_lite', 'switch_puzzle'];

function subProgram(program: GeomProgram, root: number): GeomProgram {
  return { version: program.version, nodes: program.nodes.slice(0, root + 1), root };
}

describe('grid scenery – the arena cut leaves the family whole', () => {
  it('no family reaches past its FAMILY_REACH on either ground axis', () => {
    for (const family of FAMILIES) {
      for (let seed = 0; seed < 6; seed += 1) {
        const geometry = compileGeomProgram(family.compose(seed));
        const box = new Box3().setFromBufferAttribute(geometry.getAttribute('position') as never);
        geometry.dispose();
        const reach = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
        expect(reach, `${family.id}#${seed}`).toBeLessThanOrEqual(FAMILY_REACH[family.id] as number);
      }
    }
  });

  it('the carve removes zero triangles for every grid fixture and family', () => {
    const families = new Set<string>();
    for (const name of GRID_FIXTURES) {
      const spec = readGameSpec(JSON.parse(readFileSync(`${fixturesDir}${name}.json`, 'utf8')));
      if (!spec.ok) throw new Error(`${name}: ${spec.issues.join('; ')}`);
      for (let seed = 1; seed <= 12; seed += 1) {
        const compiled = compileGame(spec.value, seed);
        if (!compiled.ok) continue;
        const blueprint = compiled.value.blueprint!;
        const geometry = blueprint.geometry;
        // Poslední řez je ten kolem plochy; rodiny mají vlastní.
        const carveAt = geometry.nodes.map((node) => node.kind).lastIndexOf('carve');
        expect(carveAt, `${name}#${seed}: no carve`).toBeGreaterThanOrEqual(0);
        const carve = geometry.nodes[carveAt] as { child: number };
        const before = compileGeomProgram(subProgram(geometry, carve.child));
        const after = compileGeomProgram(subProgram(geometry, carveAt));
        expect(trianglesOfGeometry(after), `${name}#${seed}`).toBe(trianglesOfGeometry(before));
        before.dispose();
        after.dispose();
        for (const module of Object.values(blueprint.world.look.modules ?? {})) families.add((module as { family: string }).family);
      }
    }
    expect([...families].sort()).toEqual(FAMILIES.map((family) => family.id).sort());
  });
});
