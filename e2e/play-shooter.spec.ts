import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Střelba a hod na `/play/[id]` (P25G T6): věta projde skutečnými dveřmi
 * (návrh ze slov → `shooter` / `throw`), hra se načte v arkádovém plátně,
 * vstup se zapíše do záznamu (klik = výstřel, držení a puštění = hod),
 * záznam robota přehraný sondou skončí na „You won“ a mobil nescrolluje
 * do strany.
 */

const GAMES = [
  { control: 'shooter', sentence: 'zombie shooter in a mall' },
  { control: 'throw', sentence: 'throw a basketball into a hoop from crazy angles' },
] as const;

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test.describe('/play/[id] – shots are drawn (P28B T2)', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request, GAMES[0].sentence);
  });

  test('a shot the kernel spawns mid-run shows up in the scene', async ({ page }) => {
    await page.goto(url);
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'shooter');
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playRender !== undefined, undefined, { timeout: 60_000 });
    await expect(stage).toHaveAttribute('data-shots-drawn', /\d+/, { timeout: 60_000 });
    const box = (await stage.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // První klik hru jen pustí; střela ze druhého už musí být vidět.
    await page.mouse.click(x, y);
    await page.waitForFunction(() => window.__playShell!.tick() > 90, undefined, { timeout: 10_000 });
    const drawn = async (): Promise<number> => Number(await stage.getAttribute('data-shots-drawn'));
    const before = await drawn();
    const calls = await page.evaluate(() => window.__playRender!().calls);
    await page.mouse.click(x, y);
    await expect.poll(drawn, { intervals: [16], timeout: 2_000 }).toBeGreaterThan(before);
    const after = await page.evaluate(() => window.__playRender!().calls);
    expect(after).toBeGreaterThan(calls);
    // Strop plánu P28B: kreslení všech živých těl přidá nejvýš 20 draw callů.
    expect(after - calls).toBeLessThanOrEqual(20);
  });
});

for (const game of GAMES) {
  test.describe(`/play/[id] – arcade ${game.control}`, () => {
    let url = '';

    test.beforeAll(async ({ request }) => {
      url = await publish(request, game.sentence);
    });

    test('the scene loads and a click or a hold-and-release is recorded as a shot', async ({ page }) => {
      await page.goto(url);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toBeVisible();
      await expect(stage).toHaveAttribute('data-control', game.control);
      await expect(page.getByTestId('play-goal')).not.toHaveText('');
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
      const shotsLeft = async (): Promise<number> => Number(/(\d+) (?:shots|throws) left/.exec((await page.getByTestId('play-tick').textContent()) ?? '')?.[1]);
      const before = await shotsLeft();
      expect(before).toBeGreaterThan(0);

      const box = (await stage.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (game.control === 'shooter') {
        // Střelnice čeká na první stisk; klik doprostřed = zamíří a vystřelí.
        expect(await page.evaluate(() => window.__playShell!.tick())).toBe(0);
        await page.mouse.click(x, y);
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + 30, { steps: 5 });
        await page.waitForTimeout(400);
        await page.mouse.up();
      }
      await expect.poll(shotsLeft, { timeout: 10_000 }).toBe(before - 1);
      const inputs = (await page.evaluate(() => window.__playShell!.inputs())) as unknown as { buttons: number; axis: number }[];
      expect(inputs.some((input) => input.axis !== 0)).toBe(true);
      // TAP = 1: výstřel i puštění hodu jsou ťuk.
      expect(inputs.some((input) => (input.buttons & 1) !== 0)).toBe(true);
    });

    test('the verifier bot replayed by the probe wins and the outcome says so', async ({ page }) => {
      await page.goto(url);
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      const outcome = await page.evaluate(() => window.__playShell!.playWitness());
      expect(outcome.runState).toBe('won');
      await expect(page.getByTestId('play-outcome')).toContainText('You won');
      await expect(page.getByTestId('play-progress')).toHaveAttribute('data-progress', '100');
    });

    test('a phone viewport has no horizontal scroll', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url);
      await expect(page.getByTestId('arcade-stage')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}
