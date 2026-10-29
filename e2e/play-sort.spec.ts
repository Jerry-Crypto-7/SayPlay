import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type CDPSession, expect, type Page, test } from '@playwright/test';

import { BUTTON } from '../src/play/arcade/contract';
import { LEGIBLE_CAP, LEGIBLE_SHARE } from '../src/play/arcade/models';
import { laneOfAxis } from '../src/play/arcade/pieces/lanes';
import { HUD_COUNTER_LABELS } from './hud-labels';

/**
 * Třídění na telefonu i na desktopu (P66 T8): hra z ručního specu `e2e/fixtures/p66-sort-spec.json` (`genre.v6`,
 * bez klasifikátoru – ten žánr pustí až T12) se otevře a dohraje – na `pixel7-touch` prstem do sloupců front, na
 * `chromium` šipkami a mezerníkem. Kam ťuknout, říká robot ověřovače přes sondu (`bot-hand.ts`), hodiny jsou ruční.
 * Hra skončí kartou výhry, nečinný hráč kartou prohry; v konzoli žádná chyba; hrdina je čitelný. Na telefonu leží
 * nádoby i čela front ve spodních 45 % výšky. Snímky pro oko do `D:/caches/p66/sort/` (`P66_SORT_SHOTS` cestu přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p66-sort-spec.json');
const SHOTS = process.env.P66_SORT_SHOTS ?? 'D:/caches/p66/sort';
/** `--sp-size-touch-min` (px). */
const TOUCH_MIN = 44;

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  tickByHand(): { readonly runState: string; readonly tick: number; readonly score: number; readonly items: number };
  idleRun(): { readonly runState: string; readonly tick: number };
}

async function publishFixture(request: APIRequestContext): Promise<string> {
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/**
 * Hláška Chromia, ne třídění (jako `play-segments.spec.ts`): na telefonu hlídač kvality během hry přepne úroveň a s ní
 * rozlišení plátna, a rekordér klipu (`clip.ts`, MP4 `avc1`) to zaloguje jako chybu. Vada patří rekordéru klipu.
 */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(CLIP_RESOLUTION_WARNING)) errors.push(message.text());
  });
  return errors;
}

/** Hra otevřená a nakreslená: hrdina v záběru, sonda relace, hranice front na ploše. */
async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('arcade-stage')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-lane-edges', /^-?[\d.]+(?:,-?[\d.]+){3}$/, { timeout: 30_000 });
}

/** Atributy scény ze snímku nakresleného po tiku `tick` (scéna je píše v `useFrame`). */
async function sceneAt(page: Page, tick: number): Promise<{ readonly edges: number[]; readonly queue: number; readonly heads: number; readonly bins: number }> {
  await page.waitForFunction((wanted) => Number(document.querySelector<HTMLElement>('[data-testid="arcade-stage"]')?.dataset.sortTick ?? -1) >= wanted, tick, { timeout: 10_000 });
  return page.evaluate(() => {
    const data = document.querySelector<HTMLElement>('[data-testid="arcade-stage"]')!.dataset;
    return { edges: (data.laneEdges ?? '').split(',').map(Number), queue: Number(data.sortQueue), heads: Number(data.sortHeads), bins: Number(data.sortBins) };
  });
}

