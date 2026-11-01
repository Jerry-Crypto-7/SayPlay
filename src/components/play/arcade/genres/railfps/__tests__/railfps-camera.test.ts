/**
 * Kamera střelnice z očí (P68-F T5): řádky výšky v pásu hry, čitelný nepřítel a ťuk, který míří tam, kam kamera
 * kreslí. Póza se staví na skutečnou kameru three.js (`applyPose`) a body se promítají jí – test tak drží i znaménko
 * posunu záběru a zrcadlení x scény, ne jen vlastní vzorce modulu.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { LEGIBLE_CAP, LEGIBLE_SHARE, foeScale } from '@/play/arcade/models';
import { HEIGHT_ROWS, RAILFPS, YAW, rayPoint, sectorToStep } from '@/play/arcade/pieces/railfps-world';

import { HUD_BAND_PX, THUMB_ZONE_PX } from '../../portrait-first';
import { playRect } from '../../../portrait-frame';
import { type RailfpsPose, applyPose, cameraPose, heightShare, scenePoint, screenToSector, sectorOfYaw, sectorToScreen } from '../railfps-camera';

const SCREENS = [
  { name: 'portrait 412×839', width: 412, height: 839 },
  { name: 'landscape 1280×720', width: 1280, height: 720 },
] as const;

const SECTORS = Array.from({ length: YAW.sectors }, (_, index) => index - YAW.maxSector);
/** Kde věci vznikají a kam nepřítel dojde. */
const SPAWN = [RAILFPS.targetNear, RAILFPS.targetFar, RAILFPS.enemyNear, RAILFPS.enemyFar] as const;

type Screen = (typeof SCREENS)[number];

function setup(screen: Screen) {
  const aspect = screen.width / screen.height;
  // Pás hry jako na telefonu: horní pás HUD a zóna palce z tokenů kitu.
  const rect = playRect(screen, HUD_BAND_PX, screen.height - THUMB_ZONE_PX);
  const camera = new PerspectiveCamera(50, aspect, 0.1, 1000);
  const pose = (from: number, to = from, t = 0): RailfpsPose => {
    const next = cameraPose(from, to, t, aspect, rect);
    applyPose(camera, next, screen.width, screen.height);
    return next;
  };
  /** NDC bodu jádra (jednotky) skutečnou kamerou. */
  const project = (x: number, y: number, z: number): Vector3 => {
    const at = scenePoint(x, y, z);
    return new Vector3(at.x, at.y, at.z).project(camera);
  };
  return { aspect, rect, camera, pose, project };
}

