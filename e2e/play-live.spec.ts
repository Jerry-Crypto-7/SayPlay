import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { openAbout, startGame } from './play-start';

/**
 * P29D T9: věta uprostřed běžící hry. „more enemies“ přidá hrozby do běžícího
 * světa bez nové adresy, „make it rain“ rozprší plátno, „add a dragon“ živě
 * nejde a spustí dnešní remix. Hra během psaní běží dál a klávesy psané do
 * pole si nevezme (pravidlo P28B F-07).
 *
 * Server v e2e model nemá, proto se remix s větou podvrhne přes `page.route`
 * – jako v `play-remix-sentence.spec.ts`; `ready` vrací doopravdy publikované dítě.
 */

const SENTENCE = 'jumping arcade game with a lot of obstacles';
const JOB = 'b'.repeat(32);
const HOSTILE = ['enemy', 'chaser', 'hazard', 'obstacle'] as const;

type LiveProbe = { bodies(role: string): number; patches(): number; tick(): number };

async function publish(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

function hostiles(page: Page): Promise<number> {
  return page.evaluate((roles) => {
    const probe = window.__playShell as unknown as LiveProbe;
    return roles.reduce((sum, role) => sum + probe.bodies(role), 0);
  }, HOSTILE);
}

function patches(page: Page): Promise<number> {
  return page.evaluate(() => (window.__playShell as unknown as LiveProbe).patches());
}

function tick(page: Page): Promise<number> {
  return page.evaluate(() => window.__playShell!.tick());
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'runner');
  // Živá změna padne do příštího tiku – hra musí běžet (od P33 T11 čeká na první dotek).
  await startGame(page);
  await expect(page.getByTestId('live-open')).toBeVisible({ timeout: 30_000 });
}

async function change(page: Page, sentence: string): Promise<void> {
  await page.getByTestId('live-open').click();
  const input = page.getByTestId('live-input');
  await expect(input).toBeFocused();
  await input.fill(sentence);
  await page.getByTestId('live-submit').click();
}

