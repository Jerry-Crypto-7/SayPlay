/**
 * Čitelnost střelnice z očí na telefonu (P68-F T9). Co by vypadalo dobře a bylo špatně: nepřítel v dálce jako tečka,
 * zaměřovač nebo značka sektoru pod pilulkami HUD či pod palcem, terč horního řádku schovaný za časovačem – a šipka
 * hrozby na opačné straně, která vypadá jako funkční HUD a pošle hráče špatným směrem.
 *
 * Proto: na 412 × 839 (Pixel 7 na výšku) s pásem hry z konstant kitu (`HUD_BAND_PX`, `THUMB_ZONE_PX`) přepočet
 * `cameraPose` → řádek plátna (`screenRowOf`) pro nepřítele, terče, zaměřovač a značku sektoru; šipky z ručního stavu
 * s nepřáteli v daných sektorech při daném natočení.
 */

import { describe, expect, it } from 'vitest';

import { type ArcadeState, type ArcadeWorld, BODY, BODY_STRIDE, FLAG, HEADER, START_LIVES, UNIT, bodyBase } from '@/play/arcade/contract';
import { completeHooks } from '@/play/arcade/hooks';
import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { LEGIBLE_SHARE, foeScale } from '@/play/arcade/models';
import { EYE_HEIGHT, HEIGHT_ROWS, RAILFPS, RAILFPS_BODIES, type RailfpsRoundParams, YAW, railfpsRail, rayPoint, rushesAhead, targetY } from '@/play/arcade/pieces/railfps';

import { playRect } from '../../../portrait-frame';
import { HUD_BAND_PX, THUMB_ZONE_PX } from '../../portrait-first';
import { RAILFPS_LAYOUT, STEP_DEG, cameraPose, heightShare, screenRowOf, sectorToScreen } from '../railfps-camera';
import { offscreenThreats } from '../ThreatArrows';

const PHONE = { width: 412, height: 839 } as const;
const RECT = playRect(PHONE, HUD_BAND_PX, PHONE.height - THUMB_ZONE_PX);
const ASPECT = PHONE.width / PHONE.height;
const m = (units: number): number => units / UNIT;
/** Póza při natočení na sektor `sector` (stání, ne otočka). */
const poseAt = (sector: number) => cameraPose(sector * YAW.stepsPerSector, sector * YAW.stepsPerSector, 1, ASPECT, RECT);
const row = (heightM: number, distanceM: number, sector = 0): number => screenRowOf(heightM, distanceM, poseAt(sector), PHONE.height);

/** Řádek leží v pásu hry: pod horním pásem HUD a nad zónou palce. */
function expectInBand(y: number, what: string): void {
  expect(y, `${what}: under the top HUD band`).toBeGreaterThanOrEqual(RECT.px.top);
  expect(y, `${what}: above the thumb zone`).toBeLessThanOrEqual(RECT.px.bottom);
}

