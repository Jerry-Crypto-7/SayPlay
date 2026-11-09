/**
 * Kamera minigolfu (P68 T8): přes rameno nízko za míčkem ve směru míření ze stavu; na telefonu na výšku leží míček
 * i cíl (jamka, nebo další bod trasy za rohem) v hracím obdélníku mezi HUD a ovládáním, na šířku vlastní póza.
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { type ArcadeInput, type ArcadeState, type ArcadeWorld, BODY, HEADER, NO_INPUT, UNIT, bodyBase } from '@/play/arcade/contract';
import { buildWorld, instantiate, loadProgram, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { FLORA_SPECIES, floraIds, LOOKS, sceneLook } from '@/play/arcade/look';
import { minigolfParts } from '@/play/arcade/pieces/minigolf';
import { MINIGOLF_SHAPES, type MinigolfShape, minigolfLayout } from '@/play/arcade/pieces/minigolf-hole';
import { minigolfAim, minigolfAxisToward } from '@/play/arcade/pieces/minigolf-roll';

import { airOf } from '../../../look/rig/fog-light';
import { type Plant, placeAround } from '../../../look/vegetation-places';
import { type PlayRect, playRect } from '../../../portrait-frame';
import { MINIGOLF_CAMERA, type MinigolfCameraPose, type MinigolfCourseView, minigolfCameraAxis, minigolfCameraPose, minigolfCameraRig, minigolfCameraStep, minigolfCourseView, minigolfFocus } from '../minigolf-camera';
import { type Putt, pullBack, puttInput } from '../minigolf-touch';
import { minigolfDressing } from '../MinigolfScene';

/** Pixel 7 na výšku v CSS px: horní pás HUD (pilulky a řádek cíle) a dolní řada tlačítek. */
const PHONE = { width: 412, height: 839 } as const;
const RECT: PlayRect = playRect(PHONE, 132, 743);
const TALL = PHONE.width / PHONE.height;
const WIDE = 16 / 9;

interface Hole {
  readonly world: ArcadeWorld;
  readonly state: ArcadeState;
  readonly course: MinigolfCourseView;
}

