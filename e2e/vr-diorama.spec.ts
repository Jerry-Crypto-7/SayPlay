import { join } from 'node:path';

import type { APIRequestContext, Page } from '@playwright/test';

import type { XrReport } from '../src/components/play/xr/XrRig';
import { BUTTON } from '../src/play/arcade/contract';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { DESK, TABLE } from '../src/play/xr/diorama-scale';

import { expect, test } from './vr-pages';

/**
 * Diorama (P65 T4) v emulátoru IWER: 15 žánrů mimo čtyři VR-nativní se hraje na desce před hráčem. Každý žánr
 * se zahraje dvakrát s ručními hodinami (`byHand`) a týmž skriptem 300 tiků (5 s): ve 2D skutečnou klávesnicí
 * (šipky, mezerník), ve VR páčkou a spouští pravého ovladače (páčka = šipky, spoušť = mezerník,
 * `docs/vr/README.md`). Obě hry musí skončit v témže stavu (hash) a hrdina se musí pohnout nebo změnit počítadlo.
 *
 * Hrdina ve VR musí být po celou hru v zorném poli: každých 30 tiků se jeho střed promítne kamerou obou očí
 * (uvnitř snímku, ne za okem) a leží nad deskou. Hlava stojí ve výšce 1,6 m a dívá se na střed desky, jako hráč
 * u stolu. Paprsek pravého ovladače míří nahoru, aby ťuk spouští nemířil na pruh (`XrAim` – to je dotyk, ne klávesa).
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');
const TICKS = 300;
/** Jak často se hrdina promítá do očí (tiky). */
const LOOK_EVERY = 30;

type Key = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Space';
/** Klávesa držená od tiku `from` do tiku `to` (bez něj). */
type Hold = readonly [key: Key, from: number, to: number];

const taps = (key: Key, ticks: readonly number[]): Hold[] => ticks.map((tick) => [key, tick, tick + 3]);
const every = (from: number, step: number): number[] => Array.from({ length: Math.floor((TICKS - from) / step) }, (_, index) => from + index * step);

/** Skript každého žánru: co nejjednodušší, aby se hrdina pohnul nebo se změnilo počítadlo. Buňka = první z rodiny v `PRESETS`. */
const GENRES: Readonly<Record<string, readonly Hold[]>> = {
  'runner.default': [['ArrowLeft', 20, 26], ['Space', 90, 94], ['ArrowRight', 150, 156], ['ArrowRight', 200, 206]],
  'platformer.default': [['ArrowRight', 10, 250], ...taps('Space', [60, 150])],
  'flap.default': taps('Space', every(10, 25)),
  'timing.stack': taps('Space', [60, 150, 240]),
  'rhythm.default': taps('Space', every(20, 20)),
  'duel.default': [...taps('Space', [40, 120, 200]), ...taps('ArrowDown', [80, 160])],
  'arena.escape': [['ArrowRight', 10, 120], ['ArrowUp', 125, 230], ['ArrowLeft', 235, 300]],
  'voyage.race': [['ArrowDown', 60, 180]],
  'quest.spatial': [['ArrowUp', 10, 150], ['ArrowRight', 155, 290]],
  'catch.default': [...taps('ArrowLeft', [30]), ...taps('ArrowRight', [90, 150])],
  'defense.default': [...taps('ArrowLeft', [30]), ...taps('Space', [60, 150]), ...taps('ArrowRight', [120])],
  'hop.default': taps('ArrowUp', every(20, 40)),
  'crowd.default': [...taps('ArrowLeft', [30]), ...taps('ArrowRight', [100, 160])],
  'merge.default': [['ArrowLeft', 10, 60], ...taps('Space', [70]), ['ArrowRight', 100, 160], ...taps('Space', [170])],
  'push.default': [['ArrowUp', 10, 200], ...taps('Space', [100])],
};

