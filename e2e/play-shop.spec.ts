import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type CDPSession, expect, type Page, test } from '@playwright/test';

import { cellOfAxis } from '../src/play/arcade/pieces/lanes';
import { tagText } from '../src/components/play/arcade/genres/shop/shop-text';
import { HUD_COUNTER_LABELS } from './hud-labels';

/**
 * Obchod se součtem na telefonu i na desktopu (P83E T3): hra z ručního specu `e2e/fixtures/p83e-shop-spec.json`
 * (tři věci, cena; klasifikátor žánr pustí až T4) se otevře a dohraje – na `pixel7-touch` prstem na cenovku, na
 * `chromium` myší. Kam ťuknout, říká robot ověřovače přes sondu (`bot-hand.ts`), hodiny jsou ruční. Po každé položené
 * věci se součet v HUD (`hud-counter-total`) rovná součtu cenovek na pultu v DOM (`shop-tag`, `data-state` 2).
 * Cenovky jsou čitelné (≥ 14 px písma), v konzoli žádná chyba. FPS: 5 s živé hry s ťuky, medián ≥ 40.
 * Snímky (start, první věc, výhra) do `D:/tmp/p83e/` (`P83E_SHOTS` cestu přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p83e-shop-spec.json');
const SHOTS = process.env.P83E_SHOTS ?? 'D:/tmp/p83e';
const PLACED = 2;
const FPS_MIN_MEDIAN = 40;

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

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`${error.message}\n${error.stack ?? ''}`));
  page.on('console', (message) => {
    // Hláška rekordéru klipu (MP4 `avc1`) při změně rozlišení plátna, ne obchodu (jako `play-sort.spec.ts`).
    if (message.type() === 'error' && !message.text().startsWith('When using "avc1"')) errors.push(message.text());
  });
  return errors;
}

async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('arcade-stage')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-shop-spots', /^[\d.]+,[\d.]+,\d(;[\d.]+,[\d.]+,\d)*$/, { timeout: 30_000 });
  await expect(page.getByTestId('shop-tag').first()).toBeVisible({ timeout: 30_000 });
}

/** Místa věcí ze snímku nakresleného po tiku `tick` (px stránky, bod cenovky). */
async function spotsAt(page: Page, tick: number): Promise<{ readonly x: number; readonly y: number; readonly state: number }[]> {
  await page.waitForFunction((wanted) => Number(document.querySelector<HTMLElement>('[data-testid="arcade-stage"]')?.dataset.shopTick ?? -1) >= wanted, tick, { timeout: 10_000 });
  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('[data-testid="arcade-stage"]')!;
    const box = stage.getBoundingClientRect();
    return (stage.dataset.shopSpots ?? '').split(';').map((part) => {
      const [x, y, state] = part.split(',').map(Number) as [number, number, number];
      return { x: box.left + x * box.width, y: box.top + y * box.height, state };
    });
  });
}

/** Součet cenovek na pultu v DOM (jednotky hry). */
const placedSum = (page: Page): Promise<number> =>
  page.locator(`[data-testid="shop-tag"][data-state="${String(PLACED)}"]`).evaluateAll((tags) => tags.reduce((sum, tag) => sum + Number(tag.getAttribute('data-value')), 0));