function holeOf(seed: number, shape: MinigolfShape): Hole {
  const parts = minigolfParts(seed, { shape });
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return { world: built.world, state: instantiate(built.world), course: minigolfCourseView(built.world.initial, minigolfLayout.parse(parts.control.params.layout)) };
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
        // Z rohu už je vidět dál po trase. Míček v pohybu drží cíl vybraný při odpalu (P71C T2): z odpaliště roh,
        // i když se valí přes něj; rána z rohu rámuje další bod.
        expect(minigolfFocus(course, corner[0], corner[1])).toEqual(next);
        const fromTee = put(state, corner[0], corner[1], 0, 60, 60);
        expect(minigolfCameraPose(fromTee, TALL, RECT, course).focus).toEqual(corner);
        expectFramed(fromTee, course);
        const fromCorner = Int32Array.from(fromTee);
        fromCorner[HEADER.respawnX] = corner[0];
        fromCorner[HEADER.respawnZ] = corner[1];
        expect(minigolfCameraPose(fromCorner, TALL, RECT, course).focus).toEqual(next);
        expectFramed(fromCorner, course);
      }
    }
  });

  it('looks from the ball to the route target whatever the aim, at rest and rolling, from above at rest (P71C T1)', () => {
    for (const shape of ['straight', 'L'] as const) {
      const { state, course } = holeOf(2, shape);
      const [tx, tz] = ballOf(state);
      const [fx, fz] = minigolfFocus(course, tx, tz);
      const axis = minigolfAxisToward(fx - tx, fz - tz);
      expect(minigolfCameraAxis(put(state, tx, tz, 777), course)).toBe(axis);
      for (const [aspect, rect] of [[WIDE, null], [TALL, RECT], [TALL, null]] as const) {
        const still = minigolfCameraPose(put(state, tx, tz, 0), aspect, rect, course);
        for (const aim of [0, 180, 500, -650, 1000, -333]) {
          const label = `${shape} aim ${String(aim)} aspect ${aspect.toFixed(2)}`;
          // Klid: míření pózou nehne – poloha, pohled i zoom stejné jako s mířením 0, osa míček → cíl.
          const rest = minigolfCameraPose(put(state, tx, tz, aim), aspect, rect, course);
          expect(rest.position.toArray(), label).toEqual(still.position.toArray());
          expect(rest.look.toArray(), label).toEqual(still.look.toArray());
          const { view, aim: dir } = headings(rest, axis);
          expect(view.dot(dir), label).toBeGreaterThan(0.999);
          // Valení: osa z místa rány (odpaliště), ne z míření ani z rychlosti.
          const rolling = minigolfCameraPose(put(state, tx, tz + 1500, aim, 70, 90), aspect, rect, course);
          const rolled = headings(rolling, axis);
          expect(rolled.view.dot(rolled.aim), label).toBeGreaterThan(0.999);
        }
        // Klid: přehled shora šikmo, sklon `rest.pitch` pod vodorovnou.
        const down = still.look.clone().sub(still.position).normalize();
        expect(Math.asin(-down.y) * (180 / Math.PI)).toBeCloseTo(MINIGOLF_CAMERA.rest.pitch, 6);
      }
    }
  });

  it('aim drag does not move the camera: a finger sweeping the aim round leaves the pose still (P71C T1)', () => {
    for (const shape of ['straight', 'L', 'S'] as const) {
      const { world, state, course } = holeOf(3, shape);
      const program = loadProgram(world, ARCADE_LIBRARY);
      const base = minigolfCameraAxis(state, course);
      for (const [aspect, rect] of [[TALL, RECT], [WIDE, FULL_WIDE]] as const) {
        const live = Int32Array.from(state);
        const first = minigolfCameraPose(live, aspect, rect, course).position.clone();
        let last = first.clone();
        let most = 0;
        const aims = new Set<number>();
        // Prst táhne dozadu a krouží kolem startu (půl otáčky za 60 tiků), nabíjí, ale nepustí.
        for (let tick = 0; tick < 90; tick += 1) {
          const turn = (tick / 60) * Math.PI;
          const putt: Putt = { aim: pullBack(base, 120 * Math.sin(turn), 120 * Math.cos(turn)), released: false };
          step(live, puttInput(putt, Math.max(0, live[bodyBase(live[HEADER.player] as number) + BODY.aux1] as number)).input, program);
          aims.add(live[bodyBase(live[HEADER.player] as number) + BODY.aux0] as number);
          const now = minigolfCameraPose(live, aspect, rect, course).position;
          most = Math.max(most, now.distanceTo(last));
          last = now.clone();
          expect(now.distanceTo(first), `${shape} tick ${String(tick)} total`).toBeLessThanOrEqual(0.3);
        }
        expect(aims.size, 'the drag really turned the aim in the state').toBeGreaterThan(20);
        expect(most, `${shape} aspect ${aspect.toFixed(2)} per frame`).toBeLessThanOrEqual(0.05);
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
    // Osa z místa rány na cíl, ne z rychlosti: míček jede bokem, kamera dál kouká po ose.
    const aside = put(state, tx, tz + 2000, 0, 80, 0);
    const sideways = headings(minigolfCameraPose(aside, WIDE, null, course), minigolfCameraAxis(aside, course));
    expect(sideways.view.dot(sideways.aim)).toBeGreaterThan(0.999);
  });

  it('stands still before the first input: while it waits a re-measured play rect moves the camera in one frame, after the start it eases (P68-L T3)', () => {
    const { state, course } = holeOf(4, 'straight');
    // Na tiku 0 se HUD během načítání přeskládá: hrací obdélník je jiný, póza na výšku taky.
    const first = minigolfCameraPose(state, TALL, RECT, course);
    const remeasured = minigolfCameraPose(state, TALL, playRect(PHONE, 300, 600), course);
    expect(remeasured.position.distanceTo(first.position)).toBeGreaterThan(0.1);
    // Smyčka scény (`MinigolfScene`): první snímek na první póze, pak 30 snímků přeměřené.
    const run = (tick: number, hold: boolean): number[] => {
      const rig = minigolfCameraRig();
      minigolfCameraStep(rig, first, tick, 1 / 60, hold);
      expect(rig.eye.distanceTo(first.position), 'the first frame sits on the pose').toBeLessThan(1e-9);
      return Array.from({ length: 30 }, () => {
        const before = rig.eye.clone();
        minigolfCameraStep(rig, remeasured, tick, 1 / 60, hold);
        return rig.eye.distanceTo(before);
      });
    };
    const idle = run(0, true);
    expect(idle[0]).toBeGreaterThan(0.1);
    expect(Math.max(...idle.slice(1)), 'no frame after the jump moves the camera').toBeLessThan(1e-9);
    // Po prvním vstupu přechodem: první snímek stojí, pohyb trvá přes víc snímků.
    const playing = run(1, false);
    expect(playing[0]).toBeLessThan(1e-9);
    expect(playing.filter((moved) => moved > 1e-3).length).toBeGreaterThan(10);
  });

  it('frames the course below the start card: ball, route target and hole inside the free area (P71C T2)', () => {
    for (const shape of ['straight', 'L'] as const) {
      const { state, course } = holeOf(5, shape);
      for (const [aspect, rect] of [[TALL, RECT], [WIDE, playRect({ width: WIDE * 800, height: 800 }, 90, 760)]] as const) {
        // Karta přisazená nahoru zabere 250 px pod lištou HUD.
        const free = playRect(rect.canvas, rect.px.top + 16 + 250 + 16, rect.px.bottom);
        const pose = minigolfCameraPose(state, aspect, rect, course, MINIGOLF_CAMERA.fov, free);
        const [bx, bz] = ballOf(state);
        const [hx, hz] = course.hole;
        const label = `${shape} aspect ${aspect.toFixed(2)}`;
        expect(inside(seen(pose, aspect, bx, 0.2, bz), free), `ball ${label}`).toBe(true);
        expect(inside(seen(pose, aspect, pose.focus[0], 0, pose.focus[1]), free), `focus ${label}`).toBe(true);
        expect(inside(seen(pose, aspect, hx, MINIGOLF_CAMERA.flag, hz), free), `flag ${label}`).toBe(true);
      }
    }
  });

  it('a start card too tall for the course frames the whole play rect, so the course stays in front of the fog (P74 R3)', () => {
    // Karta „How I read it“ (P73B) měří na telefonu 330 px; obdélníky změřené na stránce 7. 11. (HUD nahoře, ovládání dole).
    // Kamera dostane začátek mlhy jako ve scéně (`MinigolfScene`, `airOf(look)`); hřiště se měří proti mlze, kterou
    // rig na telefonu na výšku opravdu kreslí (`airOf(…, portrait)`, P81 R3: od 0,75 dohledu, mlha profilu od 0,25).
    const farm = sceneLook({ setting: 'farm', mood: 'playful' });
    const fogStart = airOf(farm).near;
    const drawnFog = airOf(farm, true).near;
    expect(drawnFog).toBeGreaterThanOrEqual(fogStart);
    for (const phone of [{ width: 412, height: 839, top: 150, bottom: 663 }, { width: 393, height: 659, top: 151, bottom: 483 }]) {
      const rect = playRect(phone, phone.top, phone.bottom);
      const aspect = phone.width / phone.height;
      for (const [card, fits] of [[330, false], [150, true]] as const) {
        const under = playRect(rect.canvas, rect.px.top + 16 + card + 16, rect.px.bottom);
        for (const shape of MINIGOLF_SHAPES) {
          for (const seed of [1, 2, 3, 4, 5]) {
            const { state, course } = holeOf(seed, shape);
            const pose = minigolfCameraPose(state, aspect, rect, course, MINIGOLF_CAMERA.fov, under, fogStart);
            const [bx, bz] = ballOf(state);
            const [hx, hz] = course.hole;
            const label = `${shape} seed ${String(seed)} ${String(phone.width)}x${String(phone.height)} card ${String(card)} px`;
            for (const [x, z] of [[bx, bz], [hx, hz]] as const) expect(pose.position.distanceTo(new Vector3(-x / UNIT, 0, z / UNIT)), label).toBeLessThan(drawnFog);
            const frame = pose.underCard ? under : rect;
            expect(inside(seen(pose, aspect, bx, 0.2, bz), frame), `ball ${label}`).toBe(true);
            expect(inside(seen(pose, aspect, hx, MINIGOLF_CAMERA.flag, hz), frame), `flag ${label}`).toBe(true);
            // Pod vysokou kartu se hřiště nevejde nikdy; pod nízkou na Pixelu aspoň rovná dráha.
            if (!fits || (phone.height === 839 && shape === 'straight')) expect(pose.underCard, label).toBe(fits);
          }
        }
      }
    }
  });

  it('after the stroke: no jump, one smooth follow from the overview, fixed target, back to rest with no swing (P71C T2)', () => {
    for (const shape of ['straight', 'L'] as const) {
      for (const [aspect, rect] of [[TALL, RECT], [WIDE, null]] as const) {
        const label = `${shape} aspect ${aspect.toFixed(2)}`;
        const reel = film(holeOf(1, shape), aspect, rect, 36);
        const release = reel.findIndex((frame) => frame.pose.rolling);
        const stop = reel.findIndex((frame, k) => k > release && !frame.pose.rolling);
        expect(release, label).toBeGreaterThan(0);
        expect(stop - release, `${label}: the roll outlasts the follow transition`).toBeGreaterThan(60);
        // Míření: kamera stojí. Po puštění žádný skok: první 3 snímky nejvýš 0,1 m a 1°.
        for (let k = 1; k < release; k += 1) expect(moved(reel, k), `${label} aim frame ${String(k)}`).toBeLessThan(1e-9);
        for (let k = release; k < release + 3; k += 1) {
          expect(moved(reel, k), `${label} frame ${String(k - release)} after release`).toBeLessThanOrEqual(0.1);
          expect(turned(reel, k), `${label} frame ${String(k - release)} after release (deg)`).toBeLessThanOrEqual(1);
        }
        // Jeden přechod do sledování, aspoň 0,6 s: do té doby kamera na pózu sledování nedosedla.
        expect(reel[release + 35]!.eye.distanceTo(reel[release + 35]!.pose.position), `${label} still easing at 0.6 s`).toBeGreaterThan(0.05);
        expect(reel[release + 60]!.eye.distanceTo(reel[release + 60]!.pose.position), `${label} on the follow pose after the transition`).toBeLessThan(1e-6);
        // Cíl rámování se během valení nemění.
        expect(new Set(reel.slice(release, stop).map((frame) => frame.pose.focus.join(','))).size, label).toBe(1);
        // Po zastavení zpět do klidu: vzdálenost ke klidové póze jen klesá (žádné houpání) a skončí na ní.
        const rest = reel.at(-1)!.pose;
        expect(rest.rolling).toBe(false);
        const gaps = reel.slice(stop).map((frame) => frame.eye.distanceTo(rest.position));
        for (let k = 1; k < gaps.length; k += 1) expect(gaps[k]!, `${label} return frame ${String(k)}`).toBeLessThanOrEqual(gaps[k - 1]! + 1e-9);
        expect(gaps.at(-1)!, label).toBeLessThan(1);
        // Klidová osa po ráně je zase míček → cíl.
        const last = reel.at(-1)!;
        const { view, aim } = headings({ ...rest, position: last.eye, look: last.look }, minigolfCameraAxis(last.state, last.course));
        expect(view.dot(aim), label).toBeGreaterThan(0.999);
      }
    }
  });

  it('a restart mid-roll (the first touch in the feed) eases back to the tee instead of jumping (P71C T2)', () => {
    const hole = holeOf(2, 'straight');
    const reel = film(hole, TALL, RECT, 36);
    const mid = reel.findIndex((frame) => frame.pose.rolling) + 20;
    const rig = reel[mid]!.rig;
    const tee = minigolfCameraPose(hole.state, TALL, RECT, hole.course);
    const steps = Array.from({ length: 70 }, () => {
      const before = rig.eye.clone();
      minigolfCameraStep(rig, tee, 0, 1 / 60, true);
      return rig.eye.distanceTo(before);
    });
    expect(Math.max(...steps.slice(0, 3)), 'first frames after the restart').toBeLessThanOrEqual(0.1);
    expect(rig.eye.distanceTo(tee.position)).toBeLessThan(1e-6);
  });
});

