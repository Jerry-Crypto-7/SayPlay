import { join } from 'node:path';

import type { APIRequestContext, Page } from '@playwright/test';

import type { XrReport } from '../src/components/play/xr/XrRig';
import { BUTTON } from '../src/play/arcade/contract';
import { axisOfLane, laneOfX, laneX } from '../src/play/arcade/pieces/lanes';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { ROOM } from '../src/play/xr/modes';

import { expect, test } from './vr-pages';

/**
 * Svět kolem hráče (P67 T6) v emulátoru IWER: aréna, obrana a chytání stojí na podlaze pokoje, ne na stole.
 * Na každém žánru vstup do VR, skriptovaný pohyb ovladače a sonda stavu hry, že hra zareagovala:
 *
 * - aréna: levá páčka doprava → hrdina běží hráči doprava (ve skutečném prostoru, ne jen ve stavu);
 * - obrana: paprsek pravého ovladače na krajní levý pruh a spoušť → ťuk do toho pruhu, hrdina do něj přejde;
 * - chytání: pravá ruka nad krajním levým, pak krajním pravým pruhem → koš (hrdina) jede pod ruku.
 *
 * Hra jede s ručními hodinami (`byHand`). Svět se za hry nehne (hráč se nikdy nepohne bez vlastního pohybu) a podlaha
 * okolí má barvy sady prostředí, do které plátno XR kreslí (`data-look`).
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');

type Vec = readonly [number, number, number];

interface Counters {
  readonly runState: string;
  readonly tick: number;
  readonly score: number;
  readonly items: number;
}
interface Captured {
  readonly inputs: readonly { readonly tick: number; readonly buttons: number; readonly axis: number }[];
  readonly tick: number;
  readonly hash: string;
}
interface HandProbe {
  byHand(on: boolean): void;
  tickByHand(): Counters;
  capture(): Captured;
}
interface Pose {
  readonly position: { set(x: number, y: number, z: number): void };
  readonly quaternion: { set(x: number, y: number, z: number, w: number): void };
  updateButtonValue(id: string, value: number): void;
  updateAxes(id: string, x: number, y: number): void;
}
interface Quest {
  installRuntime(options?: { forceInstall?: boolean }): void;
  stereoEnabled: boolean;
  readonly position: { set(x: number, y: number, z: number): void };
  readonly quaternion: { set(x: number, y: number, z: number, w: number): void };
  readonly controllers: { readonly left?: Pose; readonly right?: Pose };
}
/** Okno stránky s emulátorem; typy `__iwerDevice` a `IWER` deklarují jiné spec soubory jinak, proto přes přetypování. */
interface QuestWindow {
  readonly IWER: { XRDevice: new (config: unknown) => Quest; metaQuest2: unknown };
  __quest: Quest;
}

/** Pravá ruka v klidu: u pasu, paprsek svisle nahoru – nikam do hry nemíří. */
const REST: Vec = [0.25, 1.0, -0.3];
const UP: readonly [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

async function withQuest2(page: Page): Promise<void> {
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript(
    ({ rest, up }) => {
      const self = window as unknown as QuestWindow;
      const device = new self.IWER.XRDevice(self.IWER.metaQuest2);
      device.stereoEnabled = true;
      device.installRuntime({ forceInstall: true });
      // Stojící hráč, hlava rovně.
      device.position.set(0, 1.6, 0);
      device.controllers.right?.position.set(...rest);
      device.controllers.right?.quaternion.set(...up);
      device.controllers.left?.position.set(-0.3, 1.0, -0.3);
      device.controllers.left?.quaternion.set(0, 0, 0, 1);
      self.__quest = device;
    },
    { rest: REST, up: UP },
  );
}

function specOf(id: string) {
  const cell = liveCells().find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`${id} is not a live cell`);
  return compileRecipe(assemblyOfCell(cell));
}

async function publish(request: APIRequestContext, id: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec: specOf(id) } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const xr = (page: Page): Promise<XrReport | null> => page.evaluate(() => window.__playXr?.() ?? null);

/** Otočení ovladače (x, y, z, w), jehož paprsek (−z) míří z `from` na `to`: nejdřív sklon, pak otočení kolem svislé osy. */
function aimFrom(from: Vec, to: Vec): readonly [number, number, number, number] {
  const [dx, dy, dz] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  const [cy, sy, cp, sp] = [Math.cos(yaw / 2), Math.sin(yaw / 2), Math.cos(pitch / 2), Math.sin(pitch / 2)];
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}

