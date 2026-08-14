import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { KIT, KIT_BUDGETS, buildKitScene, measureScene, trianglesOf } from '../index';

const SRC_ROOT = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('kit se vejde do rozpočtu', () => {
  it('má mezi 36 a 44 kusy z jednoho indexu', () => {
    expect(KIT.length).toBeGreaterThanOrEqual(KIT_BUDGETS.minPieces);
    expect(KIT.length).toBeLessThanOrEqual(KIT_BUDGETS.maxPieces);
  });

  it('žádné dvě id se neopakují', () => {
    const ids = KIT.map((piece) => piece.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(KIT.map((piece) => [piece.id, piece] as const))(
    '%s je pod stropem trojúhelníků na kus',
    (_id, piece) => {
      const geometry = piece.build();
      expect(trianglesOf(geometry)).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerPiece);
      geometry.dispose();
    },
  );

  it('scéna se všemi kusy najednou je pod oběma stropy', () => {
    const scene = buildKitScene();
    const measured = measureScene(scene);

    expect(measured.drawCalls).toBe(KIT.length);
    expect(measured.drawCalls).toBeLessThanOrEqual(KIT_BUDGETS.maxDrawCallsPerWorld);
    expect(measured.triangles).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerWorld);
    expect(Number.isInteger(measured.triangles)).toBe(true);
  });

  it('measureScene počítá každý materiál zvlášť, ne jen meshe', () => {
    // Bez tohohle by měření mohlo být `počet meshů` a nikdo by se to nedozvěděl,
    // dokud by layout nepoužil víc materiálů na jednu geometrii.
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(1, 1, 1), [new MeshBasicMaterial(), new MeshBasicMaterial()]));

    expect(measureScene(group)).toEqual({ drawCalls: 2, triangles: 12 });
  });
});

describe('importní hygiena', () => {
  it('nikde v src/ není barrel import z @react-three/drei', () => {
    // Barrel táhne `@mediapipe/tasks-vision` a `hls.js` do bundlu. Povolené jsou
    // jen deep-path importy (`@react-three/drei/core/...`).
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) =>
        /(?:from|import|require\()\s*['"]@react-three\/drei['"]/.test(readFileSync(file, 'utf-8')),
      )
      .map((file) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });

  it('nikde v src/ není <Environment preset> z drei', () => {
    // Stahuje HDRI z raw.githack.com za běhu, čímž rozbije „žádný loading
    // screen" i service worker.
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => /<Environment[^>]*\spreset=/.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });
});
