import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * Dare (P36B T6): výhra pošle vstupy běhu na server, ten je přehraje a
 * „Dare a friend to beat it“ sdílí odkaz s id výzvy (`?dare=`). Skóre výzvy
 * spočítal server – test ho srovná s během, který hráč opravdu dohrál.
 * Když server výzvu nevezme, odejde obyčejný odkaz a hráč se to dozví.
 */

interface HandProbe {
  readonly handPlay: (until: 'score' | 'end') => { readonly runState: string; readonly tick: number; readonly score: number };
}

interface Captured {
  readonly __shared: ShareData[];
  readonly __beacons: string[];
}

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Nabídka sdílení a události smyčky se v e2e nedají obsluhovat – zachytí se, co by dostaly. */
async function capture(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const shared: ShareData[] = [];
    const beacons: string[] = [];
    Object.assign(window, { __shared: shared, __beacons: beacons });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => void shared.push(data) });
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (_url: string, body: Blob) => {
        void body.text().then((text) => beacons.push(text));
        return true;
      },
    });
  });
}

/** Robot dohraje „rukou“: lidský běh, jen takový posílá výzvu (`playWitness` ne). */
async function winByHand(page: Page): Promise<{ readonly tick: number; readonly score: number }> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const end = await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return (window.__playShell as unknown as HandProbe).handPlay('end');
  });
  expect(end.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
  return end;
}

test.describe('/play/[id] – send a dare (P36B T6)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request, 'Collect five glowing mushrooms then open a portal.');
    id = url.split('/').at(-1)!;
  });

  test('a won run shares a link carrying the score the server replayed', async ({ browser, request }) => {
    const context = await browser.newContext();
    await capture(context);
    const page = await context.newPage();
    await page.goto(url);
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
    const end = await winByHand(page);
    const response = await posted;
    expect(response.status()).toBe(201);
    const dare = (await response.json()) as { dareId: string; score: number; ticks: number };
    expect({ score: dare.score, ticks: dare.ticks }).toEqual({ score: end.score, ticks: end.tick });

    await page.getByTestId('play-share').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Captured).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as unknown as Captured).__shared[0]!);
    expect(shared.url).toMatch(new RegExp(`/play/${id}\\?via=share&dare=${dare.dareId}$`));
    await expect
      .poll(async () => (await page.evaluate(() => (window as unknown as Captured).__beacons)).map((text) => JSON.parse(text) as { name: string; dare?: boolean }).find((event) => event.name === 'share'))
      .toMatchObject({ name: 'share', dare: true });

    // Server výzvu drží: týž běh podruhé je táž výzva (200), ne nová.
    const again = await request.post(`/api/play/games/${id}/dare`, { data: JSON.parse(response.request().postData()!) as unknown });
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({ dareId: dare.dareId, score: end.score, ticks: end.tick });
    await context.close();
  });

  test('a dare the server refuses still shares the plain link and says so', async ({ browser }) => {
    const context = await browser.newContext();
    await capture(context);
    const page = await context.newPage();
    await page.route(`**/api/play/games/${id}/dare`, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STORE_UNAVAILABLE', message: 'the dare could not be saved right now' } }) }),
    );
    await page.goto(url);
    await winByHand(page);
    await page.getByTestId('play-share').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Captured).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as unknown as Captured).__shared[0]!);
    expect(shared.url).toMatch(new RegExp(`/play/${id}\\?via=share$`));
    await expect(page.getByText("Couldn't attach your score, so the link opens just the game.")).toBeVisible();
    await context.close();
  });
});