/** Jeden snímek smyčky scény: stav po tiku, póza z něj a kamera po `minigolfCameraStep` (kopie). */
interface Frame {
  readonly state: ArcadeState;
  readonly course: MinigolfCourseView;
  readonly pose: MinigolfCameraPose;
  readonly eye: Vector3;
  readonly look: Vector3;
  readonly rig: ReturnType<typeof minigolfCameraRig>;
}

/**
 * Smyčka scény po snímcích 1/60 s, jeden tik na snímek: 20 tiků míření (prst táhne a krouží), pak nabití `charge`
 * tiků po ose kamery a rána; pak valení do zastavení a 90 snímků klidu.
 */
function film(hole: Hole, aspect: number, rect: PlayRect | null, charge: number): Frame[] {
  const { world, course } = hole;
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = Int32Array.from(hole.state);
  const rig = minigolfCameraRig();
  const reel: Frame[] = [];
  const axis = minigolfCameraAxis(state, course);
  let done = false;
  let calm = 0;
  for (let tick = 0; tick < 1200 && calm < 90; tick += 1) {
    let input: ArcadeInput = NO_INPUT;
    if (!done) {
      const charged = Math.max(0, state[bodyBase(state[HEADER.player] as number) + BODY.aux1] as number);
      const putt: Putt = tick < 20 ? { aim: pullBack(axis, 80 * Math.sin(tick / 5), 80), released: false } : { aim: { axis, charge }, released: charged >= charge };
      const next = puttInput(putt, charged);
      input = next.input;
      done = next.done;
    }
    step(state, input, program);
    const pose = minigolfCameraPose(state, aspect, rect, course);
    minigolfCameraStep(rig, pose, state[HEADER.tick] as number, 1 / 60, false);
    reel.push({ state: Int32Array.from(state), course, pose, eye: rig.eye.clone(), look: rig.look.clone(), rig: cloneRig(rig) });
    if (done && !pose.rolling) calm += 1;
  }
  return reel;
}

