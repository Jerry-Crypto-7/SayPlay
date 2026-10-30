import { join } from 'node:path';

import type { APIRequestContext, Page } from '@playwright/test';

import type { XrReport } from '../src/components/play/xr/XrRig';
import { AXIS_MAX, BUTTON } from '../src/play/arcade/contract';
import { LANE_START, axisOfLane, laneOfAxis, laneX } from '../src/play/arcade/pieces/lanes';
import { SHOOTER } from '../src/play/arcade/pieces/shooter';
import { THROW } from '../src/play/arcade/pieces/throw';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { XR_HAPTICS } from '../src/play/xr/haptics';
import { REACH, SWING } from '../src/play/xr/input-map';

import { expect, test } from './vr-pages';

/**
 * VR-nativní žánry (P65 T3) v emulátoru IWER: střílečka paprskem a spouští, hod máchnutím, bouchání úderem dolů
 * a krájení švihem. Každý žánr se hraje dvakrát s ručními hodinami (`byHand`) a robotem ověřovače, který říká, co
 * stisknout (`botWants`): ve 2D tytéž stisky, jaké pošle prst (`press` / `hold`), ve VR skriptovaný ovladač –
 * poloha, směr paprsku, spoušť a rychlost ruky. Po 5 s (300 tiků) musí mít obě hry stejné body i zásahy a aspoň jeden.
 *
 * Rychlost ruky dává na Questu runtime (`XRPose.linearVelocity`); IWER ji nedává, proto ji e2e dopíše do pózy
 * paprsku pravého ovladače – stejně, jako ji hlásí brýle.
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');
const TICKS = 300;

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
interface Counters {
  readonly runState: string;
  readonly tick: number;
  readonly score: number;
  readonly items: number;
}
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): Counters;
}
interface Pose {
  readonly position: { set(x: number, y: number, z: number): void };
  readonly quaternion: { set(x: number, y: number, z: number, w: number): void };
  updateButtonValue(id: string, value: number): void;
  updateAxes(id: string, x: number, y: number): void;
}
interface Hand {
  readonly at: readonly [number, number, number];
  /** Otočení paprsku kolem svislé osy (rad); 0 = rovně před hráče (−z). */
  readonly yaw: number;
  readonly trigger: boolean;
  readonly stick: number;
  readonly velocity: readonly [number, number, number] | null;
}

interface Device {
  installRuntime(options?: { forceInstall?: boolean }): void;
  readonly controllers: { readonly right?: Pose & { readonly inputSource: XRInputSource } };
}

/** Jeden `pulse` ovladače, jak ho zapsal špión (P67 T8). */
interface Pulse {
  readonly hand: 'left' | 'right' | '?';
  readonly intensity: number;
  readonly ms: number;
}

declare global {
  interface Window {
    __iwerDevice?: Device;
    __xrHandVelocity?: readonly [number, number, number] | null;
    __xrPulses?: Pulse[];
  }
}

async function withQuest2(page: Page): Promise<void> {
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript(() => {
    // `window.IWER` deklaruje `vr-enter.spec.ts` bez ovladačů; tady je potřeba i pravý ovladač.
    const iwer = window.IWER as unknown as { XRDevice: new (config: unknown) => Device; metaQuest2: unknown };
    const device = new iwer.XRDevice(iwer.metaQuest2);
    device.installRuntime({ forceInstall: true });
    window.__iwerDevice = device;
    // Špión na vibrace (P67 T8): každý `pulse` ovladače se zapíše s rukou, silou a délkou.
    type Actuator = { pulse(intensity: number, ms: number): Promise<boolean> };
    const actuatorOf = (hand: 'left' | 'right') =>
      (device.controllers as Partial<Record<'left' | 'right', { inputSource: XRInputSource }>>)[hand]?.inputSource.gamepad?.hapticActuators?.[0] as unknown as Actuator | undefined;
    const hands = { left: actuatorOf('left'), right: actuatorOf('right') };
    window.__xrPulses = [];
    const proto = Object.getPrototypeOf(hands.right) as Actuator;
    const pulse = proto.pulse;
    proto.pulse = function (this: Actuator, intensity: number, ms: number) {
      window.__xrPulses!.push({ hand: this === hands.right ? 'right' : this === hands.left ? 'left' : '?', intensity, ms });
      return pulse.call(this, intensity, ms);
    };
    // Rychlost ruky jako z brýlí: póza paprsku pravého ovladače dostane `linearVelocity`.
    const getPose = XRFrame.prototype.getPose;
    XRFrame.prototype.getPose = function (space, base) {
      const pose = getPose.call(this, space, base);
      const velocity = window.__xrHandVelocity;
      if (pose != null && velocity != null && space === device.controllers.right?.inputSource.targetRaySpace) {
        Object.defineProperty(pose, 'linearVelocity', { value: new DOMPointReadOnly(velocity[0], velocity[1], velocity[2], 0) });
      }
      return pose;
    };
  });
}