describe.each(SCREENS)('railfps camera – $name', (screen) => {
  it('shows every height row inside playRect at spawn distance and at reach', () => {
    const { rect, pose, project } = setup(screen);
    for (const sector of SECTORS) {
      pose(sectorToStep(sector));
      for (const distance of [...SPAWN, RAILFPS.reach]) {
        const at = rayPoint(sector, distance);
        for (const row of HEIGHT_ROWS) {
          const ndc = project(at.x, row, at.z);
          expect(ndc.z).toBeLessThan(1);
          expect(Math.abs(ndc.x)).toBeLessThan(0.05);
          expect(ndc.y).toBeLessThanOrEqual(rect.ndc.top);
          expect(ndc.y).toBeGreaterThanOrEqual(rect.ndc.bottom);
        }
      }
      // Celý terč (± půl výšky) tam, kde terče stojí.
      for (const distance of [RAILFPS.targetNear, RAILFPS.targetFar]) {
        const at = rayPoint(sector, distance);
        const top = project(at.x, (HEIGHT_ROWS.at(-1) as number) + RAILFPS.target.h / 2, at.z);
        const bottom = project(at.x, (HEIGHT_ROWS[0] as number) - RAILFPS.target.h / 2, at.z);
        expect(top.y).toBeLessThanOrEqual(rect.ndc.top);
        expect(bottom.y).toBeGreaterThanOrEqual(rect.ndc.bottom);
      }
    }
  });

  it('puts eye level in the middle of the play band', () => {
    const { rect, pose, project } = setup(screen);
    pose(0);
    const far = rayPoint(0, RAILFPS.range);
    // Oko je ve výšce prostředního řádku: bod v té výšce leží na horizontu v každé vzdálenosti.
    const horizon = project(far.x, HEIGHT_ROWS[1], far.z);
    expect(horizon.y).toBeCloseTo((rect.ndc.top + rect.ndc.bottom) / 2, 3);
  });

  it('draws an enemy at spawn distance at least LEGIBLE_SHARE.target tall within LEGIBLE_CAP', () => {
    const { pose, project } = setup(screen);
    for (const sector of [0, 2, -4]) {
      const drawn = pose(sectorToStep(sector));
      for (const distance of [RAILFPS.enemyNear, RAILFPS.enemyFar]) {
        const at = rayPoint(sector, distance);
        const share = (project(at.x, RAILFPS.enemy.h, at.z).y - project(at.x, 0, at.z).y) / 2;
        // Scéna počítá podíl vzorcem; musí sedět na skutečnou projekci.
        expect(heightShare(RAILFPS.enemy.h / 1000, distance / 1000, drawn.fovDeg)).toBeCloseTo(share, 3);
        const scale = foeScale(share);
        expect(scale).toBeLessThanOrEqual(LEGIBLE_CAP);
        expect(share * scale).toBeGreaterThanOrEqual(LEGIBLE_SHARE.target);
      }
    }
  });

  it('maps the screen centre to the current sector', () => {
    const { aspect, pose } = setup(screen);
    for (const sector of SECTORS) {
      const drawn = pose(sectorToStep(sector));
      expect(screenToSector(0, drawn.yawDeg, aspect, drawn.fovDeg)).toBe(sector);
    }
    // Uprostřed otočky: střed obrazovky je sektor, kam kamera právě kouká.
    for (let step = -16; step < 16; step += 1) {
      const drawn = pose(step, step + 1, 0.5);
      expect(screenToSector(0, drawn.yawDeg, aspect, drawn.fovDeg)).toBe(sectorOfYaw(drawn.yawDeg));
    }
  });

  it('maps a tap on a drawn sector back to that sector, also mid-turn', () => {
    const { aspect, pose, project } = setup(screen);
    let checked = 0;
    for (let step = -16; step <= 16; step += 1) {
      for (const t of step < 16 ? [0, 0.25, 0.5, 0.75] : [0]) {
        const drawn = pose(step, Math.min(16, step + 1), t);
        for (const sector of SECTORS) {
          for (const distance of [RAILFPS.targetNear, RAILFPS.enemyFar]) {
            const at = rayPoint(sector, distance);
            const ndc = project(at.x, HEIGHT_ROWS[1], at.z);
            if (ndc.z >= 1 || Math.abs(ndc.x) > 1) continue;
            expect(screenToSector(ndc.x, drawn.yawDeg, aspect, drawn.fovDeg)).toBe(sector);
            const column = sectorToScreen(sector, drawn.yawDeg, aspect, drawn.fovDeg);
            expect(column).not.toBeNull();
            expect(column as number).toBeCloseTo(ndc.x, 2);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('keeps the current sector and both neighbour centres on screen', () => {
    const { aspect, pose } = setup(screen);
    const drawn = pose(0);
    const visible = SECTORS.filter((sector) => sectorToScreen(sector, drawn.yawDeg, aspect, drawn.fovDeg) !== null);
    expect(visible).toEqual(expect.arrayContaining([-1, 0, 1]));
    // Okraj obrazovky leží ve viditelném sektoru, nebo v sektoru hned za ním (jeho kus bez středu) – ne o dva dál.
    for (const edge of [-0.98, 0.98]) {
      const sector = screenToSector(edge, drawn.yawDeg, aspect, drawn.fovDeg);
      expect(Math.sign(sector)).toBe(Math.sign(edge));
      expect(visible.includes(sector) || visible.includes(sector - Math.sign(edge))).toBe(true);
    }
  });
});

describe('railfps camera – pose', () => {
  const rect = playRect({ width: 412, height: 839 }, HUD_BAND_PX, 839 - THUMB_ZONE_PX);

  it('is a pure function of its input', () => {
    const a = cameraPose(-3, -2, 0.4, 412 / 839, rect);
    const b = cameraPose(-3, -2, 0.4, 412 / 839, rect);
    expect(b).toEqual(a);
    expect(cameraPose(-3, -2, 0.6, 412 / 839, rect)).not.toEqual(a);
  });

  it('interpolates yaw between steps and points right for positive sectors', () => {
    expect(cameraPose(0, 1, 0.5, 1.5, rect).yawDeg).toBeCloseTo(YAW.stepDeg / YAW.stepsPerSector / 2, 6);
    expect(cameraPose(16, 16, 0, 1.5, rect).yawDeg).toBe(60);
    expect(cameraPose(-16, -16, 0, 1.5, rect).yawDeg).toBe(-60);
  });

  it('widens the field when the play band is short instead of cutting rows', () => {
    const roomy = cameraPose(0, 0, 0, 1.6, playRect({ width: 1280, height: 800 }, 0, 800));
    const cramped = cameraPose(0, 0, 0, 2.16, playRect({ width: 844, height: 390 }, HUD_BAND_PX, 390 - THUMB_ZONE_PX));
    expect(cramped.fovDeg).toBeGreaterThan(roomy.fovDeg);
  });

  it('snaps yaw to sectors like the kernel (edge belongs to the inner sector)', () => {
    expect(sectorOfYaw(0)).toBe(0);
    expect(sectorOfYaw(7.5)).toBe(0);
    expect(sectorOfYaw(-7.5)).toBe(0);
    expect(sectorOfYaw(7.6)).toBe(1);
    expect(sectorOfYaw(-22.6)).toBe(-2);
    expect(sectorOfYaw(200)).toBe(YAW.maxSector);
  });
});
