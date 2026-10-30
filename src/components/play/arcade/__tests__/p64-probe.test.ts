/**
 * Sonda záběru na výšku (P64 T1): `spreadOf` dá obdélník NDC přes hrdinu a všechny živé cíle před kamerou a spočítá,
 * kolik jich má střed mimo plátno; `cameraOf` otisk kamery pro stráž šířky. Obojí jen čte scénu – kamera ani těla se
 * nepohnou a relace hraje do bitu stejně se sondou i bez ní.
 */

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from 'three';
import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { hashArcade } from '@/play/arcade/kernel';
import { readGameSpec } from '@/play/spec';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';

import { cameraOf, frameOf, spreadOf } from '../ArcadeStage';
import { TICK_MS, createArcadeSession } from '../session';

/** Krychle 1 m se středem v bodě. */
function cube(x: number, y: number, z: number): Group {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  group.position.set(x, y, z);
  return group;
}

/** Kamera 10 m před počátkem, kouká na něj, čtvercové plátno 90° – NDC = x / (10 − z). */
function stage(): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  scene.add(camera);
  return { scene, camera };
}

describe('P64 frame probe', () => {
  it('spreads over the hero and every target in front of the camera and counts the ones off the canvas', () => {
    const { scene, camera } = stage();
    const hero = cube(0, 0, 0);
    const left = cube(-4, 2, 0);
    // Střed 12 m vpravo na 10 m hloubky: NDC x = 1,2, mimo plátno do strany.
    const off = cube(12, 0, 0);
    const behind = cube(0, 0, 12);
    for (const body of [hero, left, off, behind]) scene.add(body);
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();

    const spread = spreadOf([hero, left, off, behind], camera, 400, 400)!;
    expect(spread.bodies).toBe(3);
    expect(spread.outX).toBe(1);
    expect(spread.outY).toBe(0);
    // Rozsah = obálka obdélníků těl, která se počítají (bez toho za kamerou).
    const boxes = [hero, left, off].map((body) => frameOf(body, camera, 400, 400, false)!);
    expect(spread.minX).toBeCloseTo(Math.min(...boxes.map((box) => box.minX)), 9);
    expect(spread.maxX).toBeCloseTo(Math.max(...boxes.map((box) => box.maxX)), 9);
    expect(spread.minY).toBeCloseTo(Math.min(...boxes.map((box) => box.minY)), 9);
    expect(spread.maxY).toBeCloseTo(Math.max(...boxes.map((box) => box.maxY)), 9);
    // Levá krychle: střed x = −4 / 10 = −0,4, horní hrana ≈ 2,5 / 9,5.
    expect(spread.minX).toBeLessThan(-0.4);
    expect(spread.maxY).toBeCloseTo(2.5 / 9.5, 6);
    expect(spread.maxX).toBeGreaterThan(1);
  });

  it('has no spread without a body in front of the camera', () => {
    const { scene, camera } = stage();
    const behind = cube(0, 0, 12);
    scene.add(behind);
    scene.updateMatrixWorld();
    expect(spreadOf([behind], camera, 400, 400)).toBeNull();
    expect(spreadOf([], camera, 400, 400)).toBeNull();
  });

  it('prints the camera exactly and the print moves with any change of the view', () => {
    const { scene, camera } = stage();
    scene.updateMatrixWorld();
    const print = cameraOf(camera);
    expect(print.position).toEqual([0, 0, 10]);
    expect(print.fov).toBe(90);
    expect(print.aspect).toBe(1);
    expect(print.projection).toEqual([...camera.projectionMatrix.elements]);
    // Posun záběru nemění polohu ani zorné pole, jen projekci – otisk ho musí vidět.
    camera.setViewOffset(400, 400, 0, 20, 400, 400);
    expect(cameraOf(camera).projection).not.toEqual(print.projection);
  });

  it('only reads: the camera and the bodies stay where they were', () => {
    const { scene, camera } = stage();
    const hero = cube(1, 2, 3);
    scene.add(hero);
    scene.updateMatrixWorld();
    const before = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, ...hero.matrixWorld.elements];
    spreadOf([hero], camera, 400, 400);
    cameraOf(camera);
    expect([...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, ...hero.matrixWorld.elements]).toEqual(before);
  });

  it('a run probed every sixth tick ends on the same state hash as an unprobed one', () => {
    const spec = readGameSpec(runnerFixture);
    if (!spec.ok) throw new Error(spec.issues.join('; '));
    const built = arcadeWorldOf(spec.value, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const play = (probe: boolean): string => {
      const session = createArcadeSession(built.world);
      session.startDemo();
      const { scene, camera } = stage();
      const hero = cube(0, 0, 0);
      scene.add(hero);
      for (let tick = 0; tick < 180 && session.snapshot().runState === 'running'; tick += 1) {
        session.advance(TICK_MS);
        if (probe && tick % 6 === 0) {
          scene.updateMatrixWorld();
          spreadOf([hero], camera, 412, 839);
          cameraOf(camera);
        }
      }
      return hashArcade(session.state());
    };
    expect(play(true)).toBe(play(false));
  });
});
