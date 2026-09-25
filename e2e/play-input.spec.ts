import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Vstup her (P28B): klávesy hry nesmí spolknout psaní. Běžec poslouchá
 * mezerník, A/D/S/W a šipky na `window`; bez kontroly cíle by si věta
 * v poli remixu ztratila mezery a písmena a, d, s, w.
 */

const SENTENCE = 'jumping arcade game with a lot of obstacles';

async function publish(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test.describe('/play/[id] – game input', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request);
  });

  test('typing a remix after a runner game keeps every character (F-07)', async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'runner');
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    await page.evaluate(() => window.__playShell!.playWitness());
    const input = page.getByTestId('remix-input');
    await expect(input).toBeVisible();
    await input.click();
    // Skutečné stisky kláves, ne `fill` – ten keydown vůbec nepošle.
    await input.pressSequentially('make enemies faster');
    await expect(input).toHaveValue('make enemies faster');
  });
});
