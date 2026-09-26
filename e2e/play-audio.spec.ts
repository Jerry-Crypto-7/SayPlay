import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Vlastní hudba a zvuky hry (P29D T5): před prvním gestem hráče se nestáhne
 * jediný zvukový soubor (první snímek nečeká na zvuk), po klepnutí hraje
 * smyčka pro look hry, zvuky looku jsou dekódované a ztlumení platí i pro
 * hudbu.
 */

/** Arkádové plátno (`ArcadePlay`) i mřížka (`GridShell`) – obě cesty hrají hudbu. */
const GAMES = [
  { id: 'arcade', sentence: 'jumping arcade game with a lot of obstacles', look: /[a-z_]+/ },
  { id: 'grid', sentence: 'jumping arcade game on a sunny beach with a lot of crabs', look: /beach/ },
] as const;

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Gesto hráče mimo tlačítka – zvuk se probouzí na `pointerdown` okna. */
const gesture = (page: Page) => page.mouse.click(4, 4);

test.describe('/play/[id] – the game’s own music and sounds', () => {
  const urls: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    for (const game of GAMES) urls[game.id] = await publish(request, game.sentence);
  });

  for (const game of GAMES) {
    test(`${game.id}: no sound file before the first gesture, then the look’s loop and sounds`, async ({ page }) => {
      const audio: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/assets/worldstream/audio/')) audio.push(new URL(request.url()).pathname);
      });
      await page.goto(urls[game.id]!);
      await page.waitForFunction(() => window.__playAudio !== undefined && window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
      await page.waitForTimeout(1000);
      expect(audio).toEqual([]);
      expect(await page.evaluate(() => window.__playAudio!.music())).toBeNull();

      await gesture(page);
      await expect.poll(() => page.evaluate(() => window.__playAudio!.music()), { timeout: 20_000 }).toMatch(/^\/assets\/worldstream\/audio\/music\/[a-z_]+-(calm|tense)\.ogg$/);
      const loop = (await page.evaluate(() => window.__playAudio!.music()))!;
      const look = loop.split('/').pop()!.replace(/-(calm|tense)\.ogg$/, '');
      expect(look).toMatch(game.look);
      await expect.poll(() => page.evaluate(() => window.__playAudio!.loaded().filter((u) => u.includes('/audio/sfx/')).length), { timeout: 20_000 }).toBe(5);
      const sounds = await page.evaluate(() => window.__playAudio!.loaded().filter((u) => u.includes('/audio/sfx/')));
      for (const sound of sounds) expect(sound).toContain(`/audio/sfx/${look}-`);
      expect(audio).toContain(loop);
    });
  }

  test('mute silences the music too and M brings it back', async ({ page }) => {
    await page.goto(urls.arcade!);
    await page.waitForFunction(() => window.__playAudio !== undefined && window.__playShell !== undefined, undefined, { timeout: 60_000 });
    await gesture(page);
    await expect.poll(() => page.evaluate(() => window.__playAudio!.music()), { timeout: 20_000 }).not.toBeNull();
    await page.keyboard.press('m');
    await expect(page.getByTestId('play-mute')).toHaveText('Sound off');
    expect(await page.evaluate(() => window.__playAudio!.musicGain())).toBe(0);
    await page.keyboard.press('m');
    await expect(page.getByTestId('play-mute')).toHaveText('Sound on');
    expect(await page.evaluate(() => window.__playAudio!.musicGain())).toBeGreaterThan(0);
  });
});