class Finger {
  constructor(private readonly cdp: CDPSession) {}
  async tap(x: number, y: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

test('shop: the bot carries three items to the counter and the HUD total equals the tags (P83E T3)', async ({ page, request, context }, info) => {
  test.setTimeout(300_000);
  const touch = info.project.name === 'pixel7-touch';
  mkdirSync(SHOTS, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
  const errors = watchErrors(page);
  await openGame(page, await publishFixture(request));
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'shop');
  const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
  for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);
  const total = page.getByTestId('hud-counter-total');
  await expect(total).toContainText(tagText(0, 'price'));
  await expect(page.getByTestId('shop-tag')).toHaveCount(3);
  const fontPx = await page.getByTestId('shop-tag').first().evaluate((tag) => Number.parseFloat(getComputedStyle(tag).fontSize));
  expect(fontPx, 'cenovka čitelná').toBeGreaterThanOrEqual(14);
  const allTags = await page.getByTestId('shop-tag').evaluateAll((tags) => tags.reduce((sum, tag) => sum + Number(tag.getAttribute('data-value')), 0));
  await shot('start');

  const finger = touch ? new Finger(await context.newCDPSession(page)) : null;
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
  // Robot se ptá před každým tikem od tiku 0 (`bot-hand.ts` si pamatuje viděný stav po tiky reakce).
  let last = { runState: 'running', tick: 0, score: 0, items: 0 };
  let placed = 0;
  while (last.runState === 'running' && last.tick < 6000) {
    const wants = await page.evaluate(() => (window.__playShell as unknown as HandProbe).botWants());
    if (wants !== null && (wants.buttons & 1) !== 0) {
      const spot = (await spotsAt(page, last.tick))[cellOfAxis(wants.axis)]!;
      // Ťuk kousek pod cenovku – na věc samotnou.
      if (finger !== null) await finger.tap(Math.round(spot.x), Math.round(spot.y + 20));
      else await page.mouse.click(spot.x, spot.y + 20);
    }
    last = await page.evaluate(() => (window.__playShell as unknown as HandProbe).tickByHand());
    // Po poslední věci hra skončí výhrou a cenovky s plochou zmizí – součet pak hlídá karta výsledku.
    if (last.items > placed && last.runState === 'running') {
      placed = last.items;
      await spotsAt(page, last.tick);
      await expect.poll(() => placedSum(page), { timeout: 5_000 }).toBeGreaterThan(0);
      const sum = await placedSum(page);
      await expect(total).toHaveAttribute('data-count', String(sum));
      await expect(total).toContainText(tagText(sum, 'price'));
      if (placed === 1) await shot('first-item');
    }
  }
  console.log(`shop (${info.project.name}): ${last.runState} at tick ${last.tick}, ${last.items} placed, total ${await total.textContent()}`);
  expect(last.runState).toBe('won');
  expect(last.items).toBe(3);
  expect(placed).toBe(2);
  await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
  // Karta výsledku ukáže součet všech tří cenovek.
  await expect(page.getByTestId('play-postrun')).toContainText(tagText(allTags, 'price'));
  await shot('result');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('shop: a player who does nothing loses on the clock (P83E T3)', async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await openGame(page, await publishFixture(request));
  const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
  expect(end.runState).toBe('lost');
  await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-postrun')).not.toContainText('You did it!');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('shop: the live game runs smoothly while items are carried (FPS, P83E T3)', async ({ page, request, context }, info) => {
  test.setTimeout(180_000);
  const touch = info.project.name === 'pixel7-touch';
  await openGame(page, await publishFixture(request));
  const finger = touch ? new Finger(await context.newCDPSession(page)) : null;
  const measuring = page.evaluate(
    (windowMs) =>
      new Promise<number[]>((resolve) => {
        const gaps: number[] = [];
        let before = performance.now();
        const start = before;
        const frame = (now: number) => {
          gaps.push(now - before);
          before = now;
          if (now - start < windowMs) requestAnimationFrame(frame);
          else resolve(gaps);
        };
        requestAnimationFrame(frame);
      }),
    5_000,
  );
  for (let slot = 0; slot < 3; slot += 1) {
    const spot = (await spotsAt(page, 0))[slot]!;
    if (finger !== null) await finger.tap(Math.round(spot.x), Math.round(spot.y + 20));
    else await page.mouse.click(spot.x, spot.y + 20);
    await page.waitForTimeout(1_200);
  }
  const gaps = (await measuring).slice(1).sort((a, b) => a - b);
  const median = 1000 / (gaps[Math.floor(gaps.length / 2)] as number);
  const p95 = gaps[Math.floor(gaps.length * 0.95)] as number;
  console.log(`shop FPS (${info.project.name}): median ${median.toFixed(1)}, p95 frame ${p95.toFixed(1)} ms, ${gaps.length} frames`);
  expect(median).toBeGreaterThanOrEqual(FPS_MIN_MEDIAN);
});
