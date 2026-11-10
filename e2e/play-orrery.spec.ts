import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';

/**
 * Klikací simulace (P83C T3) – kouř scény. Hra z ručního specu `e2e/fixtures/p83c-orrery-spec.json` (sluneční
 * soustava: slunce ve středu a osm planet na třech drahách, klepnutí zrychlí; typ je `staged`, věty ho zatím nevolí).
 *
 * - Stránka se načte, scéna zapíše `data-orrery-things` (střed věci ve zlomku plátna a poloměr v px, `OrreryScene`).
 * - Jmenovky všech věcí jsou vidět od startu (T7); klepnutí na věc zvedne počítadlo HUD; dráhy se do 2 s od startu
 *   viditelně posunou.
 * - T7: na telefonu se jmenovky (`data-orrery-tags`) nepřekrývají a neopustí plátno – na startu i během oběhu.
 * - Telefon 390 × 844: devět věcí se na plátně nepřekrývá ani jako cíle klepnutí (dosah ≥ 22 px od středu, cíl
 *   ≥ 44 px) – na startu i během oběhu.
 * - Snímky do `D:/tmp/p83c/` (`P83C_SHOTS` cestu přepíše). FPS (`@measure`): telefon 390 × 844, okna po 4 s
 *   prokládaně s hrou třídění (`p66-sort-spec.json`) jako referencí; medián orrery ≥ 40 FPS. Čísla do
 *   `D:/tmp/p83c/fps.json`.
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p83c-orrery-spec.json');
const REFERENCE = join(process.cwd(), 'e2e/fixtures/p66-sort-spec.json');
const SHOTS = process.env.P83C_SHOTS ?? 'D:/tmp/p83c';
const THINGS = 9;
const TOUCH_MIN = 44;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } as const;
const FPS_WINDOW_MS = 4_000;
const FPS_ROUNDS = 3;
const FPS_MIN_MEDIAN = 40;

interface Spot {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function publish(request: APIRequestContext, file: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec: JSON.parse(readFileSync(file, 'utf8')) as unknown } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Věci na stránce (px stránky) z `data-orrery-things`. */
async function spots(page: Page): Promise<Spot[]> {
  const stage = page.getByTestId('arcade-stage');
  const raw = (await stage.getAttribute('data-orrery-things')) ?? '';
  const box = (await stage.boundingBox())!;
  return raw.split(';').map((spot) => {
    const [fx, fy, r] = spot.split(',').map(Number) as [number, number, number];
    return { x: box.x + fx * box.width, y: box.y + fy * box.height, r };
  });
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'orrery', { timeout: 90_000 });
  await expect(stage).toHaveAttribute('data-orrery-things', new RegExp(`^(?:[\\d.]+,[\\d.]+,[\\d.]+;){${THINGS - 1}}[\\d.]+,[\\d.]+,[\\d.]+$`), { timeout: 90_000 });
}

const counter = (page: Page) => page.locator('.play-hud-count[data-testid^="hud-counter-"]').first();
const tick = async (page: Page): Promise<number> => Number(await page.getByTestId('arcade-stage').getAttribute('data-orrery-tick'));
const tagCount = (page: Page) => page.evaluate(() => window.__playFrame!().items['orrery-tag']?.count ?? 0);

interface Tag {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Jmenovky na stránce (px stránky) z `data-orrery-tags` (P83C T7): střed ve zlomku plátna, šířka a výška v px. */
async function tags(page: Page): Promise<Tag[]> {
  const stage = page.getByTestId('arcade-stage');
  const raw = (await stage.getAttribute('data-orrery-tags')) ?? '';
  const box = (await stage.boundingBox())!;
  return raw === '' ? [] : raw.split(';').map((tag) => {
    const [fx, fy, w, h] = tag.split(',').map(Number) as [number, number, number, number];
    return { x: box.x + fx * box.width, y: box.y + fy * box.height, w, h };
  });
}

/** Žádné dvě jmenovky se nepřekrývají o víc než 1 px a každá leží na plátně. */
async function tagIssues(page: Page): Promise<string[]> {
  const list = await tags(page);
  const box = (await page.getByTestId('arcade-stage').boundingBox())!;
  const issues: string[] = [];
  list.forEach((a, i) => {
    if (a.x - a.w / 2 < box.x - 1 || a.x + a.w / 2 > box.x + box.width + 1 || a.y - a.h / 2 < box.y - 1 || a.y + a.h / 2 > box.y + box.height + 1) issues.push(`tag ${i} leaves the canvas`);
    list.slice(i + 1).forEach((b, k) => {
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1) issues.push(`tags ${i} and ${i + 1 + k} overlap`);
    });
  });
  return issues;
}

/** Klepne na věc `index` tam, kde je teď (prst na telefonu, myš na desktopu). */
async function tapThing(page: Page, index: number, touch: boolean): Promise<void> {
  const spot = (await spots(page))[index]!;
  const under = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element?.closest('[data-testid="arcade-stage"]') != null ? 'stage' : `${element?.tagName ?? 'nothing'}.${String(element?.className ?? '')}`;
  }, spot);
  expect(under, `thing ${String(index)} at ${spot.x.toFixed(0)},${spot.y.toFixed(0)} r ${String(spot.r)} is not covered by the page`).toBe('stage');
  if (touch) await page.touchscreen.tap(spot.x, spot.y);
  else await page.mouse.click(spot.x, spot.y);
}