type Kind = 'shooter' | 'throw' | 'whack' | 'slice';

function specOf(kind: Kind) {
  const cell = liveCells().find((candidate) => candidate.id === `${kind}.default`);
  if (cell === undefined) throw new Error(`${kind}.default is not a live cell`);
  return compileRecipe(assemblyOfCell(cell));
}

async function publish(request: APIRequestContext, kind: Kind): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec: specOf(kind) } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
}

const xr = (page: Page): Promise<XrReport | null> => page.evaluate(() => window.__playXr?.() ?? null);

/** Stisky robota tik po tiku cestou prstu (2D); vrátí počítadla a co robot chtěl v každém tiku. */
async function play2d(page: Page): Promise<{ readonly end: Counters; readonly wants: readonly (Wants | null)[] }> {
  return page.evaluate((ticks) => {
    const shell = window.__playShell as unknown as HandProbe;
    const wants: (Wants | null)[] = [];
    // Robot si pamatuje stav každého tiku (`bot-hand.ts`), proto se ptá v každém, i v prvním.
    let end: Counters = { runState: 'running', tick: 0, score: 0, items: 0 };
    for (let tick = 0; tick < ticks && end.runState === 'running'; tick += 1) {
      const want = shell.botWants();
      wants.push(want);
      shell.hold(want?.axis ?? 0);
      shell.press(want?.buttons ?? 0);
      end = shell.tickByHand();
    }
    return { end, wants };
  }, TICKS);
}

/** Hody robota ze 2D běhu: od kterého tiku nabíjel, s jakým úhlem a nabitím pustil. */
function throwsOf(wants: readonly (Wants | null)[]): Map<number, { readonly aim: number; readonly charge: number }> {
  const throws = new Map<number, { aim: number; charge: number }>();
  let start: number | null = null;
  wants.forEach((want, index) => {
    const buttons = want?.buttons ?? 0;
    if ((buttons & BUTTON.HOLD) !== 0 && start === null) start = index;
    if ((buttons & BUTTON.TAP) !== 0 && start !== null) {
      throws.set(start, { aim: want!.axis, charge: index - start });
      start = null;
    }
  });
  return throws;
}

/** Inverze `throwOf`: rychlost ruky (nahoru, dopředu; m/s), která dá hod s tímto úhlem a nabitím. */
function swingFor(aim: number, charge: number): readonly [number, number] {
  const speed = SWING.throwMin + ((charge - 1) * (SWING.throwMax - SWING.throwMin)) / (THROW.maxCharge - 1);
  const angle = ((THROW.baseDeg + (aim * THROW.spanDeg) / AXIS_MAX) * Math.PI) / 180;
  return [speed * Math.sin(angle), speed * Math.cos(angle)];
}

