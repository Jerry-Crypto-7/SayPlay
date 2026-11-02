/**
 * Kamera minigolfu (P68 T8): přes rameno nízko za míčkem ve směru míření ze stavu; na telefonu na výšku leží míček
 * i cíl (jamka, nebo další bod trasy za rohem) v hracím obdélníku mezi HUD a ovládáním, na šířku vlastní póza.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { type ArcadeState, BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { minigolfParts } from '@/play/arcade/pieces/minigolf';
import { type MinigolfShape, minigolfLayout } from '@/play/arcade/pieces/minigolf-hole';
import { minigolfAim, minigolfAxisToward } from '@/play/arcade/pieces/minigolf-roll';

import { type PlayRect, playRect } from '../../../portrait-frame';
import { MINIGOLF_CAMERA, type MinigolfCameraPose, type MinigolfCourseView, minigolfCameraPose, minigolfCourseView, minigolfFocus, minigolfFollow } from '../minigolf-camera';

/** Pixel 7 na výšku v CSS px: horní pás HUD (pilulky a řádek cíle) a dolní řada tlačítek. */
const PHONE = { width: 412, height: 839 } as const;
const RECT: PlayRect = playRect(PHONE, 132, 743);
const TALL = PHONE.width / PHONE.height;
const WIDE = 16 / 9;

interface Hole {
  readonly state: ArcadeState;
  readonly course: MinigolfCourseView;
}

function holeOf(seed: number, shape: MinigolfShape): Hole {
  const parts = minigolfParts(seed, { shape });
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return { state: instantiate(built.world), course: minigolfCourseView(built.world.initial, minigolfLayout.parse(parts.control.params.layout)) };
}

/** Míček (hráč) na `x/z` s mířením `aim` a rychlostí `vx/vz`. */
function put(state: ArcadeState, x: number, z: number, aim: number, vx = 0, vz = 0): ArcadeState {
  const next = Int32Array.from(state);
  const p = bodyBase(next[HEADER.player] as number);
  next[p + BODY.x] = x;
  next[p + BODY.z] = z;
  next[p + BODY.vx] = vx;
  next[p + BODY.vz] = vz;
  next[p + BODY.aux0] = aim;
  return next;
}

const ballOf = (state: ArcadeState): readonly [number, number] => {
  const p = bodyBase(state[HEADER.player] as number);
  return [state[p + BODY.x] as number, state[p + BODY.z] as number];
};

/** Bod jádra (`x/z` v jednotkách, `y` v m) promítnutý kamerou pózy do NDC. Scéna zrcadlí x jádra. */
function seen(pose: MinigolfCameraPose, aspect: number, x: number, y: number, z: number): Vector3 {
  const camera = new PerspectiveCamera(MINIGOLF_CAMERA.fov, aspect, 0.1, 500);
  camera.position.copy(pose.position);
  camera.lookAt(pose.look);
  camera.updateMatrixWorld();
  return new Vector3(-x / UNIT, y, z / UNIT).project(camera);
}

const inside = (point: Vector3, rect: PlayRect): boolean => point.z < 1 && point.x >= -1 && point.x <= 1 && point.y <= rect.ndc.top && point.y >= rect.ndc.bottom;

/** Míček i cíl kamery leží na telefonu v hracím obdélníku. */
function expectFramed(state: ArcadeState, course: MinigolfCourseView): void {
  const pose = minigolfCameraPose(state, TALL, RECT, course);
  const [bx, bz] = ballOf(state);
  const [fx, fz] = pose.focus;
  expect(inside(seen(pose, TALL, bx, 0.2, bz), RECT), `ball ${String(bx)},${String(bz)}`).toBe(true);
  expect(inside(seen(pose, TALL, fx, 0, fz), RECT), `focus ${String(fx)},${String(fz)}`).toBe(true);
}

/** Vodorovný směr pohledu kamery a směr míření osy `aim` ve scéně (x zrcadlené), oba jednotkové. */
function headings(pose: MinigolfCameraPose, aim: number): { readonly view: Vector3; readonly aim: Vector3 } {
  const view = pose.look.clone().sub(pose.position).setY(0).normalize();
  const [ax, az] = minigolfAim(aim);
  return { view, aim: new Vector3(-ax, 0, az).normalize() };
}

