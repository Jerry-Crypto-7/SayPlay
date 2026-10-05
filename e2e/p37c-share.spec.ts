import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * Výsledek jako Wordle (P37C T4): „Dare a friend to beat it“ pošle nabídce
 * sdílení text – název hry, mřížku bez spoileru a cíl k překonání – a odkaz
 * výzvy zvlášť. Bez nabídky jde týž text i s odkazem do schránky. Headless
 * nemá ani nabídku, ani schránku, takže se obě zachytí (vzor `p36-dare`).
 */

interface HandProbe {
  readonly handPlay: (until: 'score' | 'end', lag?: number) => { readonly runState: string; readonly tick: number; readonly score: number };
  readonly idleRun: () => { readonly runState: string; readonly tick: number };
}

interface Captured {
  readonly __shared: ShareData[];
  readonly __copied: string[];
}

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** `share: false` = prohlížeč bez nabídky sdílení; schránka se zachytí vždy. */
async function capture(context: BrowserContext, share = true): Promise<void> {
  await context.addInitScript((withShare) => {
    const shared: ShareData[] = [];
    const copied: string[] = [];
    Object.assign(window, { __shared: shared, __copied: copied });
    if (withShare) {
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => void shared.push(data) });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    } else {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => true });
  }, share);
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Robot dohraje „rukou“ a výzva odejde na server; vrací konec běhu a id výzvy. */
async function winWithDare(page: Page, id: string): Promise<{ readonly score: number; readonly dareId: string }> {
  await ready(page);
  const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
  const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).handPlay('end'));
  expect(end.runState).toBe('won');
  const dare = (await (await posted).json()) as { dareId: string };
  await expect(page.getByTestId('play-postrun')).toBeVisible();
  return { score: end.score, dareId: dare.dareId };
}

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího. */
const person = (n: number) => ({ extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(n)}` } });

/** Cíl k překonání: body, nebo čas, když hra neboduje. */
const dareLine = (score: number) => (score > 0 ? `Can you beat ${score.toLocaleString('en-US')}?` : /^Can you beat \d+\.\ds\?$/);

test.describe('/play/[id] – share the result as a spoiler-free grid (P37C T4)', () => {
  test('a win shares the game, the stars and the score to beat; the dare link goes as the url', async ({ browser, request }) => {
    const url = await publish(request, 'Collect five glowing mushrooms then open a portal.');
    const id = url.split('/').at(-1)!;
    const context = await browser.newContext(person(41));
    await capture(context);
    const page = await context.newPage();
    await page.goto(url);
    const { score, dareId } = await winWithDare(page, id);

    await page.getByTestId('play-share').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Captured).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as unknown as Captured).__shared[0]!);
    expect(shared.url).toMatch(new RegExp(`/play/${id}\\?via=share&dare=${dareId}$`));
    const lines = shared.text!.split('\n');
    const title = (await page.title()).replace(/ – sayplay$/, '');
    expect(lines[0]).toBe(`${title} – sayplay`);
    expect(lines[1]).toMatch(/^⭐*☆*( |$)/);
    expect(lines[1]!.match(/[⭐☆]/gu)).toHaveLength(3);
    expect(lines[2]).toMatch(/^⏱️ \d+\.\ds$/);
    expect(lines[3]).toMatch(dareLine(score));
    // Odkaz jde zvlášť: v textu by ho nabídka zopakovala.
    expect(lines).toHaveLength(4);
    expect(shared.text!.length).toBeLessThanOrEqual(280);
    await context.close();
  });

  test('without a share sheet the same text and the dare link go to the clipboard', async ({ browser, request }) => {
    const url = await publish(request, 'Collect five glowing mushrooms then open a portal.');
    const id = url.split('/').at(-1)!;
    const context = await browser.newContext(person(42));
    await capture(context, false);
    const page = await context.newPage();
    await page.goto(url);
    const { score, dareId } = await winWithDare(page, id);

    await page.getByTestId('play-share').click();
    await expect(page.getByText('Link copied. Go dare someone.')).toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as Captured).__copied);
    expect(copied).toHaveLength(1);
    const lines = copied[0]!.split('\n');
    expect(lines[3]).toMatch(dareLine(score));
    expect(lines[4]).toMatch(new RegExp(`/play/${id}\\?via=share&dare=${dareId}$`));
    expect(copied[0]!.length).toBeLessThanOrEqual(280);

    // „Copy link“ zůstává jen odkaz.
    await page.getByTestId('play-copy-link').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Captured).__copied.length)).toBe(2);
    expect((await page.evaluate(() => (window as unknown as Captured).__copied))[1]).toMatch(new RegExp(`/play/${id}\\?via=share$`));
    await context.close();
  });

  test('a loss shares no stars and no number to beat', async ({ browser, request }) => {
    const url = await publish(request, 'Carry a fragile cake across a kitchen to a party table.');
    const context = await browser.newContext(person(43));
    await capture(context);
    const page = await context.newPage();
    await page.goto(url);
    await ready(page);
    const lost = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
    expect(lost.runState).toBe('lost');
    await expect(page.getByTestId('play-outcome')).toHaveAttribute('data-outcome', 'lost');

    await page.getByTestId('play-share').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Captured).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as unknown as Captured).__shared[0]!);
    expect(shared.url).toMatch(/\?via=share$/);
    expect(shared.text).not.toMatch(/[⭐☆]/u);
    expect(shared.text!.split('\n')[3]).toBe('So close. Can you beat it?');
    await context.close();
  });
});
