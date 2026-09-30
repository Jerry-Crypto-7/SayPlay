import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Snímky obrazovek `/play` vedle referencí kitu Sayplay (P34). Nástroj pro oko,
 * ne test chování: snímky jdou do `evals/play/p34/<úloha>/` a úloha je
 * prohlédne vedle `docs/brand/reference-screens/*@2x.png`. Úloha je
 * `P34_SHOTS_TASK` (`T3`, `T4` … `final`), výběr stavů `P34_SHOTS_STATES`
 * (čárkami; prázdné = všechny). Každý další stav přidá úloha, která ho staví.
 *
 * Asertuje jen, že snímek vznikl, na stránce je jediná h1 a telefon se
 * neposouvá do strany.
 */

const TASK = process.env.P34_SHOTS_TASK || 'scratch';
const DIR = join(process.cwd(), 'evals', 'play', 'p34', TASK);
const ONLY = (process.env.P34_SHOTS_STATES ?? '').split(',').filter(Boolean);

const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

const SENTENCE = 'A hamster escapes a supermarket while a giant Roomba hunts it.';

async function home(page: Page): Promise<void> {
  await page.goto('/play');
  await expect(page.getByTestId('play-sentence')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Pošle větu z domova; dveře (`POST /api/play/games`) už musí mít podvrženou odpověď. */
async function send(page: Page): Promise<void> {
  await home(page);
  await page.getByTestId('play-sentence').fill(SENTENCE);
  await page.getByTestId('play-create').click();
}

/** Hra z věty se stavem AI verze, který řekne podvržený `GET …/upgrade` (T4). */
async function game(page: Page, answer: Record<string, unknown>, kind: string): Promise<void> {
  const created = await page.request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const draft = (await created.json()) as { url: string; upgrade: string };
  await page.route(`**${draft.upgrade}`, (route) => route.fulfill({ json: answer, headers: { 'cache-control': 'no-store' } }));
  await page.goto(draft.url);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await expect(page.getByTestId('play-loading')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('upgrade-state')).toHaveAttribute('data-kind', kind, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

const STATES: Record<string, (page: Page) => Promise<void>> = {
  home,
  // Karta nápadu vložila větu: počítadlo a bublina s textem.
  'home-idea': async (page) => {
    await home(page);
    await page.getByTestId('play-starter-chase_escape').click();
    await expect(page.getByTestId('play-sentence')).not.toHaveValue('');
    await page.waitForTimeout(400);
  },
  // T4: hra je založená, přechod na ni visí – první krok odškrtnutý, druhý pulzuje.
  building: async (page) => {
    await page.route('**/api/play/games', (route) => (route.request().method() === 'POST' ? route.fulfill({ json: { url: '/play/held' } }) : route.continue()));
    await page.route('**/play/held**', () => new Promise<void>(() => undefined));
    await send(page);
    await expect(page.getByTestId('play-status').locator('li').nth(1)).toHaveAttribute('data-state', 'active');
    await page.waitForTimeout(400);
  },
  // T4: dveře větu odmítly (422) – chybový toast kitu s `Try again`.
  'create-error': async (page) => {
    await page.route('**/api/play/games', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 422, json: { error: { code: 'SPEC_REJECTED', message: 'no_loop: the sentence could not become a game' } } })
        : route.continue(),
    );
    await send(page);
    await expect(page.getByTestId('play-create-error')).toBeVisible();
    await page.waitForTimeout(400);
  },
  // T4: bez sítě – věta zůstane a toast řekne, že odejde sama.
  'create-offline': async (page) => {
    await home(page);
    await page.getByTestId('play-sentence').fill(SENTENCE);
    await page.context().setOffline(true);
    await page.getByTestId('play-create').click();
    await expect(page.getByTestId('play-create-error')).toBeVisible();
    await page.waitForTimeout(400);
  },
  // T4: AI verze se dopočítává – pilulka `.sp-status` vlevo pod pruhem.
  'game-quick': (page) => game(page, { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() }, 'working'),
  // T4: AI verze je hotová – toast `.sp-toast` s tlačítkem.
  'game-ready': async (page) => {
    const other = await page.request.post('/api/play/games', { data: { sentence: 'Collect five glowing mushrooms then open a portal.' } });
    const target = ((await other.json()) as { versionId: string }).versionId;
    await game(page, { status: 'ready', versionId: target }, 'ready');
  },
  // T4: AI verze nepřijde (bez modelu) – poznámka na místě pilulky s `Try again`.
  'game-final': (page) => game(page, { status: 'draft-final', reason: 'MODEL_UNAVAILABLE' }, 'final'),
};

test.describe.configure({ mode: 'serial' });

for (const [state, reach] of Object.entries(STATES)) {
  if (ONLY.length > 0 && !ONLY.includes(state)) continue;
  for (const size of SIZES) {
    test(`${state} ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await reach(page);
      await expect(page.locator('h1')).toHaveCount(1);
      if (size.width < 600) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: join(DIR, `${state}-${size.name}.png`) });
    });
  }
}