describe('railfps phone readability at 412 × 839 (P68-F T9)', () => {
  it('the band constants leave a real play band, the horizon sits in its middle', () => {
    expect(RECT.px.top).toBe(HUD_BAND_PX);
    expect(RECT.px.bottom).toBe(PHONE.height - THUMB_ZONE_PX);
    // Bod ve výšce oka je na horizontu, ať je daleko nebo blízko.
    expect(row(m(EYE_HEIGHT), 5)).toBeCloseTo((RECT.px.top + RECT.px.bottom) / 2, 6);
    expect(row(m(EYE_HEIGHT), 30)).toBeCloseTo((RECT.px.top + RECT.px.bottom) / 2, 6);
  });

  it('an enemy and the boss at their spawn distance are at least LEGIBLE_SHARE.target of the image height after foeScale', () => {
    const fov = poseAt(0).fovDeg;
    for (const [what, heightM] of [
      ['enemy', m(RAILFPS.enemy.h)],
      ['boss', m(RAILFPS.boss.h)],
    ] as const) {
      for (const distance of [RAILFPS.enemyNear, RAILFPS.enemyFar]) {
        const share = heightShare(heightM, m(distance), fov);
        expect(share * foeScale(share), `${what} at ${String(m(distance))} m`).toBeGreaterThanOrEqual(LEGIBLE_SHARE.target);
        // Na plátně: hlava zvětšené postavy a pata nad zónou palce i pod HUD.
        expectInBand(row(heightM * foeScale(share), m(distance)), `${what} head at ${String(m(distance))} m`);
        expectInBand(row(0, m(distance)), `${what} feet at ${String(m(distance))} m`);
      }
    }
    // Nepřítel na dosahu (tam bere život) má paty pořád nad palcem.
    expectInBand(row(0, m(RAILFPS.reach)), 'enemy feet at reach');
  });

  it('the crosshair ring and the sector marker sit inside the play band, clear of the HUD band and the thumb zone', () => {
    const horizon = row(m(EYE_HEIGHT), 10);
    expectInBand(horizon - RAILFPS_LAYOUT.crosshairPx, 'crosshair top');
    expectInBand(horizon + RAILFPS_LAYOUT.crosshairPx, 'crosshair bottom');
    // Značka sektoru je krátký klín na podlaze od `markNear` po `markFar`: celý mezi horizontem a zónou palce.
    expectInBand(row(0, RAILFPS_LAYOUT.markNear), 'sector marker near edge');
    expectInBand(row(0, RAILFPS_LAYOUT.markFar), 'sector marker far edge');
    expect(row(0, RAILFPS_LAYOUT.markNear)).toBeGreaterThan(horizon + RAILFPS_LAYOUT.crosshairPx);
    // T10: značka je nižší než polovina podlahy pod horizontem – čte se jako plocha u nohou, ne jako pruh k obzoru.
    expect(row(0, RAILFPS_LAYOUT.markNear) - row(0, RAILFPS_LAYOUT.markFar)).toBeLessThan((row(0, RAILFPS_LAYOUT.markNear) - horizon) / 2);
  });

  it('no target of any height row is covered by the HUD band or the thumb zone, from the nearest to the farthest spawn', () => {
    for (const [index] of HEIGHT_ROWS.entries()) {
      const bottom = m(targetY(index));
      const top = bottom + m(RAILFPS.target.h);
      for (const distance of [RAILFPS.targetNear, RAILFPS.targetFar]) {
        expectInBand(row(top, m(distance)), `target row ${String(index)} top at ${String(m(distance))} m`);
        expectInBand(row(bottom, m(distance)), `target row ${String(index)} bottom at ${String(m(distance))} m`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Šipky hrozeb z ručního stavu

function worldOf(seed: number): ArcadeWorld {
  const parts = railfpsRail.parts(seed, railfpsRail.params.parse({}), undefined);
  if ((parts.issues ?? []).length > 0) throw new Error((parts.issues ?? []).join('; '));
  const built = buildWorld({ seed, control: parts.control, rules: completeHooks(parts.rules), bot: parts.bot, level: parts.level, health: parts.health ?? START_LIVES }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const WORLD = worldOf(1);
const { target, enemy, boss } = RAILFPS_BODIES;

/** Stav světa s živými cíli `[předloha, sektor, vzdálenost]` ve slotech za úrovní; vrací stav a jejich indexy. */
function stage(foes: readonly (readonly [number, number, number])[]): { readonly state: ArcadeState; readonly bodies: readonly number[] } {
  const state = instantiate(WORLD);
  const bodies = foes.map(([template, sector, distance]) => {
    const body = state[HEADER.bodyCount] as number;
    state[HEADER.bodyCount] = body + 1;
    const to = bodyBase(body);
    state.copyWithin(to, bodyBase(template), bodyBase(template) + BODY_STRIDE);
    const at = rayPoint(sector, distance);
    state[to + BODY.x] = at.x;
    state[to + BODY.z] = at.z;
    state[to + BODY.y] = template === target ? targetY(1) : 0;
    state[to + BODY.flags] = (state[to + BODY.flags] as number) | FLAG.alive;
    return body;
  });
  return { state, bodies };
}

/** Šipky jako `strana:sektor` od nejbližší hrozby při natočení na sektor `view`. */
const arrowsAt = (state: ArcadeState, view: number): string[] => {
  const pose = poseAt(view);
  return offscreenThreats(state, pose.yawDeg, ASPECT, pose.fovDeg).map((threat) => `${threat.side}:${String(threat.sector)}`);
};

describe('railfps threat arrows from a hand-made state (P68-F T9)', () => {
  it('the phone view at sector 0 shows sectors -1..1 and nothing beyond, so an enemy in sector ±2 is off view', () => {
    const pose = poseAt(0);
    for (const sector of [-1, 0, 1]) expect(sectorToScreen(sector, pose.yawDeg, ASPECT, pose.fovDeg), `sector ${String(sector)}`).not.toBeNull();
    for (const sector of [-2, 2]) expect(sectorToScreen(sector, pose.yawDeg, ASPECT, pose.fovDeg), `sector ${String(sector)}`).toBeNull();
  });

  it('looking ahead: the nearest off-view enemy on each side gets an arrow on its side; visible enemies and targets get none', () => {
    const { state } = stage([
      [enemy, -3, 15_000],
      [enemy, 2, 12_000],
      [enemy, 4, 8_000],
      [enemy, 1, 5_000],
      [target, -4, 9_000],
    ]);
    expect(arrowsAt(state, 0)).toEqual(['right:4', 'left:-3']);
  });

  it('the side follows the view, not the sign of the sector: turned to sector 4, an enemy in sector 1 is to the left', () => {
    const { state } = stage([[enemy, 1, 14_000]]);
    expect(arrowsAt(state, 4)).toEqual(['left:1']);
    expect(arrowsAt(state, -4)).toEqual(['right:1']);
    // Natočený na něj ho vidí: žádná šipka.
    expect(arrowsAt(state, 1)).toEqual([]);
  });

  it('never more than two arrows, the boss counts as a threat, and the nearer of two on one side wins', () => {
    const { state } = stage([
      [enemy, -4, 20_000],
      [boss, -2, 11_000],
      [enemy, 3, 9_000],
      [enemy, 4, 6_000],
      [enemy, -3, 17_000],
    ]);
    expect(arrowsAt(state, 0)).toEqual(['right:4', 'left:-2']);
    // Mid-turn the pose is between steps: the arrows still read the drawn yaw.
    const turning = cameraPose(0, YAW.stepsPerSector, 0.5, ASPECT, RECT);
    expect(turning.yawDeg).toBeCloseTo(YAW.stepsPerSector * 0.5 * STEP_DEG, 6);
    expect(offscreenThreats(state, turning.yawDeg, ASPECT, turning.fovDeg)).toHaveLength(2);
  });

  it('with no enemy alive there is no arrow', () => {
    const { state } = stage([[target, 4, 9_000]]);
    expect(arrowsAt(state, 0)).toEqual([]);
  });

  it('a coming rush (P68-K T1) gets its arrow rushWarn ticks before it spawns, from the generated schedule, and none after', () => {
    const parts = railfpsRail.parts(1, railfpsRail.params.parse({}), undefined);
    const waves = (parts.rules.find((ref) => ref.id === 'railfps_round')!.params as RailfpsRoundParams).waves;
    const [at, , sector] = waves[1]![0]!;
    expect(Math.abs(sector)).toBe(YAW.maxSector);
    const { state } = stage([]);
    const pose = poseAt(0);
    const arrows = (clock: number): string[] => offscreenThreats(state, pose.yawDeg, ASPECT, pose.fovDeg, rushesAhead(waves[1], clock)).map((threat) => `${threat.side}:${String(threat.sector)}`);
    expect(arrows(at - RAILFPS.rushWarn - 1)).toEqual([]);
    expect(arrows(at - RAILFPS.rushWarn)).toEqual([`${sector < 0 ? 'left' : 'right'}:${String(sector)}`]);
    expect(arrows(at - 1)).toHaveLength(1);
    // Vznikl: od teď ho hlásí živé tělo, ne rozvrh.
    expect(arrows(at)).toEqual([]);
    // Běžný nepřítel z rozvrhu ohlášený není.
    const plain = waves[1]!.findIndex(([, template, , , distance]) => template === RAILFPS_BODIES.enemy && distance >= RAILFPS.enemyNear);
    expect(rushesAhead(waves[1], waves[1]![plain]![0] - 1)).toEqual([]);
  });
});
