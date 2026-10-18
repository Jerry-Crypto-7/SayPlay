import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

import { pacingBannerLabel } from '../src/components/play/arcade/PacingBanner';
import type { ArcadeWorld } from '../src/play/arcade/contract';
import { pacingBeatOrderOf } from '../src/play/arcade/pieces/pacing';

/**
 * Finále chodce ve scéně (P51 T9). Věta chodce z dev sady P51 (w01) dveřmi návštěvníka, robot hraje „rukou“ tik po
 * tiku, dokud scéna neukáže banner finále; tam se hra zastaví (banner visí na herní čas, takže zůstane), Playwright
 * zkontroluje, co člověk vidí – „Exit ahead!“ v záběru, náběh, nebo s „méně pohybu“ žádný – a uloží snímek. Pak
 * robot hru dohraje: výhra, finále přišlo v posledních vteřinách a jen jednou. Že nápis sedí na změnu ve světě
 * v témže tiku, pinuje `src/play/arcade/__tests__/p51-finale-news.test.ts`; tady jde o to, že ho scéna opravdu ukáže.
 */

const SENTENCE = 'a lost cat sneaks through a dark hedge maze to find its way home';

/** Tiků robota na snímek (vzor `play-segments.spec.ts`). */
const PER_FRAME = 3;

/** Finále chodce je stezka posledních polí před východem: nejvýš tolik sekund před výhrou (pin dává 10 s). */
const FINALE_WITHIN_S = 10;

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

/** Hláška rekordéru klipu na telefonu, ne banneru (viz `play-segments.spec.ts`). */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

interface HandProbe {
  start(): void;
  byHand(on: boolean): void;
  botWants(): { readonly axis: number; readonly buttons: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string; readonly tick: number };
}

interface Leg {
  readonly runState: string;
  readonly tick: number;
  /** Chvíle banneru, jak se během úseku objevovaly. */
  readonly beats: readonly string[];
}

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

/** Robot hraje, dokud banner neukáže chvíli `until` (pak stojí, ruka zůstává), nebo do konce hry (`until` null). */
async function playUntil(page: Page, until: string | null, begin: boolean): Promise<Leg> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate(
    ({ perFrame, until, begin }) =>
      new Promise<Leg>((resolve) => {
        const shell = window.__playShell as unknown as HandProbe;
        const beats: string[] = [];
        // Druhý úsek začíná pod bannerem, na kterém první skončil – ten už je zapsaný.
        let last: Element | null = document.querySelector('[data-testid="play-pacing-banner"]');
        const look = (): string | null => {
          const banner = document.querySelector('[data-testid="play-pacing-banner"]');
          if (banner !== null && banner !== last) beats.push(banner.getAttribute('data-beat') ?? '');
          last = banner;
          return banner?.getAttribute('data-beat') ?? null;
        };
        if (begin) {
          shell.start();
          shell.byHand(true);
        }
        let now = { runState: 'running', tick: 0 };
        const frame = () => {
          // Banner, který React vykreslil po tikách minulého snímku.
          if (look() === until && until !== null) {
            resolve({ ...now, beats });
            return;
          }
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
          setTimeout(() => {
            look();
            shell.byHand(false);
            resolve({ ...now, beats });
          }, 100);
        };
        requestAnimationFrame(frame);
      }),
    { perFrame: PER_FRAME, until, begin },
  );
}

const RUNS = [
  { device: 'desktop', reduce: false },
  { device: 'Pixel 7', reduce: true },
] as const;

for (const run of RUNS) {
  test.describe(`walker finale announced, ${run.device}${run.reduce ? ', reduced motion' : ''}`, () => {
    if (run.device === 'Pixel 7') test.use(PIXEL_7);

    test(`“${SENTENCE}”: the scene shows “Exit ahead!” on the trail to the exit`, async ({ page, request }) => {
      test.setTimeout(240_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      if (run.reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
      const world = await makeGame(page, request);
      expect(pacingBeatOrderOf(world), 'a new walker game has the exit finale').toContain('exit');

      const reached = await playUntil(page, 'exit', true);
      expect(reached.runState, 'the finale comes while the game still runs').toBe('running');
      const banner = page.getByTestId('play-pacing-banner');
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute('data-beat', 'exit');
      await expect(banner).toHaveText(pacingBannerLabel(world, 'exit'));
      await expect(banner).toHaveText('Exit ahead!');
      await expect(banner).toBeInViewport();
      expect(await banner.evaluate((element) => getComputedStyle(element).animationName)).toBe(run.reduce ? 'none' : 'play-pacing-banner');
      await test.info().attach(`walker finale ${run.device}${run.reduce ? ' reduce' : ''}`, { body: await page.screenshot(), contentType: 'image/png' });

      const rest = await playUntil(page, null, false);
      console.log(`${run.device}${run.reduce ? ' reduce' : ''}: exit at ${(reached.tick / 60).toFixed(1)} s, ${rest.runState} at ${(rest.tick / 60).toFixed(1)} s – ${[...reached.beats, ...rest.beats].join(' ')}`);
      expect(rest.runState, 'the bot played the game to the end').toBe('won');
      expect((rest.tick - reached.tick) / 60, 'the finale is the last stretch of the game').toBeLessThanOrEqual(FINALE_WITHIN_S);
      expect([...reached.beats, ...rest.beats].filter((beat) => beat === 'exit'), 'announced once').toEqual(['exit']);
      expect(errors.filter((error) => !error.startsWith(CLIP_RESOLUTION_WARNING))).toEqual([]);
    });
  });
}