/** Ruka pro pruh v dosahu (`REACH`): obal otočený o půl kruhu dá pruhu jádra `laneX` světové x = laneX · měřítko. */
const laneHandX = (lane: number): number => REACH.at[0] + (laneX(lane) / 1000) * REACH.scale;
/** Paprsek, který dá střílečce osu `aim` (směr nad obzorem: `aimAt(x, z)` = x / z · 1000 / tanMax). */
const yawFor = (aim: number): number => Math.atan2(-(aim * SHOOTER.tanMax) / AXIS_MAX, 1);

/** Jeden snímek ovladače: nastaví ruku, počká na snímky relace (ovladače čte `useFrame`) a odtiká tik. */
async function vrStep(page: Page, hand: Hand, settle: Hand | null, tick = true): Promise<Counters> {
  return page.evaluate(
    async ({ hand, settle, tick }) => {
      const frames = (count: number) => new Promise<void>((resolve) => {
        const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
        next(count);
      });
      const apply = (pose: Hand) => {
        const right = window.__iwerDevice!.controllers.right!;
        right.position.set(...pose.at);
        right.quaternion.set(0, Math.sin(pose.yaw / 2), 0, Math.cos(pose.yaw / 2));
        right.updateButtonValue('trigger', pose.trigger ? 1 : 0);
        right.updateAxes('thumbstick', pose.stick, 0);
        window.__xrHandVelocity = pose.velocity;
      };
      apply(hand);
      await frames(3);
      if (settle !== null) {
        apply(settle);
        await frames(3);
      }
      const shell = window.__playShell as unknown as HandProbe;
      return tick ? shell.tickByHand() : { runState: 'running', tick: 0, score: 0, items: 0 };
    },
    { hand, settle, tick },
  );
}

const stickOf = (buttons: number): number => ((buttons & BUTTON.RIGHT) !== 0 ? 1 : 0) - ((buttons & BUTTON.LEFT) !== 0 ? 1 : 0);
const HAND_Y = 0.95;
const HAND_Z = -0.4;

/** Hra ve VR týmiž stisky robota, zahranými ovladačem podle žánru. */
async function playVr(page: Page, kind: Kind, throws: ReturnType<typeof throwsOf>): Promise<Counters> {
  let yaw = 0;
  let lane = LANE_START;
  let charging = false;
  const rest: Hand = { at: [0.2, 1.2, -0.3], yaw: 0, trigger: false, stick: 0, velocity: [0, 0, 0] };
  let end: Counters = { runState: 'running', tick: 0, score: 0, items: 0 };
  for (let tick = 0; tick < TICKS && end.runState === 'running'; tick += 1) {
    const want = await page.evaluate(() => (window.__playShell as unknown as HandProbe).botWants());
    const buttons = want?.buttons ?? 0;
    const tap = (buttons & BUTTON.TAP) !== 0;
    if (kind === 'shooter') {
      if (want !== null && want.axis !== 0) yaw = yawFor(want.axis);
      const aimed: Hand = { ...rest, at: [0.2, 1.3, -0.2], yaw, stick: stickOf(buttons) };
      end = await vrStep(page, { ...aimed, trigger: tap }, tap ? aimed : null);
    } else if (kind === 'throw') {
      const planned = throws.get(tick);
      if ((buttons & BUTTON.HOLD) !== 0 && !charging && planned !== undefined) {
        charging = true;
        const [vy, vz] = swingFor(planned.aim, planned.charge);
        // Dopředu ve hře je −z světa (obal otočený o půl kruhu).
        end = await vrStep(page, { ...rest, trigger: true, velocity: [0, vy, -vz] }, null);
      } else if (tap && charging) {
        charging = false;
        end = await vrStep(page, { ...rest, trigger: false, velocity: [0, 0, 0] }, null);
      } else {
        end = await vrStep(page, { ...rest, trigger: charging }, null);
      }
    } else {
      if (tap) lane = want!.axis !== 0 ? laneOfAxis(want!.axis) : lane;
      const over: Hand = { ...rest, at: [laneHandX(lane), HAND_Y, HAND_Z] };
      const strike: readonly [number, number, number] = kind === 'whack' ? [0, -(SWING.whack + 1.5), 0] : [SWING.slice + 1.5, 0, 0];
      end = await vrStep(page, tap ? { ...over, velocity: strike } : over, tap ? over : null);
    }
  }
  return end;
}