/** Jeden úsek skriptu: kolik tiků, levá páčka (x, y Gamepad API) a pravý ovladač. */
interface Step {
  readonly ticks: number;
  readonly stick?: readonly [number, number];
  readonly right?: Vec;
  readonly turn?: readonly [number, number, number, number];
  readonly trigger?: boolean;
}

/** Skript ovladači: po změně ovladače tři snímky (ovladače čte `useFrame`), pak tik po tiku jeden snímek. */
async function drive(page: Page, steps: readonly Step[]): Promise<Counters> {
  return page.evaluate(
    async ({ steps, rest, up }) => {
      const frames = (count: number) =>
        new Promise<void>((resolve) => {
          const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
          next(count);
        });
      const shell = window.__playShell as unknown as HandProbe;
      const quest = (window as unknown as QuestWindow).__quest;
      let end: Counters = { runState: 'running', tick: 0, score: 0, items: 0 };
      for (const step of steps) {
        quest.controllers.left!.updateAxes('thumbstick', ...(step.stick ?? [0, 0]));
        quest.controllers.right!.position.set(...(step.right ?? rest));
        quest.controllers.right!.quaternion.set(...(step.turn ?? up));
        quest.controllers.right!.updateButtonValue('trigger', step.trigger === true ? 1 : 0);
        await frames(3);
        for (let tick = 0; tick < step.ticks && end.runState === 'running'; tick += 1) {
          end = shell.tickByHand();
          await frames(1);
        }
      }
      return end;
    },
    { steps, rest: REST, up: UP },
  );
}

const capture = (page: Page): Promise<Captured> => page.evaluate(() => (window.__playShell as unknown as HandProbe).capture());

/** Bod jádra (jednotky) ve skutečném prostoru podle sondy: obal otočený o půl kruhu, `anchor` pod hráčem. */
const realOf = (room: NonNullable<XrReport['room']>, x: number, z: number): Vec => [room.scale * (room.anchor.x + x / 1000), 0, room.scale * (room.anchor.z - z / 1000)];

async function enter(page: Page, request: APIRequestContext, id: string): Promise<NonNullable<XrReport['room']>> {
  const url = await publish(request, id);
  await withQuest2(page);
  await page.goto(`${url}?vr=1`);
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
  await page.getByTestId('enter-vr').click();
  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await xr(page))?.room ?? null, { timeout: 15_000 }).not.toBeNull();
  const report = (await xr(page))!;
  // Kolem hráče, ne na stole; podlaha okolí v barvách sady, do které plátno kreslí.
  expect(report.desk).toBeNull();
  expect(report.sky).toBe(await page.getByTestId('arcade-stage').first().getAttribute('data-look'));
  expect(report.room!.scale).toBeGreaterThanOrEqual(ROOM.minScale);
  expect(report.room!.scale).toBeLessThanOrEqual(1);
  return report.room!;
}

/** Svět stojí, jak stál: měřítko, bod pod hráčem i póza beze změny po celé hře. */
async function stillAround(page: Page, room: NonNullable<XrReport['room']>): Promise<void> {
  expect((await xr(page))?.room).toEqual(room);
}

test.beforeEach(async () => {
  // Načtení hry, vstup do VR a stovka ručních tiků se do výchozích 30 s nevejdou.
  test.setTimeout(180_000);
});

test('arena: the player stands in the middle and the left stick runs the hero around him', async ({ openPage, request }) => {
  const page = await openPage();
  const room = await enter(page, request, 'arena.escape');
  expect(room.pose).toBe('center');
  expect(room.reach).toBeLessThanOrEqual(ROOM.reach + 1e-9);
  const start = (await xr(page))!;
  // Hrdina startuje hráči u nohou (střed arény pod hráčem).
  expect(Math.hypot(start.heroWorld!.x, start.heroWorld!.z)).toBeLessThan(0.5);

  const end = await drive(page, [{ ticks: 40, stick: [1, 0] }, { ticks: 5 }]);
  const after = (await xr(page))!;
  console.log(`arena: scale 1:${(1 / room.scale).toFixed(2)} reach ${room.reach.toFixed(1)} m, hero ${JSON.stringify(start.heroWorld)} → ${JSON.stringify(after.heroWorld)}, ${JSON.stringify(end)}`);
  expect((await capture(page)).inputs.length).toBeGreaterThan(0);
  expect(after.heroAt!.x).not.toBe(start.heroAt!.x);
  // Páčka doprava = hráči doprava: kreslený hrdina ve skutečném prostoru ujel aspoň metr na +x a skoro nic dopředu.
  expect(after.heroWorld!.x - start.heroWorld!.x).toBeGreaterThan(1);
  expect(Math.abs(after.heroWorld!.z - start.heroWorld!.z)).toBeLessThan(0.5);
  await page.screenshot({ path: test.info().outputPath('room-arena.png') });
  await stillAround(page, room);
});