function cloneRig(rig: ReturnType<typeof minigolfCameraRig>): ReturnType<typeof minigolfCameraRig> {
  const copy = minigolfCameraRig();
  copy.eye.copy(rig.eye);
  copy.look.copy(rig.look);
  copy.fromEye.copy(rig.fromEye);
  copy.fromLook.copy(rig.fromLook);
  copy.lastEye.copy(rig.lastEye);
  copy.t = rig.t;
  copy.rolling = rig.rolling;
  copy.tick = rig.tick;
  return copy;
}

/** O kolik metrů se kamera pohnula ze snímku `k − 1` na `k`. */
const moved = (reel: readonly Frame[], k: number): number => reel[k]!.eye.distanceTo(reel[k - 1]!.eye);

/** O kolik stupňů se směr pohledu otočil ze snímku `k − 1` na `k`. */
function turned(reel: readonly Frame[], k: number): number {
  const dir = (frame: Frame): Vector3 => frame.look.clone().sub(frame.eye).normalize();
  return MathUtils.radToDeg(dir(reel[k]!).angleTo(dir(reel[k - 1]!)));
}

/**
 * Svět kolem jamky (P73D): na snímku by vypadal dobře i strom, který visí za hranou podstavce, keř na dráze, kam
 * míček dopadne, nebo koruna mezi kamerou a míčkem – pinuje se to tady skutečnými pózami kamery.
 */
