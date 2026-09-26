import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Klip běhu (P29D T1): po konci arkádové hry nabídne PostRun „Save clip“ a
 * klip je opravdové video – nenulová velikost, typ videa, délka do 16 s
 * včetně konce hry. Prohlížeč bez `captureStream` tlačítko nevidí.
 *
 * Prázdný klip vypadá jako klip, proto se video načte do `<video>` a čte se
 * z jeho metadat, ne z existence tlačítka.
 */

const SENTENCE = 'jumping arcade game with a lot of obstacles';

async function publish(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function playToEnd(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 20, undefined, { timeout: 60_000 });
  // Plátno nahrává od startu běhu; chvíli ho nechat běžet, ať klip má co ukázat.
  await page.waitForTimeout(1_500);
  const outcome = await page.evaluate(() => window.__playShell!.playWitness());
  expect(outcome.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
}

test.describe('/play/[id] – clip of the run', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request);
  });

  test('after the run, Save clip holds a real video of at most 16 s', async ({ page }) => {
    await page.goto(url);
    await playToEnd(page);
    const save = page.getByTestId('play-save-clip');
    await expect(save).toBeVisible({ timeout: 10_000 });
    expect(await save.getAttribute('download')).toMatch(/\.(mp4|webm)$/);

    const video = await save.evaluate(async (anchor: HTMLAnchorElement) => {
      const blob = await (await fetch(anchor.href)).blob();
      const element = document.createElement('video');
      element.muted = true;
      element.src = anchor.href;
      await new Promise<void>((resolve, reject) => {
        element.onloadedmetadata = () => resolve();
        element.onerror = () => reject(new Error('the clip does not load as video'));
      });
      // WebM z MediaRecorder délku v hlavičce nenese: přetočení na konec ji dopočte.
      if (!Number.isFinite(element.duration)) {
        await new Promise<void>((resolve) => {
          element.ondurationchange = () => {
            if (Number.isFinite(element.duration)) resolve();
          };
          element.currentTime = 1e9;
        });
      }
      return { size: blob.size, type: blob.type, duration: element.duration, width: element.videoWidth };
    });
    expect(video.size).toBeGreaterThan(0);
    expect(video.type).toMatch(/^video\/(mp4|webm)/);
    expect(video.width).toBeGreaterThan(0);
    // Běh + dojezd 1,5 s po konci: klip nesmí být jen první snímek.
    expect(video.duration).toBeGreaterThan(1);
    expect(video.duration).toBeLessThanOrEqual(16);
  });

  test('a browser without canvas capture shows no Save clip', async ({ page }) => {
    await page.addInitScript(() => {
      // @ts-expect-error – prohlížeč bez nahrávání plátna
      delete HTMLCanvasElement.prototype.captureStream;
    });
    await page.goto(url);
    await playToEnd(page);
    await page.waitForTimeout(2_500);
    await expect(page.getByTestId('play-save-clip')).toHaveCount(0);
    await expect(page.getByTestId('play-share')).toBeVisible();
  });
});
