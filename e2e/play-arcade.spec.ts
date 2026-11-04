import { expect, test, type APIRequestContext } from '@playwright/test';

import { openPause, startGame } from './play-start';

/**
 * Skákačka na `/play/[id]` (P25A T6): věta „endless runner with a lot of
 * obstacles“ projde skutečnými dveřmi (dvojník režiséra = návrh ze slov →
 * běžec; „jumping …“ dává od žánrů 29. 9. plošinovku, `classify.ts`), hra se načte v arkádovém plátně, HUD běží, mezerník zapíše skok,
 * záznam robota přehraný sondou skončí na „You did it!“ (P34 T6: slovník
 * kitu, dřív „You won“) a mobil nescrolluje do
 * strany.
 */

const SENTENCE = 'endless runner with a lot of obstacles';

async function publish(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test.describe('/play/[id] – arcade runner', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request);
  });

  test('the runner loads, the HUD advances and Space records a jump', async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId('arcade-stage')).toBeVisible();
    await expect(page.getByTestId('play-goal')).not.toHaveText('');
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    const first = Number(await page.getByTestId('play-tick').getAttribute('data-tick'));
    await page.waitForTimeout(500);
    expect(Number(await page.getByTestId('play-tick').getAttribute('data-tick'))).toBeGreaterThan(first);

    const before = await page.evaluate(() => window.__playShell!.inputs().length);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBe(before + 1);
  });

  test('"Show me how" plays the verified run as a labelled demo, then the player plays (P27D T3)', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 10, undefined, { timeout: 60_000 });
    // Od P34 T5 je „Show me how“ na kartě pauzy (HUD kitu); ukázka pauzu sama zruší.
    await openPause(page);
    await page.getByTestId('play-demo-start').click();
    await expect(page.getByTestId('play-demo')).toBeVisible();
    // Ukázka běží v čase před očima, ne naráz.
    const early = await page.evaluate(() => window.__playShell!.tick());
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(early);
    // Stisk hráče během ukázky se do jeho záznamu nezapíše.
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(0);
    await expect(page.getByTestId('play-demo-outcome')).toHaveAttribute('data-verified', 'true', { timeout: 200_000 });
    await expect(page.getByTestId('play-outcome')).toHaveCount(0);
    await page.getByTestId('play-demo-yours').click();
    await expect(page.getByTestId('play-demo-outcome')).toHaveCount(0);
    await openPause(page);
    await expect(page.getByTestId('play-demo-start')).toBeVisible();
    // Esc kartu zavře a hra běží dál; mezerník pak skáče.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('play-paused')).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBeGreaterThan(0);
  });

  test('a hidden tab pauses the game and the first key resumes it (P27B T3)', async ({ page }) => {
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // `play-paused` je od P34 T5 karta pauzy kitu; první klávesa ji zavře a hru pustí.
    await expect(page.getByTestId('play-paused')).toBeVisible();
    const frozen = await page.evaluate(() => window.__playShell!.tick());
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    // Návrat do popředí hru sám nerozběhne.
    expect(await page.evaluate(() => window.__playShell!.tick())).toBe(frozen);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('play-paused')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(frozen);
  });

  test('Space on the focused share button shares and does not jump (P27B T5)', async ({ page }) => {
    await page.addInitScript(() => {
      const shared: unknown[] = [];
      (window as unknown as { __shared: unknown[] }).__shared = shared;
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: unknown) => void shared.push(data) });
    });
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    const before = await page.evaluate(() => window.__playShell!.inputs().length);
    await page.getByTestId('play-share').focus();
    await page.keyboard.press('Space');
    // Od P34 T7 otevře kolo list sdílení; mezerník na jeho „Dare a friend“ sdílí a do hry taky nepropadne.
    await page.getByTestId('play-share-dare').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(1);
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(before);
  });

  test('the first click wakes the sound and M mutes it for the next visit too (P28C T2)', async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__playAudio !== undefined && window.__playShell !== undefined, undefined, { timeout: 60_000 });
    // Bez gesta hráče prohlížeč zvuk nepustí – kontext ještě nevznikl.
    expect(await page.evaluate(() => window.__playAudio!.state())).toBe('none');
    await page.getByTestId('arcade-stage').click();
    await expect.poll(() => page.evaluate(() => window.__playAudio!.state())).toBe('running');
    // Od P34 T5 je Sound na kartě pauzy (HUD kitu); M platí i s otevřenou kartou.
    await openPause(page);
    await expect(page.getByTestId('play-mute')).toHaveText('Sound on');
    await page.keyboard.press('m');
    await expect(page.getByTestId('play-mute')).toHaveText('Sound off');
    expect(await page.evaluate(() => localStorage.getItem('play:sound'))).toBe('muted');
    await page.reload();
    await openPause(page);
    await expect(page.getByTestId('play-mute')).toHaveText('Sound off');
    await page.getByTestId('play-mute').click();
    await expect(page.getByTestId('play-mute')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => localStorage.getItem('play:sound'))).toBe('on');
  });

  test('a pickup pops "+1" and the result waits ~600 ms after the end (P28C T3)', async ({ page }) => {
    type Hand = { handPlay: (until: 'score' | 'end') => { runState: string; score: number; at: number } };
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 5, undefined, { timeout: 60_000 });
    const scored = await page.evaluate(() => (window.__playShell as unknown as Hand).handPlay('score'));
    expect(scored.score).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    // Snímek 100 ms po sebrání: „+N“ visí nad hráčem (a za 500 ms zmizí sám).
    expect(await page.evaluate(() => document.querySelector('[data-testid="score-pop"]')?.textContent ?? null)).toBe(`+${scored.score}`);

    const end = await page.evaluate(async () => {
      const run = (window.__playShell as unknown as Hand).handPlay('end');
      return new Promise<{ runState: string; delay: number }>((resolve) => {
        const poll = (): void => {
          if (document.querySelector('[data-testid="play-outcome"]') !== null) resolve({ runState: run.runState, delay: performance.now() - run.at });
          else requestAnimationFrame(poll);
        };
        poll();
      });
    });
    expect(end.runState).toBe('won');
    expect(end.delay).toBeGreaterThanOrEqual(550);
    expect(end.delay).toBeLessThanOrEqual(800);
  });

  // P33 T11: výzva visí, dokud hra čeká na první dotek – hodiny stojí na tiku 0 a první stisk padne do něj.
  // P70C T2: desktop kliká – běžec skáče mezerníkem, takže výzva řekne i Space („Tap to start“ jen na dotyku).
  test('the game waits on tick 0 under "Click or press Space" and the first input starts it (P28C T5, P33 T11, P70C T2)', async ({ page }) => {
    await page.goto(url);
    const prompt = page.getByTestId('play-first-prompt');
    await expect(page.getByTestId('play-first-prompt-start')).toHaveText('Click or press Space', { timeout: 60_000 });
    await expect(page.getByTestId('play-first-prompt-action')).toHaveText('Tap to jump');
    await page.waitForTimeout(1_500);
    expect(await page.evaluate(() => window.__playShell!.tick())).toBe(0);
    await page.keyboard.press('Space');
    await expect(prompt).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(10);
    expect(await page.evaluate(() => window.__playShell!.inputs()[0])).toMatchObject({ tick: 0 });
  });

  test('ArrowLeft moves the runner to the left of the screen', async ({ page }) => {
    await page.goto(url);
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
    const start = Number(await stage.getAttribute('data-player-x'));
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Number(await stage.getAttribute('data-player-x'))).toBeLessThan(start - 0.05);
  });

  test('the verifier bot replayed by the probe wins and the outcome says so', async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    const outcome = await page.evaluate(() => window.__playShell!.playWitness());
    expect(outcome.runState).toBe('won');
    await expect(page.getByTestId('play-outcome')).toContainText('You did it!');
    await expect(page.getByTestId('play-progress')).toHaveAttribute('data-progress', '100');
  });

  test('after the run the scene draws on demand: the end state and Replay still redraw it (P28E T2)', async ({ page }) => {
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    const stage = page.getByTestId('arcade-stage').locator('canvas');
    const running = await stage.screenshot();
    await page.evaluate(() => window.__playShell!.playWitness());
    await expect(page.getByTestId('play-outcome')).toContainText('You did it!');
    // Konec běhu přepne plátno na kreslení na požádání; poslední stav se přesto nakreslí.
    await expect.poll(async () => (await stage.screenshot()).equals(running)).toBe(false);
    const ended = await stage.screenshot();
    await page.getByTestId('play-replay').click();
    await expect.poll(async () => (await stage.screenshot()).equals(ended)).toBe(false);
  });

  test('the runner draws at most 250 calls a frame, not the whole track (P28E-R1)', async ({ page }) => {
    // Počítá `draw*` WebGL mezi dvěma snímky – totéž, co `renderer.info.render.calls`.
    await page.addInitScript(() => {
      const gl = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
      const counts: number[] = [];
      let calls = 0;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
        const original = gl[name]!;
        gl[name] = function (this: unknown, ...args: unknown[]) {
          calls += 1;
          return original.apply(this, args);
        };
      }
      const frame = () => {
        if (calls > 0) counts.push(calls);
        calls = 0;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      (window as unknown as { __calls: number[] }).__calls = counts;
    });
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    // „Show me how“ je od P34 T5 na kartě pauzy (HUD kitu).
    await openPause(page);
    await page.getByTestId('play-demo-start').click();
    await page.waitForTimeout(2_000);
    const counts = await page.evaluate(() => [...(window as unknown as { __calls: number[] }).__calls].slice(-60).sort((a, b) => a - b));
    expect(counts.length).toBeGreaterThan(10);
    expect(counts[Math.floor(counts.length / 2)]).toBeLessThanOrEqual(250);
  });

  test('a phone viewport has no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await expect(page.getByTestId('arcade-stage')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
