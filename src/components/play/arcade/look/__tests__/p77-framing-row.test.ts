/**
 * P77 T4: rámující kusy u kamery po trati (běžec, závod) jedou jako řada kopií po trati (`framingRow`).
 * Pin: žádná kopie nestojí na hrací ploše v žádném místě trati, kopie stojí na zemi (při posunu řady
 * neklouže) a telefon dostane méně kopií. Bez rámujícího kusu by běžec zůstal s prázdným popředím –
 * hlídá to poslední test.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { isSceneryModel, LOOK_IDS, LOOKS, modelHeight } from '@/play/arcade/look';
import { PLATFORM } from '@/play/arcade/pieces/platform';

import { placeChase } from '../../steer/SteerScene';
import { placePlatform, placeRunner } from '../../track-camera';
import type { Box } from '../ground';
import { FRAMING_COPIES, FRAMING_PERIOD_M, footOf, framingRow, placeTrackFraming } from '../landmark-places';
import { PLAYABLE_HALF } from '../rig/terrain/valley';

const ALL_Z = { z0: -Infinity, z1: Infinity } as const;
const TRACKS = [
  { id: 'runner', place: (camera: PerspectiveCamera) => placeRunner(camera, new Vector3(), 0, 0), area: [{ x0: -PLAYABLE_HALF, x1: PLAYABLE_HALF, ...ALL_Z }], hero: { x: 0, y: 0, z: 0, r: 0.6, h: 1.4 } },
  { id: 'steer', place: (camera: PerspectiveCamera) => placeChase(camera, new Vector3(), 0, 0, 0), area: [{ x0: -5, x1: 5, ...ALL_Z }], hero: { x: 0, y: 0, z: 0, r: 1, h: 1.5 } },
] as const;
const ASPECTS = { desktop: 1280 / 800, phone: 412 / 915 } as const;

const onArea = (area: readonly Box[], x: number, z: number, r: number): boolean => area.some((box) => x + r > box.x0 && x - r < box.x1 && z + r > box.z0 && z - r < box.z1);

function framingOf(track: (typeof TRACKS)[number], lookId: (typeof LOOK_IDS)[number], aspect: number) {
  const look = LOOKS[lookId];
  const camera = new PerspectiveCamera(60, aspect, 0.1, look.fog[1]);
  track.place(camera);
  camera.updateMatrixWorld();
  const dir: 1 | -1 = camera.getWorldDirection(new Vector3()).z < 0 ? -1 : 1;
  return { pieces: placeTrackFraming({ camera, look, seed: 11, area: track.area, hero: track.hero }), dir, picks: look.props.some(isSceneryModel) ? 2 : 0 };
}

describe('P77 T4: rámující řada po trati', () => {
  for (const track of TRACKS) {
    it(`${track.id}: žádná kopie na hrací ploše, kopie stojí na zemi, telefon méně kopií`, () => {
      for (const lookId of LOOK_IDS) {
        for (const [tier, aspect] of Object.entries(ASPECTS) as [keyof typeof ASPECTS, number][]) {
          const { pieces, dir } = framingOf(track, lookId, aspect);
          for (const piece of pieces) {
            const seen = new Map<number, { x: number; z: number }>();
            for (let advance = 0; advance <= 600; advance += 5) {
              const row = framingRow(piece, advance, dir, FRAMING_COPIES[tier]);
              expect(row).toHaveLength(FRAMING_COPIES[tier]);
              for (const copy of row) {
                expect(onArea(track.area, copy.x, copy.z, footOf(copy))).toBe(false);
                // Kopie m stojí pořád na stejném místě, jen přibývá vpředu a mizí za kamerou.
                const m = Math.round((copy.z - piece.z) / (dir * FRAMING_PERIOD_M));
                const before = seen.get(m);
                if (before !== undefined) expect(copy).toMatchObject(before);
                seen.set(m, { x: copy.x, z: copy.z });
              }
              // Nejbližší kopie: nejvýš jednu rozteč za nalezeným místem posunutým o ujetou dráhu.
              expect(dir * (row[0]!.z - piece.z) - advance).toBeGreaterThan(-FRAMING_PERIOD_M);
            }
          }
        }
      }
      expect(FRAMING_COPIES.phone).toBeLessThan(FRAMING_COPIES.desktop);
    });
  }

  it('běžec dostane oba rámující kusy v každém místě, které je má (dřív 5 z 18)', () => {
    for (const lookId of LOOK_IDS) {
      const { pieces, picks } = framingOf(TRACKS[0], lookId, ASPECTS.desktop);
      expect(pieces).toHaveLength(picks);
    }
    expect(LOOK_IDS.filter((lookId) => framingOf(TRACKS[0], lookId, ASPECTS.desktop).picks > 0).length).toBeGreaterThan(LOOK_IDS.length / 2);
  });

  it('kus je vysoký jako rám (≥ 2,5 m, nejvyšší kulisa místa), ne lavička u kraje', () => {
    for (const lookId of LOOK_IDS) {
      const tallest = Math.max(0, ...LOOKS[lookId].props.filter(isSceneryModel).map((id) => modelHeight(id)));
      for (const piece of framingOf(TRACKS[0], lookId, ASPECTS.desktop).pieces) {
        const h = modelHeight(piece.id) * piece.scale;
        expect(h).toBeGreaterThanOrEqual(Math.min(2.5, tallest));
        expect(h).toBeLessThanOrEqual(Math.max(4, tallest) + 0.01);
      }
    }
  });

  it('závod zezadu kusy dostane (práh směru kamery nevypne kameru podél trati)', () => {
    for (const aspect of Object.values(ASPECTS)) {
      expect(LOOK_IDS.some((lookId) => framingOf(TRACKS[1], lookId, aspect).pieces.length > 0)).toBe(true);
    }
  });

  it('plošinovka z boku i ze tří čtvrtin nedostane žádný kus (T4 s5: maják přes rytíře / uprostřed záběru)', () => {
    const water = PLATFORM.fallBelowY / UNIT - 0.4;
    const slabHalf = PLATFORM.slabW / UNIT / 2;
    for (const lookId of LOOK_IDS) {
      for (const aspect of Object.values(ASPECTS)) {
        const look = LOOKS[lookId];
        const camera = new PerspectiveCamera(60, aspect, 0.1, look.fog[1]);
        placePlatform(camera, new Vector3(), 0, water + 1);
        camera.updateMatrixWorld();
        const area = [{ x0: -slabHalf, x1: slabHalf, ...ALL_Z }];
        expect(placeTrackFraming({ camera, look, seed: 11, area, hero: { x: 0, y: water + 1, z: 0, r: 0.6, h: 1.4 } })).toEqual([]);
      }
    }
  });

  it('kus stojí těsně vedle trati: přes kraj plochy ne, dál než 2 m od něj taky ne', () => {
    for (const lookId of LOOK_IDS) {
      for (const piece of framingOf(TRACKS[0], lookId, ASPECTS.desktop).pieces) {
        const gap = Math.abs(piece.x) - PLAYABLE_HALF - footOf(piece);
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThan(2);
      }
    }
  });
});
