import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { browserRenderer } from '../scripts/browser-renderer';

/**
 * Feed na `/play` (P23-D T4, svislý feed P27B T4). Do skutečného feedu jde
 * jen autorská verze od režiséra a e2e model nevolá – hry se proto publikují
 * hotovým specem z fixtur a řádky feedu nad nimi dodá `page.route`. Detail
 * každé hry (`GET /api/play/games/<id>`) jde skutečnými dveřmi.
 *
 * Feed drží vždy jedno připojené plátno; po deseti přechodech se nesmí
 * nahromadit ani plátna, ani paměť.
 */

// Vlastní `launchOptions` přepíše ty z konfigurace – bez `browserRenderer()` by plátno kreslil SwiftShader (~3 FPS).
test.use({ launchOptions: { args: [...browserRenderer().args, '--js-flags=--expose-gc', '--enable-precise-memory-info'] } });

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
 * Od P54A T7 na kartě hned hraje náhled robota v jediném plátně feedu.
 */
async function expectShowing(page: Page, row: Row): Promise<void> {
  await expectActive(page, row);
  await expect(page.locator('.play-hud-title')).toHaveText(row.title, { timeout: 30_000 });
  await expect(page.getByTestId('feed-hint')).toContainText('Tap to play');
  await expect(page.getByTestId('arcade-stage').locator('canvas')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('canvas')).toHaveCount(1);
}

