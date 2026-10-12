import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

import { pacingBannerLabel } from '../src/components/play/arcade/PacingBanner';
import type { ArcadeWorld } from '../src/play/arcade/contract';
import { segmentNewsOf } from '../src/play/arcade/pieces/pacing';

/**
 * Oznámení úseků a bosse ve scéně (P46B T7). Věta z `/play` dveřmi návštěvníka, robot hraje „rukou“ – tik po
 * tiku cestou, kterou jde hráč – a `MutationObserver` zapíše každé objevení banneru: chvíli (`data-beat`),
 * změnu úseku (`data-news`), text a animaci náběhu. Králík s liškou je běžec: úsek 2 přinese nového
 * nepřítele, úsek 3 rychlost a finále bosse – všechny tři kreslí scéna modelem lišky, takže nese jméno z věty.
 *
 * Co se hlídá: tři oznámení v pořadí úsek 2, úsek 3, boss; boss „Boss: Fox“; každý text je přesně ten, který
 * ze světa uložené hry odvodí `pacingBannerLabel` (změnu úseku pinuje `pacing-banner.test.tsx` proti tomu, co
 * svět opravdu dělá); `prefers-reduced-motion` vypne náběh a text nechá; 0 chyb konzole. Desktop i Pixel 7.
 */

const SENTENCE = 'A rabbit steals carrots and runs from a fox';
/** Jméno pronásledovatele z věty, jak ho banner napíše. */
const NAME = 'Fox';
/** Tiků robota na snímek: celá hra (~2900 tiků) za ~1000 snímků, banner (84 tiků) visí ~28 snímků. */
const PER_FRAME = 3;

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

/**
 * Hláška Chromia, ne banneru: na telefonu (Pixel 7, `devicePixelRatio` 2,6) přepne hlídač kvality během hry
 * úroveň (`look/rig/Post.tsx`, změřeno low → medium) a s ní rozlišení plátna, a rekordér klipu (`clip.ts`,
 * MP4 `avc1`) to zaloguje jako chybu. Rozlišení plátna banner nemění; vada patří rekordéru klipu, ne téhle úloze.
 */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

interface Seen {
  readonly beat: string | null;
  readonly news: string | null;
  readonly text: string;
  readonly animation: string;
}

interface HandProbe {
  start(): void;
  byHand(on: boolean): void;
  botWants(): { readonly axis: number; readonly buttons: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string; readonly tick: number };
}

/** Hra z věty jako návštěvník: pole, „Make it!“, adresa hry; vrátí uložený svět. */
async function makeGame(page: Page, request: APIRequestContext): Promise<ArcadeWorld> {
  await page.goto('/play');
  await page.getByLabel('Say it in one sentence').fill(SENTENCE);
  await page.getByTestId('play-create').click();
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 60_000 });
  await expect(page.locator('.play-shell')).toBeVisible({ timeout: 60_000 });
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const saved = await request.get(`/api/play/games/${id}`);
  expect(saved.status()).toBe(200);
  return ((await saved.json()) as { arcade: ArcadeWorld }).arcade;
}

/** Robot dohraje hru; každé nové objevení banneru se zapíše. */
async function playWatchingBanner(page: Page): Promise<{ readonly runState: string; readonly seen: readonly Seen[] }> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate(
    (perFrame) =>
      new Promise<{ runState: string; seen: Seen[] }>((resolve) => {
        const shell = window.__playShell as unknown as HandProbe;
        const seen: Seen[] = [];
        let last: Element | null = null;
        const observer = new MutationObserver(() => {
          const banner = document.querySelector('[data-testid="play-pacing-banner"]');
          if (banner === null || banner === last) return;
          last = banner;
          seen.push({ beat: banner.getAttribute('data-beat'), news: banner.getAttribute('data-news'), text: banner.textContent ?? '', animation: getComputedStyle(banner).animationName });
        });
        observer.observe(document.body, { childList: true, subtree: true });
        shell.start();
        shell.byHand(true);
        const frame = () => {
          let now = { runState: 'running', tick: 0 };
          for (let k = 0; k < perFrame && now.runState === 'running'; k += 1) {
            const wants = shell.botWants();
            if (wants !== null) {
              shell.hold(wants.axis);
              shell.press(wants.buttons);
            }
            now = shell.tickByHand();
          }
          if (now.runState === 'running' && now.tick < 6000) {
            requestAnimationFrame(frame);
            return;
          }
          // Poslední zápis DOM (React po posledním tiku) ještě doběhne.
          setTimeout(() => {
            observer.disconnect();
            shell.byHand(false);
            resolve({ runState: now.runState, seen });
          }, 100);
        };
        requestAnimationFrame(frame);
      }),
    PER_FRAME,
  );
}

const RUNS = [
  { device: 'desktop', reduce: false },
  { device: 'Pixel 7', reduce: false },
  { device: 'Pixel 7', reduce: true },
] as const;

for (const run of RUNS) {
  test.describe(`segments and the boss announced, ${run.device}${run.reduce ? ', reduced motion' : ''}`, () => {
    if (run.device === 'Pixel 7') test.use(PIXEL_7);

    test(`“${SENTENCE}”: three announcements while playing, the boss by its name from the sentence`, async ({ page, request }) => {
      test.setTimeout(240_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      if (run.reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
      const world = await makeGame(page, request);
      const { runState, seen } = await playWatchingBanner(page);
      const line = seen.map((entry) => `${entry.beat}/${entry.news ?? '-'}: ${entry.text} (${entry.animation})`).join(' | ');
      test.info().annotations.push({ type: 'banner', description: line });
      console.log(`${run.device}${run.reduce ? ' reduce' : ''}: ${runState} – ${line}`);

      expect(runState, 'the bot played the game to the end').toBe('won');
      expect(seen.map((entry) => entry.beat)).toEqual(['segment2', 'segment3', 'boss']);
      expect(seen.at(-1)!.text).toBe(`Boss: ${NAME}`);
      // Každý text je ten, který ze světa hry odvodí banner: změna úseku, nový nepřítel se jménem z věty.
      expect(seen.map((entry) => entry.text)).toEqual([...segmentNewsOf(world).map((item) => pacingBannerLabel(world, item.beat, NAME.toLowerCase())), `Boss: ${NAME}`]);
      expect(seen.slice(0, 2).map((entry) => entry.news)).toEqual(segmentNewsOf(world).map((item) => item.news));
      // Náběh je pohyb navíc: s „méně pohybu“ žádný, text zůstane.
      for (const entry of seen) expect(entry.animation).toBe(run.reduce ? 'none' : 'play-pacing-banner');
      expect(errors.filter((error) => !error.startsWith(CLIP_RESOLUTION_WARNING))).toEqual([]);
    });
  });
}
