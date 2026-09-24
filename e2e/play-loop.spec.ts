import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Události smyčky (P27D T4, B4): jedna relace s hrou, kterou hráč rozehraje a
 * sdílí, a odkaz otevřený v jiném kontextu dají právě tu posloupnost, kterou
 * mají – každou jednou. Záznam robota přehraný sondou není hráč: nepřidá výhru
 * ani restart. Čte se záznam, který zapsal server (`data/play/events`).
 */

const EVENTS = join(process.cwd(), 'data', 'play', 'events');

function linesOf(session: string): string[] {
  if (!existsSync(EVENTS)) return [];
  return readdirSync(EVENTS)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readFileSync(join(EVENTS, name), 'utf8').split('\n'))
    .filter((line) => line.includes(session));
}

const eventsOf = (session: string): string[] => linesOf(session).map((line) => (JSON.parse(line) as { name: string }).name);

const sessionOf = (page: Page) => page.evaluate(() => sessionStorage.getItem('play-loop-session') ?? '');

test('a played and shared game, then its link opened elsewhere, log each step once', async ({ browser, request }) => {
  const made = await request.post('/api/play/games', { data: { sentence: 'jumping arcade game with a lot of obstacles' } });
  expect(made.status(), await made.text()).toBeLessThan(300);
  const url = ((await made.json()) as { url: string }).url;

  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 10, undefined, { timeout: 60_000 });
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  // Robot ověřovače dohraje hru za hráče – to výhra hráče není, a restart po ní taky ne.
  await page.evaluate(() => window.__playShell!.playWitness());
  await expect(page.getByTestId('play-outcome')).toBeVisible();
  await page.getByTestId('play-replay').click();
  await page.getByTestId('play-share').click();
  await expect(page.getByText('Link copied')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const player = await sessionOf(page);
  expect(player).toMatch(/^[a-z0-9]{12,32}$/);

  const friend = await browser.newContext();
  const other = await friend.newPage();
  await other.goto(link);
  await other.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const opener = await sessionOf(other);
  expect(opener).not.toBe(player);

  await expect.poll(() => eventsOf(player).sort(), { timeout: 15_000 }).toEqual(['first_input', 'impression', 'share']);
  await expect.poll(() => eventsOf(opener).sort(), { timeout: 15_000 }).toEqual(['impression', 'shared_open']);
  // Věta hry do záznamu nešla.
  expect(linesOf(player).join('\n')).not.toContain('obstacles');
  await context.close();
  await friend.close();
});