/** `?g=`, aktivní karta snap feedu a karta dosednutá v okně feedu (P54A T6). */
async function expectActive(page: Page, row: Row): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`[?&]g=${row.versionId}(&|$)`));
  await expect(page.getByTestId('feed-current')).toHaveAttribute('data-version-id', row.versionId);
  await expect(page.locator('[data-testid="feed-card"][data-active="true"]')).toHaveAttribute('data-version-id', row.versionId);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const reel = document.querySelector('[data-testid="feed-reel"]');
        const card = reel?.querySelector('[data-active="true"]');
        if (reel === null || reel === undefined || card === null || card === undefined) return Number.NaN;
        // `clientTop` je celé číslo, rámeček feedu 2,5 px – dosednutá karta je do 1 px.
        return Math.abs(card.getBoundingClientRect().top - reel.getBoundingClientRect().top - reel.clientTop);
      }),
    )
    .toBeLessThan(1);
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
    // Široká obrazovka: „Up next“ = nejvýš tři karty za aktuální (T12), klepnutí přepne hru.
    const upNext = page.getByTestId('play-feed-card');
    await expect(upNext).toHaveCount(Math.min(3, rows.length - 1));
    await expect(upNext.first()).toContainText(rows[1].title);
    await expect(upNext.first()).toContainText('1 remix');
    await expect(upNext.first()).not.toContainText('remixes');

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

    await upNext.nth(1).click();
    await expectShowing(page, rows[2]);
    // Paměť se srovnává na téže hře (třetí) jako `warm`: scéna jiné hry váží jinak a nahromadění by předstírala.
    // P56B T12: s novým vzhledem má scéna runneru o ~3,7 MB víc než na `72665fdc` a runner vs. třetí hra dával 1,32;
    // třetí hra vs. třetí hra 0,98 na `72665fdc` a 0,90 s novým vzhledem, proto strop 1,1 místo 1,3.
    const after = await heap(page);
    expect(after, `heap ${String(warm)} → ${String(after)}`).toBeLessThanOrEqual(warm * 1.1);
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

  // P54A T6: tah kolečkem dosedne na další kartu a adresu jen přepíše – Back nevede přes každou kartu.
  test('phone: a scroll snaps to the next card and replaces the address', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveFeed(page, rows);
    await page.goto(`/play?g=${rows[1].versionId}`);
    await expectActive(page, rows[1]);
    await expect(page.locator('.play-hud-title')).toHaveText(rows[1].title, { timeout: 30_000 });
    const reel = page.getByTestId('feed-reel');
    await reel.scrollIntoViewIfNeeded();
    const card = await page.getByTestId('feed-current').boundingBox();
    // Výška obrazovky bez plovoucího tab baru kitu (66 px + 16 px od spodní hrany).
    expect(card?.height ?? 0).toBeGreaterThanOrEqual(844 - 66 - 16 - 1);
    const entries = await page.evaluate(() => window.history.length);
    const box = await reel.boundingBox();
    if (box === null) throw new Error('reel has no box');
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    await page.mouse.wheel(0, 500);
    await expectActive(page, rows[2]);
    expect(await page.evaluate(() => window.history.length)).toBe(entries);
    await page.mouse.wheel(0, -500);
    await expectActive(page, rows[1]);
  });

  test('thirty games keep at most seven cards in the DOM and PageDown moves one card', async ({ page }) => {
    const many: Row[] = [...rows];
    for (let n = many.length; n < 30; n += 1) many.push({ ...rows[n % rows.length], versionId: `feed-window-${String(n)}`, title: `Window game ${String(n)}` });
    await page.setViewportSize({ width: 1280, height: 800 });
    await serveFeed(page, many);
    await page.goto(`/play?g=${many[15].versionId}`);
    await expectActive(page, many[15]);
    await expect(page.getByTestId('feed-card')).toHaveCount(7);
    await expect(page.locator('.play-reel-gap')).toHaveCount(23);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    // Feed bere klávesy, až když je vidět – IO to řekne až v příštím snímku.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const entries = await page.evaluate(() => window.history.length);
    await page.keyboard.press('PageDown');
    await expectActive(page, many[16]);
    expect(await page.evaluate(() => window.history.length)).toBe(entries + 1);
    expect(await page.getByTestId('feed-card').count()).toBeLessThanOrEqual(7);
    await page.goBack();
    await expectActive(page, many[15]);
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
    // Od P54A T7 hraje na kartě robot (až když je feed vidět); běh hráče začne klávesou, kterou hra bere.
    await expect(page.getByTestId('feed-hint')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('feed-hint')).toBeHidden();
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
    await expect(page.getByTestId('play-feed-empty')).toHaveText('No games yet. Make the first one.');
    await expect(page.getByTestId('feed-demo').locator('canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.play-hud-title')).toHaveText('Fox Runs City Dodging');
    await expect(page.locator('.play-hud-share')).toHaveCount(0);
  });

  test('a feed outage says so, plays the demo and the form still works', async ({ page }) => {
    await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.goto('/play');
    await expect(page.getByTestId('feed-error')).toHaveText('The feed is not available right now. You can still make your own game.');
    await expect(page.getByTestId('feed-demo').locator('canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.play-sentence')).toBeVisible();
  });

  // AC P28D T7: do 3 s po načtení hraje plátno a hra bere vstup bez klepnutí na „Play“.
  // Pole pro větu stojí od P54A T12 na desktopu v levém sloupci vedle hry (na telefonu nad ní),
  // hláška výpadku feedu proto na formulář neukazuje směrem.
  test('the landing page plays a game within 3 s', async ({ page }) => {
    await serveFeed(page, []);
    await page.goto('/play');
    await expect(page.locator('canvas')).toHaveCount(1, { timeout: 3_000 });
    const game = await page.locator('canvas').boundingBox();
    const form = await page.locator('.play-sentence').boundingBox();
    expect(form!.x + form!.width).toBeLessThanOrEqual(game!.x);
    await expect(page.locator('.play-sentence')).toBeInViewport();
    // Jedna h1 na stránce (P33 T13): titul nad polem; název hry v HUD je h2.
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h2.play-hud-title')).toHaveCount(1);
    // Bez dotyku hraje robot dokola: první obrazovka nikdy neukáže prohru „So close.“ (runner prohraje do 3 s).
    await expect(page.getByTestId('play-demo')).toBeVisible();
    for (let second = 0; second < 8; second += 1) {
      await page.waitForTimeout(1000);
      await expect(page.getByTestId('play-outcome')).toHaveCount(0);
    }
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('play-demo')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBeGreaterThan(0);
  });

  // AC P56B T12: tři vytvořené a zahrané hry mají v „Up next“ i v kartách feedu svůj snímek, ne `/og`.
  test('three played games show their own frame, not /og, in Up next and the feed', async ({ page, request }) => {
    const sentences = ['a bear catches falling honey jars in a basket', 'a wizard defends his tower from goblin hordes', 'help the duck cross the highway and the river'];
    const played: Row[] = [];
    for (const sentence of sentences) {
      const response = await request.post('/api/play/games', { data: { sentence } });
      expect(response.status(), await response.text()).toBeLessThan(300);
      const body = (await response.json()) as { versionId: string; archetype: string };
      played.push({ versionId: body.versionId, title: sentence, archetype: body.archetype, createdAt: new Date().toISOString(), parentId: null, remixes: 0 });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    // Úložiště se otevírá se stejnou verzí a obchodem jako aplikace: dotaz nesmí založit prázdnou databázi bez obchodu.
    const kept = (): Promise<string[]> =>
      page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const open = indexedDB.open('sayplay-frames', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('frames');
            open.onerror = () => resolve([]);
            open.onsuccess = () => {
              const keys = open.result.transaction('frames', 'readonly').objectStore('frames').getAllKeys();
              keys.onsuccess = () => {
                open.result.close();
                resolve(keys.result.map(String));
              };
              keys.onerror = () => resolve([]);
            };
          }),
      );
    for (const game of played) {
      await page.goto(`/play/${game.versionId}`);
      await expect(page.getByTestId('arcade-stage').locator('canvas')).toHaveCount(1, { timeout: 30_000 });
      await expect.poll(kept, { timeout: 30_000 }).toContain(game.versionId);
    }

    await serveFeed(page, [rows[0], ...played]);
    await page.goto('/play');
    await expectShowing(page, rows[0]);
    const thumbs = page.locator('img.play-feed-thumb');
    await expect(thumbs).toHaveCount(3);
    const shots = page.getByTestId('feed-shot');
    await expect(shots).toHaveCount(3, { timeout: 15_000 });
    for (const [n, game] of played.entries()) {
      await expect(page.getByTestId('play-feed-card').nth(n)).toContainText(game.title);
      await expect(thumbs.nth(n)).toHaveAttribute('src', /^blob:/);
      await expect(page.locator(`[data-testid="feed-card"][data-version-id="${game.versionId}"] [data-testid="feed-shot"]`)).toHaveAttribute('src', /^blob:/);
    }
  });
});