interface Counters {
  readonly runState: string;
  readonly tick: number;
  readonly score: number;
  readonly items: number;
  readonly health: number;
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

/** Sklon hlavy dolů na střed desky (rad). */
const PITCH = Math.atan2(1.6 - TABLE.top, -TABLE.z);

async function withQuest2(page: Page): Promise<void> {
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript((pitch) => {
    const self = window as unknown as QuestWindow;
    const device = new self.IWER.XRDevice(self.IWER.metaQuest2);
    // Dvě oči jako v brýlích: každé má půlku plátna a svou projekci.
    device.stereoEnabled = true;
    device.installRuntime({ forceInstall: true });
    device.position.set(0, 1.6, 0);
    device.quaternion.set(-Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    // Paprsek pravého ovladače svisle nahoru: nikam na desku nemíří.
    device.controllers.right?.position.set(0.25, 1.2, -0.25);
    device.controllers.right?.quaternion.set(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
    device.controllers.left?.position.set(-0.3, 1.1, -0.4);
    device.controllers.left?.quaternion.set(0, 0, 0, 1);
    self.__quest = device;
  }, PITCH);
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

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
}

const xr = (page: Page): Promise<XrReport | null> => page.evaluate(() => window.__playXr?.() ?? null);

interface Played {
  readonly first: Counters;
  readonly end: Counters;
  readonly captured: Captured;
}

/** 2D: klávesy skriptu skutečnou klávesnicí, po každém tiku jeden snímek (scény jako slučování v něm pouštějí). */
async function play2d(page: Page, script: readonly Hold[]): Promise<Played> {
  let first: Counters | null = null;
  let end: Counters | null = null;
  for (let tick = 0; tick < TICKS && (end === null || end.runState === 'running'); tick += 1) {
    for (const [key, , to] of script) if (to === tick) await page.keyboard.up(key);
    for (const [key, from] of script) if (from === tick) await page.keyboard.down(key);
    end = await page.evaluate(async () => {
      const counters = (window.__playShell as unknown as HandProbe).tickByHand();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return counters;
    });
    first ??= end;
  }
  const captured = await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture());
  return { first: first!, end: end!, captured };
}

interface Look {
  readonly tick: number;
  readonly at: XrReport['heroAt'];
  readonly view: XrReport['heroView'];
  readonly desk: XrReport['heroOnDesk'];
}

/**
 * VR: týž skript páčkou a spouští pravého ovladače, celý v jedné smyčce ve stránce. Po změně ovladače tři snímky
 * (ovladače čte `useFrame`), jinak jeden; každých `LOOK_EVERY` tiků dva snímky na dokreslení a pohled na hrdinu.
 */
async function playVr(page: Page, script: readonly Hold[]): Promise<Played & { readonly looks: readonly Look[] }> {
  return page.evaluate(
    async ({ script, ticks, lookEvery }) => {
      const frames = (count: number) =>
        new Promise<void>((resolve) => {
          const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
          next(count);
        });
      const shell = window.__playShell as unknown as HandProbe;
      const right = (window as unknown as QuestWindow).__quest.controllers.right!;
      const held = (key: Key, tick: number) => script.some(([k, from, to]) => k === key && tick >= from && tick < to);
      const looks: Look[] = [];
      let before = '';
      let first: Counters | null = null;
      let end: Counters | null = null;
      for (let tick = 0; tick < ticks && (end === null || end.runState === 'running'); tick += 1) {
        const x = Number(held('ArrowRight', tick)) - Number(held('ArrowLeft', tick));
        // Gamepad API: páčka od sebe = záporné y.
        const y = Number(held('ArrowDown', tick)) - Number(held('ArrowUp', tick));
        const trigger = held('Space', tick);
        const now = `${String(x)},${String(y)},${String(trigger)}`;
        if (now !== before) {
          right.updateAxes('thumbstick', x, y);
          right.updateButtonValue('trigger', trigger ? 1 : 0);
          before = now;
          await frames(3);
        } else {
          await frames(1);
        }
        end = shell.tickByHand();
        first ??= end;
        if ((tick + 1) % lookEvery === 0) {
          await frames(2);
          const report = window.__playXr!();
          looks.push({ tick: end.tick, at: report.heroAt, view: report.heroView, desk: report.heroOnDesk });
        }
      }
      return { first: first!, end: end!, captured: shell.capture(), looks };
    },
    { script, ticks: TICKS, lookEvery: LOOK_EVERY },
  );
}

/** Střed hrdiny v obou očích uvnitř snímku a hrdina nad deskou (s přesahem o půl hrdiny – stojí u kraje). */
function lostLooks(looks: readonly Look[]): string[] {
  const slack = 0.05;
  return looks.flatMap(({ tick, view, desk }) => {
    const eyes = view ?? [];
    const seen = eyes.length > 0 && eyes.every((eye) => eye !== null && !eye.behind && Math.abs(eye.x) <= 1 && Math.abs(eye.y) <= 1);
    const onDesk = desk !== null && Math.abs(desk.x) <= TABLE.width / 2 + slack && Math.abs(desk.z) <= TABLE.depth / 2 + slack && desk.y >= -slack && desk.y <= TABLE.height + slack;
    return seen && onDesk ? [] : [`tick ${String(tick)}: eyes ${JSON.stringify(view)}, desk ${JSON.stringify(desk)}`];
  });
}

test.beforeEach(async () => {
  // Dvě načtení hry, vstup do VR a 2 × 300 tiků se do výchozích 30 s nevejdou.
  test.setTimeout(240_000);
});

for (const [id, script] of Object.entries(GENRES)) {
  test(`${id}: the table-top diorama plays like the keyboard and keeps the hero in view`, async ({ openPage, request }) => {
    const url = await publish(request, id);

    const flat = await openPage();
    await flat.goto(url);
    await ready(flat);
    const reference = await play2d(flat, script);
    await flat.close();
    console.log(`${id} 2D: ${JSON.stringify(reference.end)} ${String(reference.captured.inputs.length)} inputs`);
    expect(reference.captured.inputs.length, 'the keyboard script reaches the game').toBeGreaterThan(0);

    const page = await openPage();
    await withQuest2(page);
    await page.goto(`${url}?vr=1`);
    await ready(page);
    await page.getByTestId('enter-vr').click();
    await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await xr(page))?.desk?.scale ?? null, { timeout: 15_000 }).not.toBeNull();
    const desk = (await xr(page))!.desk!;
    // Deska stojí, kde má: 0,9 m před hráčem, deska ve výšce 0,8 m, svět nejvýš 1:12.
    expect({ x: desk.x, top: desk.top, z: desk.z, yaw: desk.yaw }).toEqual(DESK);
    expect(desk.scale).toBeLessThanOrEqual(1 / 12);
    const start = (await xr(page))!.heroAt;

    const played = await playVr(page, script);
    const after = await xr(page);
    console.log(`${id} VR: ${JSON.stringify(played.end)} scale 1:${(1 / desk.scale).toFixed(1)} hero ${JSON.stringify(start)} → ${JSON.stringify(after?.heroAt)}`);

    // Ovladač zahrál totéž co klávesnice: stejné vstupy a stejný stav hry do bitu.
    expect(played.captured.inputs).toEqual(reference.captured.inputs);
    expect(played.captured.hash).toBe(reference.captured.hash);
    expect({ score: played.end.score, items: played.end.items, health: played.end.health, runState: played.end.runState }).toEqual({
      score: reference.end.score,
      items: reference.end.items,
      health: reference.end.health,
      runState: reference.end.runState,
    });
    // Pohnul se kdykoli během hry (plošinovka může do konce spadnout a vrátit se na start); po konci hry tělo už nikdo nečte.
    const positions = [...played.looks.map((look) => look.at), after?.heroAt ?? null].filter((at) => at !== null);
    const moved = start !== null && positions.some((at) => JSON.stringify(at) !== JSON.stringify(start));
    const counted = played.end.score !== played.first.score || played.end.items !== played.first.items || played.end.health !== played.first.health;
    console.log(`${id}: moved ${String(moved)}, counted ${String(counted)}`);
    expect(moved || counted, 'the hero moved or a counter changed').toBe(true);

    expect(played.looks.length).toBeGreaterThanOrEqual(Math.min(TICKS, played.end.tick) / LOOK_EVERY - 1);
    expect(lostLooks(played.looks)).toEqual([]);

    if (id === 'quest.spatial') {
      // Levý grip nese desku a do hry nejde; pravý grip dál drží použití (`interact`).
      const grip = async (hand: 'left' | 'right', squeeze: number, dx = 0) =>
        page.evaluate(
          async ({ hand, squeeze, dx }) => {
            const controller = (window as unknown as QuestWindow).__quest.controllers[hand]!;
            if (dx !== 0) controller.position.set(-0.3 + dx, 1.1, -0.4);
            controller.updateButtonValue('squeeze', squeeze);
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            return (window.__playShell as unknown as HandProbe).tickByHand();
          },
          { hand, squeeze, dx },
        );
      const from = played.end.tick;
      await grip('left', 1);
      await grip('left', 1, 0.2);
      await grip('left', 0, 0.2);
      const carried = (await xr(page))!.desk!;
      expect(carried.x).toBeCloseTo(DESK.x + 0.2, 3);
      expect(carried.z).toBeCloseTo(DESK.z, 3);
      const leftInputs = (await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture())).inputs.filter((event) => event.tick >= from);
      expect(leftInputs.some((event) => (event.buttons & BUTTON.INTERACT) !== 0), 'the left grip is not a game input').toBe(false);
      await grip('right', 1);
      await grip('right', 0);
      const rightInputs = (await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture())).inputs.filter((event) => event.tick >= from);
      expect(rightInputs.some((event) => (event.buttons & BUTTON.INTERACT) !== 0), 'the right grip still interacts').toBe(true);
    }
  });
}