/** Žádné dvě věci se nepřekrývají kresbou ani dosahem prstu (každý dosah ≥ polovina 44 px). */
function overlaps(list: readonly Spot[]): string[] {
  const issues: string[] = [];
  list.forEach((a, i) => {
    list.slice(i + 1).forEach((b, k) => {
      const j = i + 1 + k;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < a.r + b.r) issues.push(`things ${i} and ${j} overlap on screen (${distance.toFixed(1)} px < ${(a.r + b.r).toFixed(1)} px)`);
      if (distance < TOUCH_MIN) issues.push(`things ${i} and ${j} share a tap target (${distance.toFixed(1)} px < ${TOUCH_MIN} px)`);
    });
  });
  return issues;
}

async function phonePage(browser: Browser): Promise<Page> {
  const context = await browser.newContext(PHONE);
  return context.newPage();
}

/** Medián FPS z dob snímků `requestAnimationFrame` za `ms`. */
const fpsFor = (page: Page, ms: number) =>
  page.evaluate(
    (window_) =>
      new Promise<number>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const end = last + window_;
        const frame = (now: number) => {
          deltas.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(frame);
          else {
            deltas.sort((a, b) => a - b);
            resolve(1000 / (deltas[Math.floor(deltas.length / 2)] as number));
          }
        };
        requestAnimationFrame(frame);
      }),
    ms,
  );

test.describe('orrery (P83C T3)', () => {
  test.describe.configure({ mode: 'serial' });
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request, FIXTURE);
    mkdirSync(SHOTS, { recursive: true });
  });

  test('orrery: the page loads, a tap on a planet wakes it and shows its name, orbits move within 2 s', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, url);
    await expect(counter(page)).toHaveAttribute('data-count', '0');
    // T7: jména jsou vidět od startu, ne až po klepnutí.
    await expect.poll(() => tagCount(page), { timeout: 5_000 }).toBe(THINGS);
    await page.screenshot({ path: join(SHOTS, 'desktop-start.png') });

    await tapThing(page, 4, false);
    await expect(counter(page)).toHaveAttribute('data-count', '1', { timeout: 5_000 });
    const from = await spots(page);
    const fromTick = await tick(page);
    await page.waitForTimeout(2_000);
    const to = await spots(page);
    expect(await tick(page), 'the clock runs after the first tap').toBeGreaterThan(fromTick + 60);
    const moved = to.slice(1).filter((spot, index) => Math.hypot(spot.x - from[index + 1]!.x, spot.y - from[index + 1]!.y) > 8).length;
    expect(moved, 'every planet moved along its orbit in 2 s').toBe(THINGS - 1);

    await tapThing(page, 7, false);
    await tapThing(page, 7, false);
    await expect(counter(page)).toHaveAttribute('data-count', '2', { timeout: 5_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, 'desktop-three-taps.png') });
    expect(errors).toEqual([]);
  });

  test('orrery: on a 390 × 844 phone nine things never overlap and a finger tap wakes one', async ({ browser }) => {
    const page = await phonePage(browser);
    const errors = watchErrors(page);
    await open(page, url);
    await page.waitForTimeout(500);
    const start = await spots(page);
    expect(start).toHaveLength(THINGS);
    expect(overlaps(start)).toEqual([]);
    expect(await tags(page)).toHaveLength(THINGS);
    expect(await tagIssues(page)).toEqual([]);
    await page.screenshot({ path: join(SHOTS, 'phone-start.png') });

    await tapThing(page, 2, true);
    await expect(counter(page)).toHaveAttribute('data-count', '1', { timeout: 5_000 });
    const seen: string[] = [];
    for (let sample = 0; sample < 12; sample += 1) {
      await page.waitForTimeout(500);
      seen.push(...overlaps(await spots(page)).map((issue) => `t${String(sample)}: ${issue}`));
      seen.push(...(await tagIssues(page)).map((issue) => `t${String(sample)}: ${issue}`));
    }
    expect(seen).toEqual([]);
    await tapThing(page, 5, true);
    await tapThing(page, 8, true);
    await expect(counter(page)).toHaveAttribute('data-count', '3', { timeout: 5_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, 'phone-three-taps.png') });
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test('orrery: phone FPS interleaved with the sort reference @measure', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const reference = await publish(request, REFERENCE);
    const runs: { game: string; round: number; fps: number }[] = [];
    for (let round = 0; round < FPS_ROUNDS; round += 1) {
      for (const [game, target] of [['orrery', url], ['sort', reference]] as const) {
        const page = await phonePage(browser);
        await page.goto(target);
        await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', game, { timeout: 90_000 });
        if (game === 'orrery') {
          await open(page, target);
          await tapThing(page, 1, true);
        } else await page.getByTestId('arcade-stage').tap();
        await page.waitForTimeout(1_000);
        runs.push({ game, round, fps: Math.round((await fpsFor(page, FPS_WINDOW_MS)) * 10) / 10 });
        await page.context().close();
      }
    }
    const median = (game: string): number => {
      const list = runs.filter((run) => run.game === game).map((run) => run.fps).sort((a, b) => a - b);
      return list[Math.floor(list.length / 2)] as number;
    };
    const summary = { note: 'P83C T3: phone 390x844 DPR 3, 4 s rAF windows after the first tap, orrery and sort interleaved. Written by e2e/play-orrery.spec.ts.', orrery: median('orrery'), sort: median('sort'), runs };
    writeFileSync(join(SHOTS, 'fps.json'), `${JSON.stringify(summary, null, 1)}\n`);
    expect(summary.orrery, JSON.stringify(summary)).toBeGreaterThanOrEqual(FPS_MIN_MEDIAN);
  });
});
