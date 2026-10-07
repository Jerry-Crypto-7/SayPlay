import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startGame } from './play-start';

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
  await startGame(page);
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 10, undefined, { timeout: 60_000 });
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  // Stisk jde do záznamu až s dalším tikem; restart sondy před ním by ho zahodil.
  await page.waitForFunction(() => window.__playShell!.inputs().length > 0);
  // Robot ověřovače dohraje hru za hráče – to výhra hráče není, a restart po ní taky ne.
  await page.evaluate(() => window.__playShell!.playWitness());
  await expect(page.getByTestId('play-outcome')).toBeVisible();
  await page.getByTestId('play-replay').click();
  // Od P34 T7 otevře kolo sdílení v HUD list; odkaz zkopíruje jeho „Dare a friend“.
  await page.getByTestId('play-share').click();
  await page.getByTestId('play-share-dare').click();
  // P34 T6: toast mluví kitem („Link copied. Go dare someone.“ místo „Link copied“).
  await expect(page.getByText('Link copied. Go dare someone.')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const player = await sessionOf(page);
  expect(player).toMatch(/^[a-z0-9]{12,32}$/);

  const friend = await browser.newContext();
  const other = await friend.newPage();
  await other.goto(link);
  await other.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const opener = await sessionOf(other);
  expect(opener).not.toBe(player);

  // Po „Replay“ hraje zase člověk a běžec bez stisku sám narazí – ta prohra je lidská
  // a smí přijít kdykoli; výhra robota ani restart po ní se nepočítají.
  await expect.poll(() => eventsOf(player).filter((name) => name !== 'lose').sort(), { timeout: 15_000 }).toEqual(['first_input', 'impression', 'share']);
  await expect.poll(() => eventsOf(opener).sort(), { timeout: 15_000 }).toEqual(['impression', 'shared_open']);
  // Věta hry do záznamu nešla.
  expect(linesOf(player).join('\n')).not.toContain('obstacles');
  await context.close();
  await friend.close();
});

/** T31: follow a verified mechanic chip through the real publication endpoint. */
test('post-run mechanic remix opens a distinct playable child', async ({ page, request }) => {
  const made = await request.post('/api/play/games', { data: { sentence: 'A fox runs', seed: 1 } });
  expect(made.ok(), await made.text()).toBe(true);
  const parent = await made.json() as { url: string; versionId: string };
  await page.goto(parent.url);
  await startGame(page);
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__playShell!.playWitness());
  await expect(page.getByTestId('play-outcome')).toBeVisible();
  // This request runs real robot/witness checks before offering a chip. Observe
  // its result rather than spending the default 5s assertion window on server work.
  const offered = page.waitForResponse(response => response.request().method() === 'GET'
    && response.url().includes(`/api/play/games/${parent.versionId}/remix?suggestions=1`), { timeout: 15_000 });
  await page.getByRole('button', { name: 'Remix it', exact: true }).click();
  const suggestionResponse = await offered;
  expect(suggestionResponse.status(), await suggestionResponse.text()).toBe(200);
  const { suggestions } = await suggestionResponse.json() as { suggestions: { id: string; label: string; cellId: string }[] };
  expect(Array.isArray(suggestions)).toBe(true);
  expect(suggestions.length).toBeGreaterThanOrEqual(2);
  expect(suggestions.length).toBeLessThanOrEqual(3);
  for (const suggestion of suggestions) expect(suggestion).toEqual({
    id: expect.any(String), label: expect.any(String), cellId: expect.any(String),
  });
  const chips = page.getByTestId('recipe-remix-chip');
  await expect(chips).toHaveCount(suggestions.length);
  const shooting = chips.filter({ hasText: 'Add shooting' });
  await expect(shooting).toBeVisible();
  const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/api/play/games/${parent.versionId}/remix`));
  await shooting.click();
  const remixed = await response;
  expect(remixed.ok(), await remixed.text()).toBe(true);
  expect(remixed.status()).not.toBe(202);
  const child = await remixed.json() as { versionId: string; url: string };
  expect(child.versionId).not.toBe(parent.versionId);
  await expect(page).toHaveURL(child.url);
  const fetched = await request.get(`/api/play/games/${child.versionId}`);
  expect(fetched.ok()).toBe(true);
  const stored = await fetched.json() as { version: { parentId: string }; spec: { addons?: string[] } };
  expect(stored.version.parentId).toBe(parent.versionId);
  expect(stored.spec.addons).toContain('shoot');
  await startGame(page);
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__playShell!.playWitness());
  await expect(page.getByTestId('play-outcome')).toBeVisible();
});
