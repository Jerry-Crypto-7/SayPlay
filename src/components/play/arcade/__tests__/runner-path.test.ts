/**
 * Zakřivená trať běžce ve scéně (P46D T3). Křivka je čistá funkce semínka a `z`,
 * spojitá, na startu rovná a na mostě a v tunelu po rovině. Kamera jde po ní – kamera,
 * která by křivku nesledovala, ukáže hrdinu mimo trať, a tenhle test to chytí.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BoxGeometry, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { type ArcadeLevel, type BodyInit, UNIT } from '@/play/arcade/contract';
import { buildWorld } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { RUNNER } from '@/play/arcade/pieces/runner';
import { STRUCTURES } from '@/play/arcade/pieces/runner-sections';

import { bendGeometry, levelSpansOf, pathAt, pathOf, runnerPathOf, slopeAt } from '../runner/path';
import { placeRunner } from '../track-camera';

const SEEDS = Array.from({ length: 200 }, (_, index) => index * 7919 + 13);

function runnerWorld(bodies: readonly BodyInit[], seed = 5) {
  const length = 200 * UNIT;
  const level: ArcadeLevel = {
    bodies: [{ role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: RUNNER.playerW, h: RUNNER.runH, d: RUNNER.playerD, solid: false }, ...bodies, { role: 'goal', kind: 'finish', x: 0, y: 0, z: length, w: 8000, h: 3000, d: 400, solid: false }],
    length,
  };
  const control = { id: 'runner', params: { speed: 'normal', feel: 2 } };
  const built = buildWorld({ seed, control, rules: [{ id: 'finish', params: {} }], bot: { id: 'runner_bot', params: {} }, level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const water = (lane: number, z: number): BodyInit => ({ role: 'obstacle', kind: 'water', x: lane * RUNNER.laneWidth, y: 0, z, w: STRUCTURES.water.w, h: STRUCTURES.water.h, d: 12 * UNIT, solid: false });
const ceiling = (z: number): BodyInit => ({ role: 'obstacle', kind: 'ceiling', x: 0, y: STRUCTURES.ceiling.y, z, w: STRUCTURES.ceiling.w, h: STRUCTURES.ceiling.h, d: 14 * UNIT, solid: false });

describe('křivka trati běžce', () => {
  it('stejné semínko a z dá stejný bod, jiné semínko jinou trať', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      for (const z of [-10, 0, 37.5, 120, 260.25]) expect(pathAt(seed, z)).toEqual(pathAt(seed, z));
    }
    const a = pathOf(SEEDS[0]!);
    const b = pathOf(SEEDS[1]!);
    const apart = Math.max(...Array.from({ length: 300 }, (_, z) => Math.abs(a(z).x - b(z).x)));
    expect(apart).toBeGreaterThan(1);
  });

  it('start je rovný, dál trať zatáčí i stoupá', () => {
    for (const seed of SEEDS) {
      const path = pathOf(seed);
      for (const z of [-40, -5, 0, 3, 6]) expect(Math.hypot(path(z).x, path(z).y)).toBe(0);
      const along = Array.from({ length: 300 }, (_, z) => path(z));
      expect(Math.max(...along.map((point) => Math.abs(point.x))), `zatáčka ${seed}`).toBeGreaterThan(1.5);
      expect(Math.max(...along.map((point) => Math.abs(point.y))), `kopec ${seed}`).toBeGreaterThan(0.3);
    }
  });

  it('je spojitá: mezi sousedními metry se bod nehne o víc než 0,5 m ani na mostě a v tunelu', () => {
    let worst = 0;
    for (const seed of SEEDS) {
      // Mosty a tunely hustě za sebou, ať se náběhy překrývají.
      const spans = [{ from: 60, to: 72 }, { from: 80, to: 96 }, { from: 101, to: 111 }, { from: 200, to: 214 }];
      for (const path of [pathOf(seed), pathOf(seed, spans)]) {
        let before = path(-40);
        for (let z = -39; z <= 400; z += 1) {
          const now = path(z);
          worst = Math.max(worst, Math.hypot(now.x - before.x, now.y - before.y));
          before = now;
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(0.5);
  });

  it('most a tunel vedou po rovině', () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const path = pathOf(seed, [{ from: 80, to: 94 }]);
      const level = path(80).y;
      for (let z = 80; z <= 94; z += 0.5) expect(path(z).y).toBeCloseTo(level, 9);
      // Mimo most kopec zůstává: rovina není všude.
      expect(Math.max(...Array.from({ length: 60 }, (_, k) => Math.abs(path(140 + k).y - level)))).toBeGreaterThan(0.05);
    }
  });

  it('mosty a tunely čte ze světa: dvě tělesa vody jsou jeden most', () => {
    const world = runnerWorld([water(-1, 80 * UNIT), water(1, 80 * UNIT), ceiling(140 * UNIT)]);
    expect(levelSpansOf(world).sort((a, b) => a.from - b.from)).toEqual([
      { from: 74, to: 86 },
      { from: 133, to: 147 },
    ]);
    const path = runnerPathOf(world)!;
    expect(path(74).y).toBeCloseTo(path(86).y, 9);
    expect(path(133).y).toBeCloseTo(path(147).y, 9);
    expect(runnerPathOf({ ...world, control: { id: 'platform', params: {} } })).toBeNull();
  });
});

describe('scéna po křivce', () => {
  /** Kde na obrazovce je hrdina v pruhu `lane` na trati `path` (nebo rovné). */
  function heroOnScreen(path: ReturnType<typeof pathOf> | undefined, lane: number, z: number): Vector3 {
    const camera = new PerspectiveCamera(60, 9 / 19.5, 0.1, 200);
    const look = new Vector3();
    placeRunner(camera, look, lane, z, path);
    camera.updateMatrixWorld();
    const at = path?.(z) ?? { x: 0, y: 0 };
    return new Vector3(lane + at.x, 0.8 + at.y, z).project(camera);
  }

  it('kamera jde po křivce: hrdina je v záběru tam, kde na rovné trati', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const path = pathOf(seed);
      // Nejostřejší místo trati: největší posun do strany.
      const z = Array.from({ length: 250 }, (_, k) => 30 + k).reduce((best, k) => (Math.abs(path(k).x) > Math.abs(path(best).x) ? k : best));
      expect(Math.abs(path(z).x)).toBeGreaterThan(1.5);
      for (const lane of [-2, 0, 2]) {
        const bent = heroOnScreen(path, lane, z);
        const straight = heroOnScreen(undefined, lane, z);
        expect(Math.abs(bent.x - straight.x), `x ${seed}/${lane}`).toBeLessThan(0.06);
        expect(Math.abs(bent.y - straight.y), `y ${seed}/${lane}`).toBeLessThan(0.06);
      }
    }
  });

  it('dlouhá stavba se ohne celá: každý vrchol sítě sedí na křivce', () => {
    const path = pathOf(SEEDS[3]!);
    const z0 = 120;
    const geometry = bendGeometry(new BoxGeometry(1.6, 1.5, 14, 1, 1, 14), path, z0);
    const position = geometry.getAttribute('position');
    for (let index = 0; index < position.count; index += 1) {
      const z = position.getZ(index);
      const lateral = position.getX(index) - (path(z0 + z).x - path(z0).x);
      expect(Math.abs(Math.abs(lateral) - 0.8)).toBeLessThan(1e-5);
    }
    expect(Math.abs(slopeAt(path, z0).x)).toBeLessThan(0.5);
  });

  it('jádro křivku nevidí a nová scéna nečte hodiny ani náhodu', () => {
    const core: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        // Testy jádro nejsou: test prostorového zvuku (P67 T8) staví trať scény, aby měl kde zvuk umístit.
        if (statSync(file).isDirectory()) {
          if (name !== '__tests__') walk(file);
        }
        else if (/\.ts$/.test(name) && /runner\/path/.test(readFileSync(file, 'utf8'))) core.push(file);
      }
    };
    walk(join(process.cwd(), 'src/play'));
    expect(core).toEqual([]);
    const scene = readFileSync(join(process.cwd(), 'src/components/play/arcade/runner/path.ts'), 'utf8');
    expect(scene).not.toMatch(/Math\.random|Date\.now|performance\.now/);
  });
});
