import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, expect, test } from '@playwright/test';

/**
 * Tučňák běžce (P32A). T5: hrdina se hýbe jako postava – po stisku úhybu se
 * do 150 ms nakloní (sonda pózy `__playHero`), jede v póze jízdy a po skoku
 * a dopadu vydá sběrnice efektů `land` (sonda `__playFx`). Snímky celého řezu
 * přidá T8.
 *
 * Hra je fixtura běžce s hrdinou „penguin“ na ledovém svahu – to, co z věty
 * tučňáka postaví `genre/runner.ts` (`__fixtures__/penguin.json`).
 */

async function publishPenguin(request: APIRequestContext): Promise<string> {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/runner.json'), 'utf8')) as {
    theme: Record<string, unknown>;
    roles: { id: string; label: string }[];
  } & Record<string, unknown>;
  const spec = {
    ...base,
    title: 'Penguin Run',
    theme: { ...base.theme, setting: 'icy mountain slope' },
    roles: base.roles.map((role) => (role.id === 'player' ? { ...role, label: 'penguin' } : role)),
  };
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test('penguin: leans into a dodge within 150 ms, rides tilted forward and lands with a land event', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(await publishPenguin(request));
  await page.waitForFunction(
    () => window.__playShell !== undefined && window.__playHero?.() != null && window.__playFx !== undefined && window.__playShell.tick() > 5,
    undefined,
    { timeout: 60_000 },
  );

  const start = await page.evaluate(() => window.__playHero!()!);
  expect(start.ride, 'tučňák klouže na břiše').toBe('lie');
  expect(start.pitch, 'předklon jízdy (°)').toBeGreaterThan(45);
  expect(start.shadow, 'kontaktní stín pod hrdinou').toBeGreaterThan(0);

  // Úhyb doprava a měření v téže stránce po snímcích: zpáteční cesta testu by 150 ms snědla.
  // Stisk až po deseti plynulých snímcích – první snímky hry zdrží načítání modelu a shaderů.
  const lean = await page.evaluate(
    () =>
      new Promise<{ ms: number; roll: number }>((resolve) => {
        let smooth = 0;
        let last = performance.now();
        const measure = (from: number): void => {
          const roll = window.__playHero!()!.roll;
          const ms = performance.now() - from;
          if (roll > 5 || ms > 500) resolve({ ms, roll });
          else requestAnimationFrame(() => measure(from));
        };
        const settle = (now: number): void => {
          smooth = now - last < 40 ? smooth + 1 : 0;
          last = now;
          if (smooth < 10) {
            requestAnimationFrame(settle);
            return;
          }
          const from = performance.now();
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
          requestAnimationFrame(() => measure(from));
        };
        requestAnimationFrame(settle);
      }),
  );
  expect(lean.roll, 'náklon doprava (°)').toBeGreaterThan(5);
  expect(lean.ms, `náklon ${lean.roll.toFixed(1)}° po ${lean.ms.toFixed(0)} ms`).toBeLessThanOrEqual(150);

  expect((await page.evaluate(() => window.__playFx!())).land ?? 0, 'před skokem žádný dopad').toBe(0);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' })));
  await page.waitForFunction(() => (window.__playFx!().land ?? 0) > 0, undefined, { timeout: 5_000 });
});