describe('minigolf camera (P68 T8)', () => {
  it('keeps the ball and the hole inside the play rect on a 412 × 839 phone, from the tee and mid-course', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { state, course } = holeOf(seed, 'straight');
      const [tx, tz] = ballOf(state);
      const [hx, hz] = course.hole;
      expect(minigolfFocus(course, tx, tz)).toEqual(course.hole);
      expectFramed(put(state, tx, tz, minigolfAxisToward(hx - tx, hz - tz)), course);
      // Míček v půli cesty, zamířený stranou, a míček v pohybu.
      expectFramed(put(state, (tx + hx) >> 1, (tz + hz) >> 1, 300), course);
      expectFramed(put(state, tx, tz + 3000, 0, 0, 120), course);
    }
  });

  it('frames the next route point instead when the hole is round a corner', () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const shape of ['L', 'S'] as const) {
        const { state, course } = holeOf(seed, shape);
        const [tx, tz] = ballOf(state);
        const corner = course.route[0] as readonly [number, number];
        expect(course.route.length).toBeGreaterThan(1);
        expect(minigolfFocus(course, tx, tz)).toEqual(corner);
        expectFramed(put(state, tx, tz, 0), course);
        // Z rohu už je vidět dál po trase.
        expect(minigolfFocus(course, corner[0], corner[1])).toEqual(course.route[1]);
        expectFramed(put(state, corner[0], corner[1], minigolfAxisToward((course.route[1] as readonly [number, number])[0] - corner[0], (course.route[1] as readonly [number, number])[1] - corner[1])), course);
      }
    }
  });

  it('sits low behind the ball and looks the way the axis aims, on a phone and on a wide screen', () => {
    const { state, course } = holeOf(2, 'straight');
    const [tx, tz] = ballOf(state);
    for (const aim of [0, 180, 500, -650, 1000, -333]) {
      for (const [aspect, rect] of [[WIDE, null], [TALL, RECT]] as const) {
        const pose = minigolfCameraPose(put(state, tx, tz, aim), aspect, rect, course);
        const { view, aim: dir } = headings(pose, aim);
        expect(view.dot(dir), `aim ${String(aim)} aspect ${aspect.toFixed(2)}`).toBeGreaterThan(0.999);
        const back = pose.position.clone().sub(new Vector3(-tx / UNIT, 0, tz / UNIT)).setY(0);
        expect(back.dot(dir)).toBeLessThan(0);
        // Bokem nevybočí: kamera stojí na ose míření.
        expect(back.clone().sub(dir.clone().multiplyScalar(back.dot(dir))).length()).toBeLessThan(1e-6);
      }
      const wide = minigolfCameraPose(put(state, tx, tz, aim), WIDE, null, course);
      expect(wide.position.y).toBeLessThan(MINIGOLF_CAMERA.rest.up + 0.01);
    }
  });

  it('keeps the wide pose its own: the play rect never moves it', () => {
    const { state, course } = holeOf(3, 'L');
    const [tx, tz] = ballOf(state);
    const ball = put(state, tx, tz, 120);
    const free = minigolfCameraPose(ball, WIDE, null, course);
    const boxed = minigolfCameraPose(ball, WIDE, RECT, course);
    expect(boxed.position.toArray()).toEqual(free.position.toArray());
    expect(boxed.look.toArray()).toEqual(free.look.toArray());
  });

  it('follows a rolling ball from higher up and settles low behind it at rest, aim read from the state', () => {
    const { state, course } = holeOf(4, 'straight');
    const [tx, tz] = ballOf(state);
    const rest = minigolfCameraPose(put(state, tx, tz + 2000, 0), WIDE, null, course);
    const rolling = minigolfCameraPose(put(state, tx, tz + 2000, 0, 0, 90), WIDE, null, course);
    expect(rolling.position.y).toBeGreaterThan(rest.position.y);
    expect(rolling.position.z).toBeLessThan(tz / UNIT + 2);
    // Kamera jede s míčkem: o 3 m dál po dráze je o 3 m dál i ona.
    const further = minigolfCameraPose(put(state, tx, tz + 5000, 0, 0, 90), WIDE, null, course);
    expect(further.position.z - rolling.position.z).toBeCloseTo(3, 6);
    // Míření ze stavu, ne z rychlosti: míček jede bokem, kamera dál kouká po ose.
    const sideways = minigolfCameraPose(put(state, tx, tz + 2000, 0, 80, 0), WIDE, null, course);
    expect(headings(sideways, 0).view.z).toBeCloseTo(1, 6);
  });

  it('stands still before the first input: at tick 0 a re-measured play rect moves the camera in one frame, after the start it eases (P68-L T3)', () => {
    const { state, course } = holeOf(4, 'straight');
    // Na tiku 0 se HUD během načítání přeskládá: hrací obdélník je jiný, póza na výšku taky.
    const first = minigolfCameraPose(state, TALL, RECT, course);
    const remeasured = minigolfCameraPose(state, TALL, playRect(PHONE, 300, 600), course);
    expect(remeasured.position.distanceTo(first.position)).toBeGreaterThan(0.1);
    // Smyčka scény (`MinigolfScene`): oko jede k póze o `minigolfFollow` cesty za snímek.
    const run = (tick: number): number[] => {
      const eye = first.position.clone();
      return Array.from({ length: 30 }, () => {
        const before = eye.clone();
        eye.lerp(remeasured.position, minigolfFollow(1 / 60, tick, true));
        return eye.distanceTo(before);
      });
    };
    const idle = run(0);
    expect(idle[0]).toBeGreaterThan(0.1);
    expect(Math.max(...idle.slice(1)), 'no frame after the jump moves the camera').toBeLessThan(1e-9);
    // Po prvním vstupu tlumeně: za snímek jen kus cesty a pohyb trvá přes víc snímků.
    const playing = run(1);
    expect(playing[0]).toBeLessThan(0.2 * idle[0]!);
    expect(playing.filter((moved) => moved > 1e-3).length).toBeGreaterThan(10);
    // První snímek scény i po startu bez tlumení.
    expect(minigolfFollow(1 / 60, 5, false)).toBe(1);
  });
});
