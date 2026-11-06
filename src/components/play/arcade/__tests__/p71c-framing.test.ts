/**
 * Rámování žánrů z QA (P71C T4): žába rytmu na telefonu celá v záběru – QA ji na 390 × 844 viděla uříznutou
 * u pravého okraje, protože lišta na výšku vyplní šířku a hrdina stál hned vedle ní.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { BOARD_TOP } from '@/play/arcade/pieces/drawsave-world';
import { RHYTHM } from '@/play/arcade/pieces/rhythm';

import { placeCamera } from '../genres/drawsave/drawsave-camera';
import { playRect } from '../portrait-frame';
import { rhythmHeroBox, rhythmTallCamera } from '../rhythm/RhythmScene';

/** Telefon z QA a pásy HUD (cíl nahoře, přepínač verzí a tlačítka dole) změřené na `g-rhythm-phone-start.png`. */
const PHONE = { width: 390, height: 844 } as const;
const HUD_BOTTOM = 140;
const CONTROLS_TOP = 700;
const MARGIN = 8;
const BAR = { w: (RHYTHM.lanes * RHYTHM.laneW) / UNIT, h: 0.2, d: 0.6 } as const;

describe('drawsave grid on a desktop (P71C T4)', () => {
  it('takes at least 60 % of the play height', () => {
    const desk = { width: 1280, height: 800 } as const;
    const camera = new PerspectiveCamera(60, desk.width / desk.height, 0.1, 1000);
    placeCamera(camera, desk, playRect(desk, 0, 700));
    camera.updateMatrixWorld();
    const yOf = (y: number) => ((1 - new Vector3(0, y, 0).project(camera).y) / 2) * desk.height;
    expect((yOf(0) - yOf(BOARD_TOP / UNIT)) / desk.height).toBeGreaterThanOrEqual(0.6);
  });
});

describe('start and end cards (P71C T4)', () => {
  // Tažení po kartě (QA: střelnice) označovalo text místo hry.
  it.each(['.play-first-prompt', '.play-result'])('%s is not selectable', (selector) => {
    const css = readFileSync(join(process.cwd(), 'src/app/play/play.css'), 'utf8');
    const rule = new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(rule).toMatch(/user-select: none;/);
  });
});

describe('rhythm hero on a phone (P71C T4)', () => {
  it('stays whole inside the viewport with an 8 px margin', () => {
    const camera = new PerspectiveCamera(60, PHONE.width / PHONE.height, 0.1, 1000);
    rhythmTallCamera(camera, playRect(PHONE, HUD_BOTTOM, CONTROLS_TOP), BAR);
    camera.updateMatrixWorld();
    const box = rhythmHeroBox(camera.aspect, BAR.w);
    const corner = new Vector3();
    for (let i = 0; i < 8; i += 1) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
      const px = ((corner.x + 1) / 2) * PHONE.width;
      const py = ((1 - corner.y) / 2) * PHONE.height;
      expect(px).toBeGreaterThanOrEqual(MARGIN);
      expect(px).toBeLessThanOrEqual(PHONE.width - MARGIN);
      expect(py).toBeGreaterThanOrEqual(MARGIN);
      expect(py).toBeLessThanOrEqual(PHONE.height - MARGIN);
    }
  });
});
