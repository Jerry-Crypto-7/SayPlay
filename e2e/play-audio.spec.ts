import { readdirSync } from 'node:fs';
import path from 'node:path';

import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { openPause, startGame } from './play-start';

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
      await startGame(page);
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
    // Od P34 T5 je Sound na kartě pauzy (HUD kitu); M platí i s otevřenou kartou.
    await openPause(page);
    await page.keyboard.press('m');
    await expect(page.getByTestId('play-mute')).toHaveText('Sound off');
    expect(await page.evaluate(() => window.__playAudio!.musicGain())).toBe(0);
    await page.keyboard.press('m');
    await expect(page.getByTestId('play-mute')).toHaveText('Sound on');
    expect(await page.evaluate(() => window.__playAudio!.musicGain())).toBeGreaterThan(0);
  });

  /*
   * Hlas vypravěče (P29D T11). E2e server hlasovou službu nemá, takže dveře
   * `…/voice` poctivě vrátí 204 a hra mlčí. Hotovou nahrávku podvrhne
   * `page.route` – skutečný Ogg (14s smyčka hudby, ať při ztlumení ještě hraje).
   */
  const VOICE = '**/api/play/games/*/voice';
  const MUSIC_DIR = path.join(__dirname, '..', 'public', 'assets', 'worldstream', 'audio', 'music');
  const readyVoice = (page: Page) => page.route(VOICE, (route) => route.fulfill({ path: path.join(MUSIC_DIR, readdirSync(MUSIC_DIR)[0]!), contentType: 'audio/ogg' }));

  test('voice: without the service the game asks only after the gesture and stays silent', async ({ page }) => {
    const asked: number[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('/voice')) asked.push(response.status());
    });
    await page.goto(urls.arcade!);
    await startGame(page);
    await page.waitForFunction(() => window.__playAudio !== undefined && window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    expect(asked).toEqual([]);
    await gesture(page);
    await expect.poll(() => asked, { timeout: 20_000 }).toEqual([204]);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__playAudio!.narrated())).toEqual([]);
  });

  test('voice: a finished narration plays once after the gesture and mute cuts it', async ({ page }) => {
    await readyVoice(page);
    await page.goto(urls.arcade!);
    await page.waitForFunction(() => window.__playAudio !== undefined && window.__playShell !== undefined, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__playAudio!.narration())).toBeNull();
    await gesture(page);
    await expect.poll(() => page.evaluate(() => window.__playAudio!.narration()), { timeout: 20_000 }).toMatch(/^\/api\/play\/games\/[0-9a-f]+\/voice$/);
    await page.keyboard.press('m');
    expect(await page.evaluate(() => window.__playAudio!.narration())).toBeNull();
    await page.keyboard.press('m');
    // Jednou za stránku – odtlumení ji znovu nespustí.
    expect(await page.evaluate(() => window.__playAudio!.narration())).toBeNull();
    expect(await page.evaluate(() => window.__playAudio!.narrated())).toHaveLength(1);
  });

  test('voice: a muted game never starts the narration', async ({ page }) => {
    await readyVoice(page);
    await page.addInitScript(() => localStorage.setItem('play:sound', 'muted'));
    await page.goto(urls.arcade!);
    await page.waitForFunction(() => window.__playAudio !== undefined && window.__playShell !== undefined, undefined, { timeout: 60_000 });
    await gesture(page);
    await expect.poll(() => page.evaluate(() => window.__playAudio!.state()), { timeout: 20_000 }).toBe('running');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__playAudio!.narrated())).toEqual([]);
  });
});

/*
 * P37B T5: hudba podle napětí a zvuk každé události. Prohlížeč nesmí
 * kontext zvuku dostat před gestem (jinak varuje „AudioContext was not allowed
 * to start“), a to na telefonu i na desktopu. Aréna s pronásledovatelem:
 * hráč stojí, medvěd přijde blízko a hudba přejde do napjaté smyčky.
 */
const { defaultBrowserType: _pixelBrowser, ...PIXEL_7 } = devices['Pixel 7'];
const AREA = 'A cat collects glowing fish on a frozen lake while a polar bear chases it';

for (const [name, device] of [
  ['desktop', {}],
  ['Pixel 7', PIXEL_7],
] as const) {
  test.describe(`${name} – sound starts only after the gesture (P37B T5)`, () => {
    test.use(device);

    test('no audio context before the gesture, then music that tenses and no console error', async ({ page, request }) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        // Síťové chyby (offline režisér bez klíčů) sem nepatří – jde o chyby skriptu a zvuku.
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
        if (message.type() === 'warning' && /AudioContext/i.test(message.text())) errors.push(message.text());
      });
      await page.goto(await publish(request, AREA));
      await startGame(page);
      await page.waitForFunction(() => window.__playAudio !== undefined && window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
      expect(await page.evaluate(() => window.__playAudio!.state())).toBe('none');

      await gesture(page);
      await expect.poll(() => page.evaluate(() => window.__playAudio!.music()), { timeout: 20_000 }).toMatch(/-(calm|tense)\.ogg$/);
      // Hráč stojí, medvěd ho dožene: blízký soupeř nebo ztracený život hudbu napne.
      await expect.poll(() => page.evaluate(() => window.__playAudio!.tension()), { timeout: 60_000 }).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__playAudio!.music()), { timeout: 20_000 }).toMatch(/-tense\.ogg$/);
      expect(errors).toEqual([]);
    });
  });
}
