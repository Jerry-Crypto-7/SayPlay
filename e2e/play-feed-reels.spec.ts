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
  readonly mode: 'preview' | 'still' | 'play' | 'result';
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

/** Výhra „rukou“ jako v `p36-dare.spec.ts`: lidský běh, jen takový posílá výzvu. */
async function winByHand(page: Page): Promise<void> {
  const end = await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return (window.__playShell as unknown as { handPlay: (until: 'end') => { runState: string } }).handPlay('end');
  });
  expect(end.runState).toBe('won');
}

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
        // `clientTop` je celé číslo, rámeček feedu 2,5 px – dosednutá karta je do 1 px.
        return Math.abs(card.getBoundingClientRect().top - reel.getBoundingClientRect().top - reel.clientTop);
      }),
    )
    .toBeLessThan(1);
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

  test('a game detail refused by the rate cap loads after retry-after instead of a dead card', async ({ page }) => {
    // Úzká obrazovka: od 1024 px stahuje detail první hry i `FeaturedGame` a 429 by schytal on.
    await page.setViewportSize({ width: 412, height: 915 });
    let refused = 0;
    await page.route(`**/api/play/games/${rows[0].versionId}`, (route) => {
      if (refused > 0) return route.continue();
      refused += 1;
      return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, contentType: 'application/json', body: '{"error":{"code":"RATE_LIMITED"}}' });
    });
    await page.goto(`/play?g=${rows[0].versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expectPreview(page, rows[0]);
    expect(refused).toBe(1);
  });

  /** Detail bez `preview`, jako u hry publikované před P54A: náhled musí spočítat worker. */
  const withoutPreview = (page: Page) =>
    page.route(`**/api/play/games/${rows[0].versionId}`, async (route) => {
      const response = await route.fetch();
      const { preview: _stored, ...game } = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: game });
    });

  test('desktop: an older game without a stored preview gets one from the worker (test-gap review)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await withoutPreview(page);
    await page.goto(`/play?g=${rows[0].versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expectPreview(page, rows[0]);
  });

  test('desktop: a failed worker leaves the card still, browsable and with its actions (Codex review)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      // Worker, který se nenačte: prohlížeč pošle `error` a odpověď nepřijde.
      class Broken extends EventTarget {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        postMessage(): void {
          setTimeout(() => this.onerror?.(new Event('error')), 0);
        }
        terminate(): void {}
      }
      Object.defineProperty(window, 'Worker', { configurable: true, value: Broken });
    });
    await withoutPreview(page);
    await page.goto(`/play?g=${rows[0].versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expect.poll(async () => (await probe(page)).mode, { timeout: 30_000 }).toBe('still');
    expect((await probe(page)).tick).toBe(0);
    await expect(page.getByTestId('feed-remix')).toBeVisible();
    await expect(page.getByTestId('feed-report')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await probe(page)).versionId).toBe(rows[1].versionId);
  });

  test('desktop: Tab moves through the card in preview without taking the game over (Codex review)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/play?g=${rows[0].versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expectPreview(page, rows[0]);
    for (let press = 0; press < 4; press += 1) await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect((await probe(page)).mode).toBe('preview');
    await expect(page.getByTestId('feed-remix')).toBeVisible();
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

    test('a swipe on the scene moves the feed in preview and belongs to the game in play (T9)', async ({ page, context }) => {
      await page.goto(`/play?g=${rows[1].versionId}`);
      await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
      await expectPreview(page, rows[1]);
      const cdp = await context.newCDPSession(page);
      const stageBox = async () => {
        const box = await page.getByTestId('feed-current').getByTestId('arcade-stage').boundingBox();
        if (box === null) throw new Error('stage has no box');
        return box;
      };
      /**
       * Skutečný dotykový tah (CDP), ne myš – posun feedu dělá prohlížeč sám. Prst
       * před puštěním chvíli stojí: `touchEnd` hned po posledním `touchMove` nechá
       * Chromium přes CDP stát na půl cesty bez dosednutí i na holé stránce se snapem
       * bez jediného skriptu (změřeno 19. 10.: 373/535 px ze 700, se 200 ms 704).
       */
      const swipe = async (from: number, to: number) => {
        const box = await stageBox();
        const x = box.x + box.width / 3;
        const at = (share: number) => [{ x, y: box.y + box.height * share }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
        for (let step = 1; step <= 8; step += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from + ((to - from) * step) / 8) });
        await page.waitForTimeout(200);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const tapStage = async () => {
        const box = await stageBox();
        await page.touchscreen.tap(box.x + box.width / 3, box.y + box.height / 2);
        await expect.poll(async () => (await probe(page)).mode).toBe('play');
      };
      const scrollTop = () => page.getByTestId('feed-reel').evaluate((reel) => reel.scrollTop);

      // Náhled: tah nahoru po scéně posune feed na další hru a hru nepřevezme.
      await swipe(0.75, 0.2);
      await expectPreview(page, rows[2]);

      // Z hraní ven vede tlačítko „Next“ na okraji karty (flap bez vstupu běží přes 15 s).
      await tapStage();
      await page.getByTestId('feed-next').tap();
      await expectPreview(page, rows[3]);

      // Hraní: tah po scéně patří hře – feed stojí a adresa se nemění. Hra na tah
      // reagovat smí, třeba i koncem běhu; zpátky do náhledu ale nesmí.
      await tapStage();
      const top = await scrollTop();
      await swipe(0.75, 0.2);
      await page.waitForTimeout(600);
      expect(await scrollTop()).toBe(top);
      expect(new URL(page.url()).searchParams.get('g')).toBe(rows[3].versionId);
      expect(['play', 'result']).toContain((await probe(page)).mode);
    });
  });

  test('desktop: Remix on the card sends the sentence and the new game comes right after it (T10)', async ({ page, request }) => {
    test.setTimeout(90_000);
    // Hotový remix je skutečná publikovaná hra; dveře remixu odpoví jako u čipu (201 s odkazem).
    const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/runner.json'), 'utf8')) as Record<string, unknown>;
    const made = await request.post('/api/play/games', { data: { spec: { ...base, title: 'Reels runner through the canyon, harder' } } });
    expect(made.status(), await made.text()).toBeLessThan(300);
    const remix = ((await made.json()) as { versionId: string }).versionId;
    const sent: string[] = [];
    await page.route(`**/api/play/games/${rows[0].versionId}/remix`, (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      sent.push((route.request().postDataJSON() as { sentence: string }).sentence);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ url: `/play/${remix}` }) });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/play?g=${rows[0].versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expectPreview(page, rows[0]);

    await expect(page.getByTestId('feed-actions')).toBeVisible();
    await page.getByTestId('feed-remix').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await sheet.getByTestId('remix-input').fill('Make it harder');
    await sheet.getByTestId('remix-submit').click();

    await expectPreview(page, { ...rows[0], versionId: remix });
    expect(sent).toEqual(['Make it harder']);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-testid="feed-card"][data-active="true"]')).toHaveAttribute('data-index', '1');
    await expect(page.locator(`[data-testid="feed-card"][data-version-id="${rows[1].versionId}"]`)).toHaveAttribute('data-index', '2');
    expect(new URL(page.url()).searchParams.get('g')).toBe(remix);
    // Přechod na remix je skok: zpět v prohlížeči vrátí původní hru.
    await page.goBack();
    await expectPreview(page, rows[0]);
  });

  test('desktop: Report on the card asks once, thanks the player and moves to the next card (T11)', async ({ page }) => {
    // První hlas dveře odmítnou (úložiště nedostupné): karta zůstane a list řekne proč; druhý jde skutečnými dveřmi.
    const sent: number[] = [];
    await page.route(`**/api/play/games/${rows[0].versionId}/report`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      if (sent.push(Date.now()) === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"STORE_UNAVAILABLE"}}' });
      const real = await route.fetch();
      expect(real.status()).toBe(204);
      return route.fulfill({ response: real });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/play?g=${rows[0].versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expectPreview(page, rows[0]);

    await page.getByTestId('feed-report').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    expect(sent).toHaveLength(0);
    await sheet.getByTestId('feed-report-send').click();
    await expect(sheet.getByRole('alert')).toHaveText("The report didn't go through. Try again.");
    await expect(page.locator('[data-testid="feed-card"][data-active="true"]')).toHaveAttribute('data-index', '0');

    await sheet.getByTestId('feed-report-send').click();
    await expect(page.getByTestId('feed-reported')).toHaveText("Thanks. We'll take a look.");
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectPreview(page, rows[1]);
    expect(sent).toHaveLength(2);
  });

  test('desktop: Report on the last card goes back to the previous one and the reported game leaves the feed (T11)', async ({ page }) => {
    const last = rows[rows.length - 1]!;
    await page.route(`**/api/play/games/${last.versionId}/report`, (route) => route.fulfill({ status: 204 }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/play?g=${last.versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expectPreview(page, last);

    await page.getByTestId('feed-report').click();
    await page.getByRole('dialog').getByTestId('feed-report-send').click();
    await expect(page.getByTestId('feed-reported')).toBeVisible();
    await expectPreview(page, rows[rows.length - 2]!);
    await expect(page.locator('.play-pager-count')).toHaveText(`${String(rows.length - 1)}/${String(rows.length - 1)}`);
    await expect(page.locator(`[data-testid="feed-card"][data-version-id="${last.versionId}"]`)).toHaveCount(0);
  });

  test.describe('dare', () => {
    // Vlastní volající: strop výzev je 1 za 10 s a `p36-dare.spec.ts` jde nad týmž serverem.
    test.use({ extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.54' } });

    test('desktop: Play to dare hands the game over and a win shares a ?dare= link (T10)', async ({ page }) => {
      test.setTimeout(90_000);
      await page.addInitScript(() => {
        const shared: ShareData[] = [];
        Object.assign(window, { __shared: shared });
        Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => void shared.push(data) });
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/play?g=${rows[0].versionId}`);
      await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
      await expectPreview(page, rows[0]);

      await page.getByTestId('feed-dare').click();
      await expect.poll(async () => (await probe(page)).mode).toBe('play');
      // Akce karty patří náhledu; při hraní překáží ovládání, výsledek má vlastní.
      await expect(page.getByTestId('feed-actions')).toBeHidden();

      const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${rows[0].versionId}/dare`) && response.request().method() === 'POST');
      await winByHand(page);
      const dare = (await (await posted).json()) as { dareId: string };
      const postrun = page.getByTestId('play-postrun');
      await expect(postrun).toBeVisible();
      await postrun.getByTestId('play-share').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared.length)).toBe(1);
      const shared = await page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared[0]!);
      expect(shared.url).toMatch(new RegExp(`/play/${rows[0].versionId}\\?via=share&dare=${dare.dareId}$`));
    });
  });

  test('desktop: Esc and ↓ leave a game for the next card, the result offers Next game and falls back to preview (T9)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/play?g=${rows[0].versionId}`);
    await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
    await expectPreview(page, rows[0]);

    // Esc při hraní: další karta, ne pauza hry.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await probe(page)).mode).toBe('play');
    await page.keyboard.press('Escape');
    await expectPreview(page, rows[1]);
    await expect(page.getByTestId('play-paused')).toHaveCount(0);

    // ↓ při hraní, když ji hra nevzala: další karta.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await probe(page)).mode).toBe('play');
    await page.keyboard.press('ArrowDown');
    await expectPreview(page, rows[2]);

    // Konec běhu (runner bez vstupu prohraje): PostRun nabídne „Next game“.
    await page.keyboard.press('ArrowUp');
    await expectPreview(page, rows[1]);
    await page.keyboard.press('ArrowUp');
    await expectPreview(page, rows[0]);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await probe(page)).mode, { timeout: 30_000 }).toBe('result');
    await expectSnapped(page);
    await page.getByTestId('play-next-game').click();
    await expectPreview(page, rows[1]);

    // Výsledek bez vstupu: po 10 s karta zpět v náhledu robota.
    await page.keyboard.press('ArrowUp');
    await expectPreview(page, rows[0]);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await probe(page)).mode, { timeout: 30_000 }).toBe('result');
    const resultAt = Date.now();
    await expect.poll(async () => (await probe(page)).mode, { timeout: 20_000 }).toBe('preview');
    expect(Date.now() - resultAt).toBeGreaterThanOrEqual(9_000);
    expect((await probe(page)).versionId).toBe(rows[0].versionId);
  });

  // Na 1024×768 je plocha jen ~320 px vysoká – sloupec akcí uvnitř karty tam useknul Report a „↓“.
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    test(`desktop ${String(size.width)}×${String(size.height)}: a 16:9 stage, actions beside it, three up next and no tab bar (T12)`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(`/play?g=${rows[0].versionId}`);
      await expectPreview(page, rows[0]);

      const stage = await page.locator('[data-testid="feed-current"] > .play-shell').boundingBox();
      if (stage === null) throw new Error('stage has no box');
      expect(Math.abs(stage.width / stage.height / (16 / 9) - 1)).toBeLessThanOrEqual(0.01);

      const actions = await page.getByTestId('feed-actions').boundingBox();
      expect(actions?.x ?? 0).toBeGreaterThanOrEqual(stage.x + stage.width);
      for (const id of ['feed-prev', 'feed-next']) await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
      for (const button of await page.getByTestId('feed-actions').getByRole('button').all()) await expect(button).toBeInViewport({ ratio: 1 });

      await expect(page.getByTestId('play-feed-card')).toHaveCount(3);
      await expect(page.locator('.play-tabbar')).toBeHidden();
    });
  }

  test.describe('reduced motion and keyboard (T13)', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    test('desktop: no bot preview, tick 0 until Enter, focus follows the card and Tab reaches the actions', async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/play?g=${rows[0].versionId}`);
      await expect.poll(async () => (await probe(page)).mode, { timeout: 30_000 }).toBe('still');
      await expect(page.getByTestId('feed-hint')).toBeVisible();
      await expect(page.getByTestId('feed-actions')).toBeVisible();

      // ↓ = další karta bez animace, fokus na ní; robot nehraje, hodiny stojí.
      await page.keyboard.press('ArrowDown');
      await expect.poll(async () => (await probe(page)).versionId).toBe(rows[1].versionId);
      await expect(page.locator('[data-testid="feed-card"][data-active="true"]')).toBeFocused();
      await expect(page.locator('[data-testid="feed-card"][data-active="true"]')).toHaveAttribute('aria-label', rows[1].title);
      await expect.poll(async () => (await probe(page)).mode, { timeout: 30_000 }).toBe('still');
      for (let check = 0; check < 4; check += 1) {
        await page.waitForTimeout(500);
        expect(await probe(page)).toMatchObject({ mode: 'still', tick: 0 });
      }

      // Tab projde akce v pořadí; Enter na Remixu otevře list a hru nepřevezme.
      const labels: string[] = [];
      for (let step = 0; step < 12 && !labels.includes('Report this game'); step += 1) {
        await page.keyboard.press('Tab');
        // Jen sloupec akcí – karta před ním má vlastní tlačítka HUD (i „Share“).
        labels.push(await page.evaluate(() => (document.activeElement?.closest('[data-testid="feed-actions"]') ? (document.activeElement.getAttribute('aria-label') ?? '') : '')));
      }
      expect(labels.filter((label) => label !== '')).toEqual(['Remix this game', 'Play to dare a friend', 'Share', 'Report this game']);
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByRole('button', { name: 'Remix this game' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await probe(page)).toMatchObject({ mode: 'still', tick: 0 });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // Enter na kartě = hrát: první vstup padne do tiku 0 hráčova běhu.
      await page.locator('[data-testid="feed-card"][data-active="true"]').focus();
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await probe(page)).mode).toBe('play');
      await expect.poll(async () => (await probe(page)).tick).toBeGreaterThan(0);
      await expect(page.getByTestId('feed-hint')).toBeHidden();
    });
  });
});