/** Jeden prst na skle: ťuk = položit a zvednout. */
class Finger {
  constructor(private readonly cdp: CDPSession) {}
  async tap(x: number, y: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

test('sort: the game opens, plays to a win by taps or keys and ends on the win card (P66 T8)', async ({ page, request, context }, info) => {
  // ~3000 ruční tiků po třech dotazech sondy: pod zátěží souběžných buildů 6 min.
  test.setTimeout(600_000);
  const touch = info.project.name === 'pixel7-touch';
  mkdirSync(SHOTS, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
  const errors = watchErrors(page);
  await openGame(page, await publishFixture(request));
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'sort');

  // Hrdina čitelný: aspoň `LEGIBLE_SHARE.hero` výšky obrazu, nebo zvětšený na strop čitelnosti.
  const hero = await page.evaluate(() => {
    const frame = window.__playFrame!();
    return { share: (frame.hero!.maxY - frame.hero!.minY) / 2, legible: frame.legible.hero };
  });
  expect(hero.share, JSON.stringify(hero)).toBeGreaterThanOrEqual(hero.legible >= LEGIBLE_CAP ? 0.08 * LEGIBLE_CAP : LEGIBLE_SHARE.hero);
  // Počítadla HUD jen z uzavřeného anglického seznamu.
  const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
  for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);

  const start = await sceneAt(page, 0);
  await shot('start');
  if (touch) {
    // Na výšku: nádoby i čela front (to, nač se klepe) ve spodních 45 % výšky plátna.
    expect(start.bins).toBeGreaterThanOrEqual(0.55);
    expect(start.heads).toBeGreaterThanOrEqual(0.55);
    expect(start.bins).toBeLessThanOrEqual(1);
  }

  const box = (await stage.boundingBox())!;
  /** Sloupec fronty je dotykový cíl: hranice front v řadě čel, krajní sloupce sahají k okraji plátna. */
  const columnBounds = (edges: readonly number[]): number[] => [0, ...edges.filter((edge) => edge >= 0 && edge <= 1), 1];
  const narrowestOf = (edges: readonly number[]): number => {
    const bounds = columnBounds(edges);
    return Math.min(...bounds.slice(1).map((edge, index) => (edge - (bounds[index] as number)) * box.width));
  };
  // Nejužší sloupec přes celou hru (ve finále je front nejvíc).
  let narrowest = narrowestOf(start.edges);
  let mostQueues = columnBounds(start.edges).length - 1;
  const finger = touch ? new Finger(await context.newCDPSession(page)) : null;
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
  // První tik bez ťuku (robot v tempu ještě nechce nic; `botWants` se ptá před každým tikem, `bot-hand.ts` si tak
  // pamatuje viděný stav tiku 0): kolo začne a háčky ukážou banner kola (T4).
  expect(await page.evaluate(() => (window.__playShell as unknown as HandProbe).botWants())).toEqual({ buttons: 0, axis: 0 });
  let last = await page.evaluate(() => (window.__playShell as unknown as HandProbe).tickByHand());
  await expect(page.getByTestId('hook-round-banner')).toHaveText('Round 1 of 3');
  /** Fronta, do které robot chce ťuknout a klávesnice k ní teprve jde. */
  let goal: number | null = null;
  let mid = false;
  while (last.runState === 'running' && last.tick < 7000) {
    const wants = await page.evaluate(() => (window.__playShell as unknown as HandProbe).botWants());
    if (goal === null && wants !== null && (wants.buttons & BUTTON.TAP) !== 0) {
      const scene = await sceneAt(page, last.tick);
      narrowest = Math.min(narrowest, narrowestOf(scene.edges));
      mostQueues = Math.max(mostQueues, columnBounds(scene.edges).length - 1);
      const first = scene.edges.filter((edge) => edge < 0).length;
      const queue = laneOfAxis(wants.axis) - first;
      if (finger !== null) {
        // Střed sloupce fronty v řadě čel: hranice front promítnuté scénou (`data-lane-edges`).
        const bounds = columnBounds(scene.edges);
        const x = box.x + box.width * (((bounds[queue] as number) + (bounds[queue + 1] as number)) / 2);
        await finger.tap(Math.round(x), Math.round(box.y + box.height * scene.heads));
      } else goal = queue;
    }
    if (goal !== null) {
      const scene = await sceneAt(page, last.tick);
      const key = scene.queue < goal ? 'ArrowRight' : scene.queue > goal ? 'ArrowLeft' : ' ';
      await page.keyboard.press(key);
      if (key === ' ') goal = null;
    }
    last = await page.evaluate(() => (window.__playShell as unknown as HandProbe).tickByHand());
    if (!mid && last.items >= 12) {
      mid = true;
      await sceneAt(page, last.tick);
      await shot('mid');
    }
  }
  console.log(`sort (${info.project.name}): ${last.runState} at tick ${last.tick}, ${last.items} sorted, score ${last.score}, narrowest column ${narrowest.toFixed(0)} px of ${mostQueues} queues`);
  expect(last.runState).toBe('won');
  expect(mid).toBe(true);
  // Finále (5 front) se hrálo a ani v něm není sloupec užší než dotykový cíl.
  expect(mostQueues).toBe(5);
  expect(narrowest, 'sloupec fronty užší než dotykový cíl').toBeGreaterThanOrEqual(TOUCH_MIN);
  await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
  await shot('result');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('sort: a player who does nothing loses on the round clock and gets the loss card (P66 T8)', async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await openGame(page, await publishFixture(request));
  const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
  expect(end).toEqual({ runState: 'lost', tick: 3600 });
  await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-postrun')).not.toContainText('You did it!');
  await page.screenshot({ path: join(SHOTS, `${info.project.name}-lost.png`) });
  expect(errors, errors.join('\n')).toEqual([]);
});