test('defense: 1:1 at the base, the ray picks a lane and the trigger shoots down it', async ({ openPage, request }) => {
  const page = await openPage();
  const room = await enter(page, request, 'defense.default');
  expect(room.pose).toBe('base');
  expect(room.scale).toBe(1);
  const start = (await xr(page))!;
  // Hrdina stojí 1,5 m před hráčem v prostředním pruhu (kreslený model smí mít střed o kus jinde než tělo).
  expect(Math.abs(start.heroWorld!.x)).toBeLessThan(0.3);
  expect(Math.abs(start.heroWorld!.z + ROOM.baseBack)).toBeLessThan(0.3);

  // Paprsek na zem krajního levého pruhu 8 m za hradbou.
  const hand: Vec = [0.25, 1.2, -0.3];
  const target = realOf(room, laneX(0), 8000);
  const turn = aimFrom(hand, target);
  await drive(page, [{ ticks: 0, right: hand, turn }]);
  await expect.poll(async () => (await xr(page))?.aim ?? null, { timeout: 10_000 }).toBe(axisOfLane(0));

  await drive(page, [
    { ticks: 1, right: hand, turn, trigger: true },
    { ticks: 20, right: hand, turn },
  ]);
  const after = (await xr(page))!;
  const taps = (await capture(page)).inputs.filter((event) => (event.buttons & BUTTON.TAP) !== 0);
  console.log(`defense: hero ${JSON.stringify(start.heroAt)} → ${JSON.stringify(after.heroAt)}, taps ${JSON.stringify(taps)}`);
  expect(taps.map((event) => event.axis)).toContain(axisOfLane(0));
  expect(after.heroAt!.x).toBe(laneX(0));
  await page.screenshot({ path: test.info().outputPath('room-defense.png') });
  await stillAround(page, room);
});

test('catch: 1:3 in front of the player, the basket follows the right hand from lane to lane', async ({ openPage, request }) => {
  const page = await openPage();
  const room = await enter(page, request, 'catch.default');
  expect(room.pose).toBe('front');
  expect(room.scale).toBeCloseTo(1 / 3, 6);
  const start = (await xr(page))!;
  expect(Math.abs(start.heroWorld!.z + ROOM.catchAhead)).toBeLessThan(0.3);

  // Ruka 1,25 m vlevo, pak vpravo: za hranicí krajního pruhu (1 m od středu), ve výšce pasu nad pruhy.
  const left: Vec = [-1.25, 1.0, -0.9];
  const right: Vec = [1.25, 1.0, -0.9];
  await drive(page, [{ ticks: 0, right: left }]);
  await expect.poll(async () => (await xr(page))?.handX ?? null, { timeout: 10_000 }).toBeLessThan(-3000);
  expect(laneOfX((await xr(page))!.handX!)).toBe(0);
  await drive(page, [{ ticks: 20, right: left }]);
  const onLeft = (await xr(page))!;
  await drive(page, [{ ticks: 30, right }]);
  const onRight = (await xr(page))!;
  const holds = (await capture(page)).inputs.map((event) => event.axis);
  console.log(`catch: hero ${JSON.stringify(start.heroAt)} → ${JSON.stringify(onLeft.heroAt)} → ${JSON.stringify(onRight.heroAt)}, axes ${JSON.stringify(holds)}`);
  expect(onLeft.heroAt!.x).toBe(laneX(0));
  expect(onRight.heroAt!.x).toBe(laneX(4));
  expect(holds).toEqual(expect.arrayContaining([axisOfLane(0), axisOfLane(4)]));
  // Koš je pod rukou i ve skutečném prostoru: kreslený hrdina na straně ruky.
  expect(onLeft.heroWorld!.x).toBeLessThan(-1);
  expect(onRight.heroWorld!.x).toBeGreaterThan(1);
  await page.screenshot({ path: test.info().outputPath('room-catch.png') });
  await stillAround(page, room);
});
