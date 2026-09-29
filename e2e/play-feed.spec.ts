import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Feed na `/play` (P23-D T4, svislý feed P27B T4). Do skutečného feedu jde
 * jen autorská verze od režiséra a e2e model nevolá – hry se proto publikují
 * hotovým specem z fixtur a řádky feedu nad nimi dodá `page.route`. Detail
 * každé hry (`GET /api/play/games/<id>`) jde skutečnými dveřmi.
 *
 * Feed drží vždy jedno připojené plátno; po deseti přechodech se nesmí
 * nahromadit ani plátna, ani paměť.
 */

test.use({ launchOptions: { args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] } });

const FIXTURES = [
  ['runner.json', 'Feed runner through the canyon'],
  ['platform.json', 'Feed platform over the rooftops'],
  ['flap.json', 'Feed flap between the pipes'],
  ['rhythm.json', 'Feed rhythm on four lanes'],
] as const;

interface Row {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
  readonly createdAt: string;
  readonly parentId: null;
  readonly remixes: number;
}

async function publish(request: APIRequestContext): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [index, [fixture, title]] of FIXTURES.entries()) {
    const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', fixture), 'utf8')) as Record<string, unknown>;
    const response = await request.post('/api/play/games', { data: { spec: { ...base, title } } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const body = (await response.json()) as { versionId: string; archetype: string };
    rows.push({ versionId: body.versionId, title, archetype: body.archetype, createdAt: new Date(Date.now() - index * 1000).toISOString(), parentId: null, remixes: index });
  }
  return rows;
}

async function serveFeed(page: Page, rows: readonly Row[]): Promise<void> {
  await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: rows, next: null }) }));
}

/**
 * Viditelná hra: `?g=`, slide feedu a titul v HUD musí mluvit o téže verzi.
 * Od P33 T8 stojí místo hry plakát a hra se bez klepnutí nepřipojí.
 */
async function expectShowing(page: Page, row: Row): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`[?&]g=${row.versionId}(&|$)`));
  await expect(page.getByTestId('feed-current')).toHaveAttribute('data-version-id', row.versionId);
  const poster = page.getByTestId('feed-poster');
  await expect(poster).toContainText(row.title, { timeout: 30_000 });
  await expect(poster).toContainText('Tap to play');
  await expect(page.getByTestId('feed-current').locator('canvas')).toHaveCount(0);
  await poster.click();
  await expect(page.locator('.play-hud-title')).toHaveText(row.title, { timeout: 30_000 });
  await expect(page.getByTestId('arcade-stage').locator('canvas')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('canvas')).toHaveCount(1);
}

