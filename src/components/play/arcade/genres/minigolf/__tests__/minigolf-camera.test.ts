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

/** Celé plátno na šířku jako hrací obdélník (žádný HUD pás). */
const FULL_WIDE: PlayRect = playRect({ width: WIDE * 1000, height: 1000 }, 0, 1000);

/** Míček i cíl kamery leží v hracím obdélníku; v klidu i jamka s vlajkou (P70D T3), na telefonu i na šířku. */
function expectFramed(state: ArcadeState, course: MinigolfCourseView, aspect: number = TALL, rect: PlayRect = aspect < 1 ? RECT : FULL_WIDE): void {
  const pose = minigolfCameraPose(state, aspect, rect, course);
  const [bx, bz] = ballOf(state);
  const [fx, fz] = pose.focus;
  const [hx, hz] = course.hole;
  expect(inside(seen(pose, aspect, bx, 0.2, bz), rect), `ball ${String(bx)},${String(bz)}`).toBe(true);
  expect(inside(seen(pose, aspect, fx, 0, fz), rect), `focus ${String(fx)},${String(fz)}`).toBe(true);
  if (pose.rolling) return;
  expect(inside(seen(pose, aspect, hx, 0, hz), rect), `hole ${String(hx)},${String(hz)} aspect ${aspect.toFixed(2)}`).toBe(true);
  expect(inside(seen(pose, aspect, hx, MINIGOLF_CAMERA.flag, hz), rect), `flag ${String(hx)},${String(hz)}`).toBe(true);
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
      // Na šířku v klidu taky celá dráha k jamce.
      expectFramed(put(state, tx, tz, minigolfAxisToward(hx - tx, hz - tz)), course, WIDE);
      expectFramed(put(state, (tx + hx) >> 1, (tz + hz) >> 1, 300), course, WIDE);
      // Výška podle vzdálenosti jamky: z odpaliště výš než z půli cesty.
      const tee = minigolfCameraPose(put(state, tx, tz, minigolfAxisToward(hx - tx, hz - tz)), TALL, RECT, course);
      const half = minigolfCameraPose(put(state, (tx + hx) >> 1, (tz + hz) >> 1, minigolfAxisToward(hx - tx, hz - tz)), TALL, RECT, course);
      expect(tee.position.y).toBeGreaterThan(half.position.y);
    }
  });

  it('shows the hole at rest even round a corner, and a rolling ball frames the next route point (P70D T3)', () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const shape of ['L', 'S'] as const) {
        const { state, course } = holeOf(seed, shape);
        const [tx, tz] = ballOf(state);
        const corner = course.route[0] as readonly [number, number];
        const next = course.route[1] as readonly [number, number];
        expect(course.route.length).toBeGreaterThan(1);
        expect(minigolfFocus(course, tx, tz)).toEqual(corner);
        for (const aspect of [TALL, WIDE]) {
          expectFramed(put(state, tx, tz, 0), course, aspect);
          expectFramed(put(state, tx, tz, minigolfAxisToward(corner[0] - tx, corner[1] - tz)), course, aspect);
          expectFramed(put(state, corner[0], corner[1], minigolfAxisToward(next[0] - corner[0], next[1] - corner[1])), course, aspect);
        }
        // Z rohu už je vidět dál po trase; míček v pohybu u rohu rámuje další bod.
        expect(minigolfFocus(course, corner[0], corner[1])).toEqual(next);
        expectFramed(put(state, corner[0], corner[1], 0, 60, 60), course);
      }
    }
  });

  it('looks the way the axis aims at rest and rolling, from above at rest, on a phone and on a wide screen', () => {
    const { state, course } = holeOf(2, 'straight');
    const [tx, tz] = ballOf(state);
    for (const aim of [0, 180, 500, -650, 1000, -333]) {
      for (const [aspect, rect] of [[WIDE, null], [TALL, RECT], [TALL, null]] as const) {
        for (const speed of [0, 90]) {
          const pose = minigolfCameraPose(put(state, tx, tz, aim, 0, speed), aspect, rect, course);
          const { view, aim: dir } = headings(pose, aim);
          expect(view.dot(dir), `aim ${String(aim)} aspect ${aspect.toFixed(2)} speed ${String(speed)}`).toBeGreaterThan(0.999);
        }
        // Klid: přehled shora šikmo, sklon `rest.pitch` pod vodorovnou.
        const rest = minigolfCameraPose(put(state, tx, tz, aim), aspect, rect, course);
        const down = rest.look.clone().sub(rest.position).normalize();
        expect(Math.asin(-down.y) * (180 / Math.PI)).toBeCloseTo(MINIGOLF_CAMERA.rest.pitch, 6);
      }
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

  it('follows a rolling ball from just behind it and rises to the overview at rest, aim read from the state', () => {
    const { state, course } = holeOf(4, 'straight');
    const [tx, tz] = ballOf(state);
    const rest = minigolfCameraPose(put(state, tx, tz + 2000, 0), WIDE, null, course);
    const rolling = minigolfCameraPose(put(state, tx, tz + 2000, 0, 0, 90), WIDE, null, course);
    expect(rest.position.y).toBeGreaterThan(rolling.position.y);
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
