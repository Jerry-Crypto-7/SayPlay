import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

/**
 * Hra na telefonu dostane obrazovku (P28D T8, F-26): na 390×844 zabírají
 * překryvy (HUD, banner AI, rodokmen, karty cílů) nejvýš 30 % výšky a žádné
 * dva se nepřekrývají. Měří se z `getBoundingClientRect`, ne od oka; snímky
 * pro oko jdou do `P28_PHONE_DIR`, když je nastavený.
 */

const DIR = process.env.P28_PHONE_DIR ?? '';

const GAMES = [
  { kind: 'grid', sentence: 'Collect five glowing mushrooms then open a portal.' },
  { kind: 'runner', sentence: 'jumping arcade game with a lot of obstacles' },
  { kind: 'arena', sentence: 'Survive in an arena full of slimes.' },
] as const;

interface Box {
  readonly name: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

for (const game of GAMES) {
  test(`phone 390×844: the ${game.kind} game keeps ≥ 70 % of the screen and no overlay overlaps`, async ({ page, request }) => {
    const response = await request.post('/api/play/games', { data: { sentence: game.sentence } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const { url } = (await response.json()) as { url: string };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    await expect(page.getByTestId('play-building')).toHaveCount(0, { timeout: 60_000 });
    await page.waitForTimeout(1500);
    if (DIR !== '') {
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: join(DIR, `${game.kind}.png`) });
    }

    const { boxes, height } = await page.evaluate(() => {
      const found: Box[] = [];
      // Výzva prvních sekund (P28C T5) leží schválně uprostřed a do 4 s zmizí – není to panel, který ubírá plochu.
      for (const el of document.querySelectorAll<HTMLElement>('.play-shell > :not(.play-stage):not(.play-first-prompt), .play-honest')) {
        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
        found.push({ name: el.className, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
      return { boxes: found, height: window.innerHeight };
    });

    const top = Math.max(0, ...boxes.filter((b) => b.top + b.bottom < height).map((b) => b.bottom));
    const bottom = Math.min(height, ...boxes.filter((b) => b.top + b.bottom >= height).map((b) => b.top));
    const shown = boxes.map((b) => `${b.name} ${Math.round(b.top)}–${Math.round(b.bottom)}`).join(', ');
    expect(bottom - top, `play area ${Math.round(bottom - top)} of ${height}: ${shown}`).toBeGreaterThanOrEqual(0.7 * height);

    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        expect(overlap, `${a.name} overlaps ${b.name}`).toBe(0);
      }
    }
  });
}

/** Co z HUD, lišty cílů a karty výsledku leží pod štítkem AI verze. */
async function underNotice(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const notice = document.querySelector('[data-testid="upgrade-state"]')!.getBoundingClientRect();
    const hits: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.play-hud, .play-targets, .play-outcome')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (Math.min(notice.right, r.right) > Math.max(notice.left, r.left) && Math.min(notice.bottom, r.bottom) > Math.max(notice.top, r.top)) hits.push(el.className);
    }
    return hits;
  });
}

// P33 T5: štítek AI verze se rozmístil podle stavu (běží vpravo nahoře, hotová verze dole nad lištou,
// s kartou výsledku zase nahoře). Překryv je vidět jen na úzké obrazovce – drží ho tahle kontrola.
test('phone 390×844: the AI-version notice never covers the HUD, the targets or the result card', async ({ page, request }) => {
  const created = await request.post('/api/play/games', { data: { sentence: GAMES[0].sentence } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const draft = (await created.json()) as { url: string; upgrade: string };
  const other = await request.post('/api/play/games', { data: { sentence: GAMES[1].sentence } });
  const target = ((await other.json()) as { versionId: string }).versionId;
  let ready = false;
  await page.route(`**${draft.upgrade}`, (route) =>
    route.fulfill({ json: ready ? { status: 'ready', versionId: target } : { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(draft.url);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  const notice = page.getByTestId('upgrade-state');
  const check = async (state: string): Promise<void> => {
    if (DIR !== '') {
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: join(DIR, `notice-${state}.png`) });
    }
    expect(await underNotice(page), state).toEqual([]);
  };

  await expect(notice).toHaveAttribute('data-kind', 'working', { timeout: 15_000 });
  await check('working');

  ready = true;
  await expect(notice).toHaveAttribute('data-kind', 'ready', { timeout: 15_000 });
  await check('ready');

  await page.evaluate(() => window.__playShell!.playWitness());
  await expect(page.getByTestId('play-outcome')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(300);
  await check('ready-result');
});