const heap = (page: Page): Promise<number> =>
  page.evaluate(() => {
    (window as unknown as { gc?: () => void }).gc?.();
    return (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
  });

test.describe('/play – vertical feed', () => {
  let rows: Row[] = [];

  test.beforeAll(async ({ request }) => {
    rows = await publish(request);
  });

  test('drafts stay out of the real feed', async ({ request }) => {
    const draft = await request.post('/api/play/games', { data: { sentence: 'A hamster escapes a supermarket while a giant Roomba hunts it.' } });
    expect(draft.status()).toBeLessThan(300);
    const draftId = ((await draft.json()) as { versionId: string }).versionId;
    const real = await request.get('/api/play/games?recent=24');
    expect(real.status()).toBe(200);
    const ids = ((await real.json()) as { games: { versionId: string }[] }).games.map((game) => game.versionId);
    expect(ids).not.toContain(draftId);
    for (const row of rows) expect(ids).not.toContain(row.versionId);
  });

  test('desktop: ten moves there and back keep one canvas, the URL follows and Back returns', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await serveFeed(page, rows);
    await page.goto('/play');
    await expectShowing(page, rows[0]);
    // Široká obrazovka: seznam dalších vpravo, klepnutí přepne hru.
    await expect(page.getByTestId('play-feed-card')).toHaveCount(rows.length);
    await expect(page.getByTestId('play-feed-card').nth(1)).toContainText('1 remix');
    await expect(page.getByTestId('play-feed-card').first()).not.toContainText('remixes');

    const moves = [1, 1, 1, -1, -1, -1, 1, 1, -1, -1];
    let at = 0;
    let warm = 0;
    for (const [n, move] of moves.entries()) {
      await page.getByTestId(move > 0 ? 'feed-next' : 'feed-prev').click();
      at += move;
      await expectShowing(page, rows[at]);
      if (n === 1) warm = await heap(page);
    }
    expect(at).toBe(0);
    const after = await heap(page);
    expect(after, `heap ${String(warm)} → ${String(after)}`).toBeLessThanOrEqual(warm * 1.3);

    await page.getByTestId('play-feed-card').nth(2).click();
    await expectShowing(page, rows[2]);
    await page.goBack();
    await expectShowing(page, rows[0]);
    await page.goForward();
    await expectShowing(page, rows[2]);
  });

  test('phone: one game fills the screen and a swipe on the rail moves the feed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveFeed(page, rows);
    await page.goto(`/play?g=${rows[1].versionId}`);
    await expectShowing(page, rows[1]);
    await expect(page.getByTestId('play-feed-card').first()).toBeHidden();
    const slide = await page.getByTestId('feed-current').boundingBox();
    expect(slide?.height ?? 0).toBeGreaterThanOrEqual(844 * 0.8);

    const rail = page.getByTestId('feed-rail');
    await rail.scrollIntoViewIfNeeded();
    const box = await rail.boundingBox();
    if (box === null) throw new Error('rail has no box');
    const x = box.x + box.width / 2;
    const swipe = async (from: number, to: number): Promise<void> => {
      await page.mouse.move(x, from);
      await page.mouse.down();
      await page.mouse.move(x, to, { steps: 6 });
      await page.mouse.up();
    };
    await swipe(box.y + box.height * 0.7, box.y + box.height * 0.3);
    await expectShowing(page, rows[2]);
    await swipe(box.y + box.height * 0.3, box.y + box.height * 0.7);
    await expectShowing(page, rows[1]);
    await page.getByTestId('feed-next').click();
    await expectShowing(page, rows[2]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('typing a sentence does not play the game underneath', async ({ page }) => {
    await serveFeed(page, rows);
    await page.goto('/play');
    await expectShowing(page, rows[0]);
    const box = page.locator('.play-sentence');
    await box.fill('');
    await box.pressSequentially('a sad dog swims');
    await expect(box).toHaveValue('a sad dog swims');
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(0);
  });

  test('after the runner ends, ↓ moves to the next game (P28B T3)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await serveFeed(page, rows);
    await page.goto('/play');
    await expectShowing(page, rows[0]);
    await page.getByTestId('feed-current').scrollIntoViewIfNeeded();
    const outcome = await page.evaluate(() => window.__playShell!.playWitness());
    expect(outcome.runState).not.toBe('running');
    await expect(page.getByTestId('play-outcome')).toBeVisible();
    // Posluchače hry odpojí efekt až po vykreslení výsledku; člověk tak rychle neklikne.
    await page.waitForTimeout(300);
    // Skončená hra už šipky nebere – patří feedu.
    await page.keyboard.press('ArrowDown');
    await expectShowing(page, rows[1]);
  });

  // P28D T7: prázdný feed pořád hraje – pevnou ukázkovou hru z repa – a říká, že jiné hry nejsou.
  test('an empty feed says so honestly and plays the demo game', async ({ page }) => {
    await serveFeed(page, []);
    await page.goto('/play');
    await expect(page.getByTestId('play-feed-empty')).toHaveText('No games yet – write the first sentence.');
    await expect(page.getByTestId('feed-demo').locator('canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.play-hud-title')).toHaveText('Fox Runs City Dodging');
    await expect(page.locator('.play-hud-share')).toHaveCount(0);
  });

  test('a feed outage says so, plays the demo and the form still works', async ({ page }) => {
    await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.goto('/play');
    await expect(page.getByTestId('feed-error')).toHaveText('The feed is not available right now. You can still make a game below.');
    await expect(page.getByTestId('feed-demo').locator('canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.play-sentence')).toBeVisible();
  });

  // AC P28D T7: do 3 s po načtení je plátno nahoře a hra bere vstup bez klepnutí na „Play“.
  test('the landing page plays a game within 3 s', async ({ page }) => {
    await serveFeed(page, []);
    await page.goto('/play');
    await expect(page.locator('canvas')).toHaveCount(1, { timeout: 3_000 });
    const top = await page.locator('canvas').boundingBox();
    const form = await page.locator('.play-sentence').boundingBox();
    expect(top!.y).toBeLessThan(form!.y);
    // Bez dotyku hraje robot dokola: první obrazovka nikdy neukáže „You lost“ (runner prohraje do 3 s).
    await expect(page.getByTestId('play-demo')).toBeVisible();
    for (let second = 0; second < 8; second += 1) {
      await page.waitForTimeout(1000);
      await expect(page.getByTestId('play-outcome')).toHaveCount(0);
    }
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('play-demo')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBeGreaterThan(0);
  });
});