test.beforeEach(async () => {
  // Dvě načtení hry, vstup do VR a 2 × 300 tiků se do výchozích 30 s nevejdou.
  test.setTimeout(240_000);
});

for (const kind of ['shooter', 'throw', 'whack', 'slice'] as const) {
  test(`${kind}: the controller scores in VR exactly as the finger does in 2D`, async ({ openPage, request }) => {
    const url = await publish(request, kind);

    const flat = await openPage();
    await flat.goto(url);
    await ready(flat);
    const reference = await play2d(flat);
    await flat.close();
    console.log(`${kind} 2D: ${JSON.stringify(reference.end)}`);
    expect(reference.end.score + reference.end.items, 'the bot scores within 5 s in 2D').toBeGreaterThan(0);

    const page = await openPage();
    await withQuest2(page);
    await page.goto(`${url}?vr=1`);
    await ready(page);
    await page.getByTestId('enter-vr').click();
    await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);

    // Pravý ovladač už v relaci míří: osu dá paprsek (střílečka) nebo ruka (hod, krájení, bouchání), až scéna ovladač
    // i prostor relace dostane – v relaci to jsou až další snímky, ne hned `presenting`. Bez tiku, hra zůstává na 0.
    // Ruka nad krajním pruhem je opravdu nad ním: svět krájení stojí v dosahu ruky.
    const lanes = kind === 'whack' || kind === 'slice';
    const at: Hand['at'] = lanes ? [laneHandX(0), HAND_Y, HAND_Z] : kind === 'shooter' ? [0.2, 1.3, -0.2] : [0.2, 1.2, -0.3];
    await vrStep(page, { at, yaw: 0, trigger: false, stick: 0, velocity: [0, 0, 0] }, null, false);
    await expect
      .poll(async () => {
        const report = await xr(page);
        return kind === 'shooter' ? (report?.aim ?? null) : (report?.laneAxis ?? null);
      }, { timeout: 10_000 })
      .toEqual(lanes ? axisOfLane(0) : expect.any(Number));

    const played = await playVr(page, kind, throwsOf(reference.wants));
    console.log(`${kind} VR: ${JSON.stringify(played)}`);
    if (kind === 'shooter') expect((await xr(page))?.aim).not.toBeNull();
    expect({ score: played.score, items: played.items, runState: played.runState }).toEqual({ score: reference.end.score, items: reference.end.items, runState: reference.end.runState });

    // Zásah zavibruje pravým ovladačem (P67 T8): každý pulz je záznam tabulky `xr/haptics.ts`.
    const pulses = await page.evaluate(() => window.__xrPulses ?? []);
    const sound = await page.evaluate(() => ({ audio: window.__playAudio?.state() ?? null, spatial: window.__playXrSound?.() ?? null }));
    console.log(`${kind} VR pulses: ${pulses.length} ${JSON.stringify(pulses.slice(0, 3))}, sound: ${JSON.stringify(sound)}`);
    const felt = Object.values(XR_HAPTICS).filter((haptic) => haptic !== null);
    expect(pulses.filter((pulse) => pulse.hand === 'right').length, 'a hit buzzes the right controller').toBeGreaterThan(0);
    for (const pulse of pulses) expect(felt, JSON.stringify(pulse)).toContainEqual(expect.objectContaining({ intensity: pulse.intensity, ms: pulse.ms }));
    // Zvuk událostí zní z místa těla přes panner, posluchač je hlava brýlí (IWER stojí ve výšce očí).
    expect(sound.audio).toBe('running');
    expect(sound.spatial?.placed ?? 0, 'game sounds go through the panner in VR').toBeGreaterThan(0);
    expect(sound.spatial?.listener?.y ?? 0).toBeGreaterThan(1);
  });
}