describe('golf diorama dressing (P73D)', () => {
  const candy = sceneLook({ setting: 'a candy land', mood: '', look: 'meadow' });
  /** Rostlina (válec půdorysu do své výšky) protne úsečku z oka kamery na bod scény. */
  const blocks = (plant: Plant, eye: Vector3, target: Vector3): boolean => {
    for (let k = 0; k <= 200; k += 1) {
      const q = eye.clone().lerp(target, k / 200);
      if (Math.hypot(q.x - plant.x, q.z - plant.z) < plant.reach && q.y < plant.height) return true;
    }
    return false;
  };

  it('stands on the podium outside the course, off every camera line to the ball, the target and the flag; candy land adds lollipops', () => {
    for (const shape of MINIGOLF_SHAPES) {
      for (const seed of [1, 2, 3, 4]) {
        const { state, course } = holeOf(seed, shape);
        const dressing = minigolfDressing(course, candy);
        const { box, clear, land } = dressing;
        const plants = placeAround({ ...dressing, flora: dressing.flora!, seed, profile: 'desktop' });
        const label = (plant: Plant): string => `${shape} ${String(seed)} ${plant.id} ${plant.layer} (${plant.x.toFixed(1)}, ${plant.z.toFixed(1)})`;
        expect(plants.length, `${shape} ${String(seed)}`).toBeGreaterThan(40);
        expect(plants.some((plant) => plant.layer === 'mid'), `${shape} ${String(seed)} trees`).toBe(true);
        expect(plants.filter((plant) => plant.id === 'gen3d-lollipop').length, `${shape} ${String(seed)} lollipops`).toBeGreaterThanOrEqual(3);
        for (const plant of plants) {
          const gap = Math.hypot(Math.max(box.x0 - plant.x, 0, plant.x - box.x1), Math.max(box.z0 - plant.z, 0, plant.z - box.z1)) - plant.reach;
          expect(gap, label(plant)).toBeGreaterThanOrEqual(clear - 1e-6);
          expect(plant.x - plant.reach >= land.x0 && plant.x + plant.reach <= land.x1 && plant.z - plant.reach >= land.z0 && plant.z + plant.reach <= land.z1, label(plant)).toBe(true);
        }
        // Kde míček stojí (odpaliště, rohy) a valí se k dalšímu bodu trasy, na šířku i na výšku.
        const [tx, tz] = ballOf(state);
        const stops: (readonly [number, number])[] = [[tx, tz], ...course.route.slice(0, -1)];
        const states = stops.flatMap(([sx, sz], k) => {
          const [nx, nz] = course.route[k] as readonly [number, number];
          const rolling = put(state, (sx + nx) >> 1, (sz + nz) >> 1, 0, 60, 60);
          rolling[HEADER.respawnX] = sx;
          rolling[HEADER.respawnZ] = sz;
          return [put(state, sx, sz, 0), rolling];
        });
        const [hx, hz] = course.hole;
        for (const shot of states) {
          for (const aspect of [TALL, WIDE]) {
            const pose = minigolfCameraPose(shot, aspect, aspect < 1 ? RECT : FULL_WIDE, course);
            const [bx, bz] = ballOf(shot);
            const targets = [new Vector3(-bx / UNIT, 0.2, bz / UNIT), new Vector3(-pose.focus[0] / UNIT, 0, pose.focus[1] / UNIT), new Vector3(-hx / UNIT, MINIGOLF_CAMERA.flag, hz / UNIT)];
            for (const plant of plants) for (const target of targets) expect(blocks(plant, pose.position, target), `${label(plant)} aspect ${aspect.toFixed(2)} rolling ${String(pose.rolling)}`).toBe(false);
          }
        }
      }
    }
  });

  it('meadow without candy keeps its flora; candy land stays within the species cap', () => {
    const { course } = holeOf(1, 'straight');
    expect(minigolfDressing(course, LOOKS.meadow).flora).toBe(LOOKS.meadow.flora);
    expect(floraIds(minigolfDressing(course, candy).flora!).size).toBeLessThanOrEqual(FLORA_SPECIES);
    expect(floraIds(LOOKS.meadow.flora!).has('gen3d-lollipop')).toBe(false);
  });
});
