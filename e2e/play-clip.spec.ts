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

  test('a browser without canvas capture shows no Save clip and shares the link alone', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      // @ts-expect-error – prohlížeč bez nahrávání plátna
      delete HTMLCanvasElement.prototype.captureStream;
    });
    await recordBeacons(page);
    await page.goto(url);
    await playToEnd(page);
    await page.waitForTimeout(2_500);
    await expect(page.getByTestId('play-save-clip')).toHaveCount(0);
    await page.getByTestId('play-share').click();
    await expect(page.getByText('Link copied')).toBeVisible();
    expect(await shareEvents(page)).toEqual([{ name: 'share', withClip: false }]);
  });

  test('Share sends the clip with the link where the share sheet takes files (P29D T2)', async ({ page }) => {
    await page.addInitScript(() => {
      const shared: { url?: string; files: { name: string; type: string; size: number }[] }[] = [];
      (window as unknown as { __shared: typeof shared }).__shared = shared;
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: ShareData) => (data.files ?? []).every((file) => file.type.startsWith('video/')) });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => void shared.push({ url: data.url, files: [...(data.files ?? [])].map((file) => ({ name: file.name, type: file.type, size: file.size })) }),
      });
    });
    await recordBeacons(page);
    await page.goto(url);
    await playToEnd(page);
    await expect(page.getByTestId('play-save-clip')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('play-share').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(1);
    const [shared] = await page.evaluate(() => (window as unknown as { __shared: { url: string; files: { name: string; type: string; size: number }[] }[] }).__shared);
    expect(shared!.url).toContain(url);
    expect(shared!.files).toHaveLength(1);
    expect(shared!.files[0]!.type).toMatch(/^video\//);
    expect(shared!.files[0]!.size).toBeGreaterThan(0);
    expect(await shareEvents(page)).toEqual([{ name: 'share', withClip: true }]);
  });

  test('without file sharing, Share downloads the clip and copies the link (P29D T2)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
    await recordBeacons(page);
    await page.goto(url);
    await playToEnd(page);
    await expect(page.getByTestId('play-save-clip')).toBeVisible({ timeout: 10_000 });
    const download = page.waitForEvent('download');
    await page.getByTestId('play-share').click();
    expect((await download).suggestedFilename()).toMatch(/^worldstream-clip\.(mp4|webm)$/);
    await expect(page.getByText('Clip saved, link copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(url);
    expect(await shareEvents(page)).toEqual([{ name: 'share', withClip: true }]);
  });
});

/** Události smyčky odchycené na `sendBeacon` – co by dostaly dveře `/api/play/events`. */
async function recordBeacons(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sent: Record<string, unknown>[] = [];
    (window as unknown as { __beacons: typeof sent }).__beacons = sent;
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (_url: string, data: Blob) => {
        void data.text().then((text) => sent.push(JSON.parse(text) as Record<string, unknown>));
        return true;
      },
    });
  });
}

async function shareEvents(page: Page): Promise<{ name: unknown; withClip: unknown }[]> {
  await page.waitForTimeout(300);
  const sent = await page.evaluate(() => (window as unknown as { __beacons: Record<string, unknown>[] }).__beacons);
  return sent.filter((event) => event.name === 'share').map((event) => ({ name: event.name, withClip: event.withClip }));
}
