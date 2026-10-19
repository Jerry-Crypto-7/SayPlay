import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { browserRenderer } from '../scripts/browser-renderer';

/**
 * Náhled robota na aktivní kartě feedu a převzetí ťukem (P54A T7).
 *
 * Po dosednutí karty hraje robot ve trvalém plátně feedu (`StageHost`) a tik
 * roste; ťuk na scénu nebo klávesa hru předá hráči a jeho první vstup padne
 * do tiku 0. Po dvaceti přechodech feed pořád ukázal jediné plátno.
 * Hry jdou do feedu jako v `play-feed.spec.ts`: hotový spec z fixtur, řádky
 * feedu přes `page.route`, detail skutečnými dveřmi (nese `preview` z publikace).
 */

// Vlastní `launchOptions` přepíše ty z konfigurace – bez `browserRenderer()` by plátno kreslil SwiftShader (~3 FPS).
test.use({ launchOptions: { args: browserRenderer().args } });

const FIXTURES = [
  ['runner.json', 'Reels runner through the canyon'],
  ['platform.json', 'Reels platform over the rooftops'],
  ['flap.json', 'Reels flap between the pipes'],
  ['rhythm.json', 'Reels rhythm on four lanes'],
] as const;

interface Row {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
  readonly createdAt: string;
  readonly parentId: null;
  readonly remixes: number;
}

interface FeedProbe {
  readonly versionId: string | null;
  readonly mode: 'preview' | 'play' | 'result';
  readonly tick: number;
  readonly contexts: number;
}

async function publish(request: APIRequestContext): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [index, [fixture, title]] of FIXTURES.entries()) {
    const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', fixture), 'utf8')) as Record<string, unknown>;
    const response = await request.post('/api/play/games', { data: { spec: { ...base, title } } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const body = (await response.json()) as { versionId: string; archetype: string };
    rows.push({ versionId: body.versionId, title, archetype: body.archetype, createdAt: new Date(Date.now() - index * 1000).toISOString(), parentId: null, remixes: 0 });
  }
  return rows;
}

const probe = (page: Page): Promise<FeedProbe> => page.evaluate(() => window.__playFeed!());

/**
 * Aktivní karta dosedla v okně feedu. Klik Playwrightu posouvá tlačítko do
 * pohledu i uvnitř feedu – na kartě, která ještě jede, by posunul feed o kartu dál.
 */
async function expectSnapped(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const reel = document.querySelector('[data-testid="feed-reel"]');
        const card = reel?.querySelector('[data-active="true"]');
        if (reel === null || reel === undefined || card === null || card === undefined) return Number.NaN;
        return Math.round(card.getBoundingClientRect().top - reel.getBoundingClientRect().top - reel.clientTop);
      }),
    )
    .toBe(0);
}

/** Do 2 s po dosednutí: aktivní je `row`, hraje náhled a tik roste. */
async function expectPreview(page: Page, row: Row): Promise<void> {
  await expect.poll(async () => (await probe(page)).versionId, { timeout: 2_000 }).toBe(row.versionId);
  await expectSnapped(page);
  await expect.poll(async () => (await probe(page)).mode, { timeout: 30_000 }).toBe('preview');
  const first = (await probe(page)).tick;
  await expect.poll(async () => (await probe(page)).tick, { timeout: 5_000 }).toBeGreaterThan(first);
  await expect(page.getByTestId('feed-hint')).toBeVisible();
}

test.describe('/play – bot preview in the feed', () => {
  let rows: Row[] = [];

  test.beforeAll(async ({ request }) => {
    rows = await publish(request);
  });

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: rows, next: null }) }));
  });

  test('desktop: ↓ brings the next preview, a key takes over in tick 0, twenty moves keep one canvas', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/play?g=${rows[0].versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expectPreview(page, rows[0]);

    await page.keyboard.press('ArrowDown');
    await expectPreview(page, rows[1]);
    await page.keyboard.press('ArrowUp');
    await expectPreview(page, rows[0]);

    // Klávesa, kterou hra bere: převezme ji a padne do tiku 0 hráčova běhu.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await probe(page)).mode).toBe('play');
    await expect(page.getByTestId('feed-hint')).toBeHidden();
    const inputs = await page.evaluate(() => window.__playShell!.inputs() as unknown as readonly { readonly tick: number }[]);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0]?.tick).toBe(0);

    for (let move = 0; move < 20; move += 1) {
      const target = move % 6 < 3 ? 'feed-next' : 'feed-prev';
      const before = (await probe(page)).versionId;
      await page.getByTestId(target).click();
      await expect.poll(async () => (await probe(page)).versionId).not.toBe(before);
      await expectSnapped(page);
    }
    await expect.poll(async () => (await probe(page)).mode, { timeout: 30_000 }).toBe('preview');
    expect((await probe(page)).contexts).toBe(1);
    await expect(page.locator('canvas')).toHaveCount(1);
  });

  test.describe('phone', () => {
    // Pixel 7 bez `defaultBrowserType` – ten ve skupině nastavit nejde a prohlížeč je tentýž.
    const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];
    test.use(pixel7);

    test('a swipe brings the next preview and a tap on the scene takes over', async ({ page }) => {
      await page.goto(`/play?g=${rows[1].versionId}`);
      await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
      await expectPreview(page, rows[1]);

      const rail = page.getByTestId('feed-rail');
      const box = await rail.boundingBox();
      if (box === null) throw new Error('rail has no box');
      const x = box.x + box.width / 2;
      await page.mouse.move(x, box.y + box.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(x, box.y + box.height * 0.3, { steps: 6 });
      await page.mouse.up();
      await expectPreview(page, rows[2]);

      const stage = await page.getByTestId('feed-current').getByTestId('arcade-stage').boundingBox();
      if (stage === null) throw new Error('stage has no box');
      await page.touchscreen.tap(stage.x + stage.width / 3, stage.y + stage.height / 2);
      await expect.poll(async () => (await probe(page)).mode).toBe('play');
      const inputs = await page.evaluate(() => window.__playShell!.inputs() as unknown as readonly { readonly tick: number }[]);
      if (inputs.length > 0) expect(inputs[0]?.tick).toBe(0);
      expect((await probe(page)).contexts).toBe(1);
    });
  });
});
