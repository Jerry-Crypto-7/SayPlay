import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { compileGenre, readGenreSpec } from '@/play/genre/index';
import { voyageGenre } from '@/play/genre/voyage';

import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';

import { centerOf, nearShotsInView, voyageLayoutOf } from '../voyageLayout';

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;

function worldOf(id: string) {
  const read = readGenreSpec(voyageGenre.draftFill(SENTENCES.find((entry) => entry.id === id)!.text, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  const made = arcadeWorldOf(compileGenre(read.value), 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('voyageLayoutOf (P32F T4)', () => {
  it('reads the pirate as a boat race between island banks, with gates, cannonballs and the treasure', () => {
    const layout = voyageLayoutOf(worldOf('pirate'))!;
    expect(layout).toMatchObject({ mode: 'race', terrain: 'islands', motion: 'boat' });
    expect(layout.course).toBeDefined();
    expect(layout.walls.length).toBeGreaterThan(4);
    // Každý mantinel stojí vnitřní hranou u osy úseku: levé vlevo, pravé vpravo.
    for (const wall of layout.walls) expect(Math.sign(wall.inner - wall.x)).toBe(-wall.side);
    expect(layout.gates.length).toBeGreaterThan(0);
    expect(layout.hazards.some((hazard) => hazard.kind === 'shot')).toBe(true);
    expect(layout.goal).not.toBeNull();
  });

  // Revize P32 (stopa F): strana mantinelu, dosah, překážky a cíl piráta připíchnuté čísly.
  it('puts the left wall of each pirate section left of the right one, around the course center', () => {
    const layout = voyageLayoutOf(worldOf('pirate'))!;
    expect(layout.walls.filter((wall) => wall.side === -1)).toHaveLength(19);
    expect(layout.walls.filter((wall) => wall.side === 1)).toHaveLength(19);
    const byZ = new Map<number, (typeof layout.walls)[number][]>();
    for (const wall of layout.walls) byZ.set(wall.z, [...(byZ.get(wall.z) ?? []), wall]);
    expect(byZ.size).toBe(19);
    for (const pair of byZ.values()) {
      const left = pair.find((wall) => wall.side === -1)!;
      const right = pair.find((wall) => wall.side === 1)!;
      expect(left.x).toBeLessThan(right.x);
    }
    const at65 = [...byZ.values()].find((pair) => Math.abs(pair[0]!.z - 65) <= pair[0]!.d / 2)!;
    expect(at65).toHaveLength(2);
    expect(centerOf(layout.course, 65)).toBeCloseTo((at65[0]!.inner + at65[1]!.inner) / 2, 1);
  });

  it('reaches the pirate sea to the outer wall edge and lays shots and snags to the treasure at 350 m', () => {
    const layout = voyageLayoutOf(worldOf('pirate'))!;
    expect(layout.reach).toBeCloseTo(19.708, 2);
    expect(layout.reach).toBe(Math.max(...layout.walls.map((wall) => Math.abs(wall.x) + wall.w / 2)));
    expect(layout.hazards.map((hazard) => hazard.kind)).toEqual(['shot', 'snag', 'shot', 'snag', 'shot', 'snag']);
    expect(layout.goal!.z).toBe(350);
  });

  it('counts only live cannonballs near the camera and in view', () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const ball = (z: number, alive = true) => ({ at: new Vector3(0, 0, z), alive });
    expect(nearShotsInView([ball(-100)], camera.position, frustum)).toBe(0);
    expect(nearShotsInView([ball(-20)], camera.position, frustum)).toBe(1);
    expect(nearShotsInView([ball(-20, false)], camera.position, frustum)).toBe(0);
    expect(nearShotsInView([ball(20)], camera.position, frustum)).toBe(0);
    expect(nearShotsInView([ball(-20), ball(-30), ball(-100), ball(-10, false)], camera.position, frustum)).toBe(2);
  });

  it('reads the rocket as a lander over a pad beside it', () => {
    const layout = voyageLayoutOf(worldOf('rocket'))!;
    expect(layout).toMatchObject({ mode: 'land', terrain: 'rocks', motion: 'lander', walls: [], gates: [] });
    expect(layout.pad).not.toBeNull();
    expect(layout.hero.y).toBeGreaterThan(30);
    expect(Math.abs(layout.pad!.x)).toBeGreaterThan(10);
  });

  it('reads the dog as a street race and leaves a plain race to the road', () => {
    expect(voyageLayoutOf(worldOf('dog'))).toMatchObject({ terrain: 'buildings', motion: 'vehicle' });
    const plain = readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/steer.json'), 'utf8');
    const made = arcadeWorldOf(JSON.parse(plain), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(voyageLayoutOf(made.world)).toBeNull();
  });
});