test.describe('/play/[id] – live change', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request);
  });

  test('"more enemies" adds threats to the running game within a second, same URL', async ({ page }) => {
    await open(page, url);
    const before = await hostiles(page);
    const address = page.url();
    await change(page, 'more enemies');
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-kind', 'live');
    expect(await patches(page)).toBe(1);
    await expect.poll(() => hostiles(page), { timeout: 1_000, intervals: [50] }).toBeGreaterThan(before);
    expect(page.url()).toBe(address);
  });

  test('"make it rain" puts rain over the stage', async ({ page }) => {
    await open(page, url);
    await expect(page.getByTestId('play-weather')).toHaveCount(0);
    await change(page, 'make it rain');
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-kind', 'live');
    await expect(page.getByTestId('play-weather')).toHaveAttribute('data-weather', 'rain', { timeout: 1_000 });
  });

  test('a sentence the game can carry only in part says so and closes, instead of claiming a refusal', async ({ page }) => {
    await open(page, url);
    // Běžec nemá životy: déšť projde, život ne.
    await change(page, 'make it rain and extra life');
    const status = page.getByTestId('live-status');
    await expect(status).toHaveAttribute('data-kind', 'live');
    await expect(status).toContainText('Done in part. This game has no lives.');
    await expect(page.getByTestId('live-box')).toHaveCount(0);
    await expect(page.getByTestId('play-weather')).toHaveAttribute('data-weather', 'rain');
    expect(await patches(page)).toBe(1);
  });

  test('Enter opens the box, typing keeps every character and the game keeps running', async ({ page }) => {
    await open(page, url);
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press('Enter');
    const input = page.getByTestId('live-input');
    await expect(input).toBeFocused();
    // Mikrofon z T6 (`MicButton`) sedí i v poli živé změny.
    await expect(page.getByTestId('live-mic')).toBeVisible();
    const start = await tick(page);
    // Skutečné stisky kláves: mezera a w/a/s/d jsou klávesy běžce.
    await input.pressSequentially('add a wall and speed');
    await expect(input).toHaveValue('add a wall and speed');
    expect(await tick(page)).toBeGreaterThan(start);
    await input.press('Escape');
    await expect(page.getByTestId('live-box')).toHaveCount(0);
  });

  test('sharing after live changes opens a version with rain and more threats from the start (T10)', async ({ browser }) => {
    const context = await browser.newContext();
    // Nabídka sdílení se v e2e obsluhovat nedá – zachytí se, co by dostala (jako `play-share.spec.ts`).
    // Jako iOS Safari (R4): sdílení bez čerstvého gesta odmítne. Gesto platí jen do konce obsluhy kliku –
    // volání po čekání na síť přijde až po něm.
    await context.addInitScript(() => {
      const shared: ShareData[] = [];
      let gesture = false;
      window.addEventListener('click', () => {
        gesture = true;
        setTimeout(() => (gesture = false), 0);
      }, true);
      (window as unknown as { __shared: ShareData[] }).__shared = shared;
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => {
          if (!gesture) throw new DOMException('share needs a fresh gesture', 'NotAllowedError');
          shared.push(data);
        },
      });
    });
    const page = await context.newPage();
    await open(page, url);
    const startHostiles = await hostiles(page);
    await change(page, 'more enemies');
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-kind', 'live');
    await change(page, 'make it rain');
    await expect(page.getByTestId('play-weather')).toHaveAttribute('data-weather', 'rain');
    // Během publikace je Share zablokované – dvojí ťuk nepublikuje dvakrát.
    const share = page.getByTestId('play-share').first();
    await expect(share).toBeDisabled();
    await expect(share).toBeEnabled({ timeout: 15_000 });
    // Od P34 T7 otevře kolo list sdílení; nabídku prohlížeče volá jeho „Dare a friend“ – čerstvé gesto je ten druhý ťuk.
    await share.click();
    await page.getByTestId('play-share-dare').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared.length), { timeout: 15_000 }).toBe(1);
    const link = await page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared[0].url!);
    const parentId = url.split('/').at(-1)!;
    expect(link).toMatch(/\/play\/[0-9a-f]+\?via=share$/);
    expect(link).not.toContain(parentId);

    const friend = await browser.newPage();
    await friend.goto(link);
    await friend.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    await expect(friend.getByTestId('play-weather')).toHaveAttribute('data-weather', 'rain');
    expect(await hostiles(friend)).toBeGreaterThan(startHostiles);
    // Od P34 T5 se list „About this game“ otevírá z karty pauzy (HUD kitu).
    await openAbout(friend);
    await expect(friend.getByTestId('play-lineage').locator(`a[href="/play/${parentId}"]`)).toBeVisible();
    await friend.close();
    await context.close();
  });

  test('"add a dragon" cannot happen live and starts a remix instead', async ({ page, request }) => {
    const parentId = url.split('/').at(-1)!;
    const original = ((await (await request.get(`/api/play/games/${parentId}`)).json()) as { spec: Record<string, unknown> & { title: string } }).spec;
    const made = await request.post(`/api/play/games/${parentId}/remix`, { data: { spec: { ...original, title: `${original.title} with a dragon` } } });
    expect(made.status(), await made.text()).toBeLessThan(300);
    const childId = ((await made.json()) as { url: string }).url.split('/').at(-1)!;

    let sent: unknown = null;
    await page.route(`**/api/play/games/${parentId}/remix**`, async (route) => {
      const call = route.request();
      if (call.method() === 'POST') {
        sent = call.postDataJSON();
        return route.fulfill({ status: 202, json: { status: 'pending', job: JOB, deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
      }
      return route.fulfill({ json: { status: 'ready', versionId: childId, changed: ['A dragon joins'] } });
    });

    await open(page, url);
    await change(page, 'add a dragon');
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-kind', 'remix');
    expect(sent).toEqual({ sentence: 'add a dragon' });
    expect(await patches(page)).toBe(0);
    // Běžec bez vstupu může prohrát dřív, než práce doběhne: hotovou verzi pak
    // ukáže box po hře místo čipu (P28B T7). Obojí je táž práce z `useRemixJob`.
    // Od P33 T4 leží box po hře v listu za tlačítkem výsledku; od P34 T6 se jmenuje „Remix it“ (slovník kitu).
    const chip = page.getByTestId('remix-ready-open');
    await expect(chip.or(page.getByTestId('play-outcome'))).toBeVisible({ timeout: 15_000 });
    if (await chip.isVisible()) await expect(chip).toHaveAttribute('href', `/play/${childId}`);
    else {
      await page.getByRole('button', { name: 'Remix it' }).click();
      await expect(page.getByTestId('remix-changed')).toContainText('A dragon joins', { timeout: 15_000 });
    }
  });
});
