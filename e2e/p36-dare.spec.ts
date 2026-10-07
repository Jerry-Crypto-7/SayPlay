import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * Dare (P36B T6): výhra pošle vstupy běhu na server, ten je přehraje a
 * „Dare a friend to beat it“ sdílí odkaz s id výzvy (`?dare=`). Skóre výzvy
 * spočítal server – test ho srovná s během, který hráč opravdu dohrál.
 * Když server výzvu nevezme, odejde obyčejný odkaz a hráč se to dozví.
 */

interface HandProbe {
  readonly handPlay: (until: 'score' | 'end', lag?: number) => { readonly runState: string; readonly tick: number; readonly score: number };
  readonly idleRun: () => { readonly runState: string; readonly tick: number };
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
    // Nabídka bere i klip běhu: bez toho by běh, který klip stihl nahrát, šel přes schránku (headless ji nedá).
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (_url: string, body: Blob) => {
        void body.text().then((text) => beacons.push(text));
        return true;
      },
    });
  });
}

/** Robot dohraje „rukou“: lidský běh, jen takový posílá výzvu (`playWitness` ne). `lag` = stisky o tolik tiků později, pomalejší výhra. */
async function winByHand(page: Page, lag = 0): Promise<{ readonly tick: number; readonly score: number }> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const end = await page.evaluate((late) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return (window.__playShell as unknown as HandProbe).handPlay('end', late);
  }, lag);
  expect(end.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
  return end;
}

/**
 * Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího (T5r3)
 * a bez hlavičky je každý požadavek na localhostu týž volající.
 */
const person = (n: number) => ({ extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(n)}` } });

test.describe('/play/[id] – send a dare (P36B T6)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request, 'Collect five glowing mushrooms then open a portal.');
    id = url.split('/').at(-1)!;
  });

  test('a won run shares a link carrying the score the server replayed', async ({ browser, request }) => {
    const context = await browser.newContext(person(1));
    await capture(context);
    const page = await context.newPage();
    await page.goto(url);
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
    const end = await winByHand(page);
    const response = await posted;
    // 201 nová výzva; 200, když tentýž robotí běh už výzvou je (druhý průchod sadou nad týmž serverem).
    expect([200, 201]).toContain(response.status());
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
    const again = await request.post(`/api/play/games/${id}/dare`, { data: JSON.parse(response.request().postData()!) as unknown, headers: person(2).extraHTTPHeaders });
    expect(again.status()).toBe(200);
    // Cizí kopie běhu žebříčkem nepohne (P44B T5: běh patří prvnímu zapisovateli) a `against` nepřišlo.
    expect(await again.json()).toEqual({ dareId: dare.dareId, score: end.score, ticks: end.tick, board: null, beat: null });
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

/**
 * Hra proti výzvě (P36B T7): dva kontexty prohlížeče, jako dva lidé. A vyhraje
 * pomaleji (robot o sekundu později) a výzva odejde na server; B otevře odkaz,
 * vidí cíl na kartě startu i v HUD, prohraje (nic nedělá) a pak vyhraje rychleji.
 * Dort: bez stisku prohraje (tik 324), robot o 60 tiků později pořád vyhraje
 * (1 164 proti 1 104) – houbám bez stisku nic nehrozí, prohrát se nedají.
 */
test.describe('/play/[id]?dare= – play against a friend (P36B T7)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request, 'Carry a fragile cake across a kitchen to a party table.');
    id = url.split('/').at(-1)!;
  });

  test('B sees the friend’s target, loses → So close., wins faster → You beat it! and Dare back', async ({ browser }) => {
    const a = await browser.newContext(person(3));
    await capture(a);
    const pageA = await a.newPage();
    await pageA.goto(url);
    const posted = pageA.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
    const endA = await winByHand(pageA, 60);
    const dareA = (await (await posted).json()) as { dareId: string; score: number; ticks: number };
    expect(dareA.ticks).toBe(endA.tick);
    await a.close();

    const b = await browser.newContext(person(4));
    await capture(b);
    const pageB = await b.newPage();
    await pageB.goto(`${url}?via=share&dare=${dareA.dareId}`);
    const clock = `${(dareA.ticks / 60).toFixed(1)}s`;
    await expect(pageB.getByTestId('play-dare-goal')).toHaveText(dareA.score > 0 ? `Beat ${dareA.score.toLocaleString('en-US')} in ${clock}` : `Beat ${clock}`);
    await expect(pageB.getByTestId('hud-counter-dare')).toContainText('Beat');

    await pageB.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    const lost = await pageB.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
    expect(lost.runState).toBe('lost');
    await expect(pageB.getByTestId('play-postrun')).toContainText('So close.');
    await expect(pageB.getByTestId('play-dare-result')).toHaveAttribute('data-beat', 'false');

    const endB = await winByHand(pageB);
    expect(endB.tick).toBeLessThan(endA.tick);
    await expect(pageB.getByTestId('play-postrun')).toContainText('You beat it!');
    await expect(pageB.getByTestId('play-dare-result')).toHaveAttribute('data-beat', 'true');
    await expect(pageB.getByTestId('play-postrun').getByRole('button', { name: 'Dare back' })).toBeVisible();
    await b.close();
  });

  test('an unknown dare opens the plain game without an error', async ({ page }) => {
    await page.goto(`${url}?via=share&dare=${'0'.repeat(32)}`);
    await expect(page.getByTestId('play-first-prompt')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('play-dare-goal')).toHaveCount(0);
    await expect(page.getByTestId('hud-counter-dare')).toHaveCount(0);
  });
});
