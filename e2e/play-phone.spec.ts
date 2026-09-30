import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

/**
 * Hra na telefonu dostane obrazovku (P28D T8, F-26, P33 T12, P34 T5): na 390×844
 * zabírají pruhy HUD přes šířku (dolní řada, lišta cílů) nejvýš 15 % výšky,
 * úzké věci u okraje (pilulky HUD v rozích, štítek AI) nejvýš 20 % plochy
 * a žádné dva překryvy se nepřekrývají. Měří se z `getBoundingClientRect`, ne od oka; snímky
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

/*
 * P33 T12 – hra na celou plochu. Pruhy přes víc než polovinu šířky (pruh nahoře, řádka ovládání, lišta
 * cílů) smějí vzít nejvýš 15 % výšky; dřív 70 %, kdy HUD byl panel s tlačítky a nad hrou ležely další
 * dva proužky (516 z 844). Úzké věci u okraje – sloupec akcí vpravo, štítek AI vlevo – berou šířku,
 * ne výšku: každá smí mít nejvýš polovinu šířky, dohromady nejvýš 20 % plochy a nic nepřekrýt.
 */
const BAND_SHARE = 0.85;
const SIDE_AREA = 0.2;

for (const game of GAMES) {
  test(`phone 390×844: the ${game.kind} game keeps ≥ 85 % of the height and no overlay overlaps`, async ({ page, request }) => {
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

    const { boxes, height, width } = await page.evaluate(() => {
      const found: Box[] = [];
      // Výzva prvních sekund (P28C T5) leží schválně uprostřed a do 4 s zmizí – není to panel, který ubírá plochu.
      // Od P34 T5 je HUD vrstva kitu přes celou scénu, která ťuky pouští skrz: plochu berou její kusy, ne vrstva.
      // Řádek cíle je jako výzva jen na začátek (kit: první 4 s hry, znovu při pauze), text pro čtečku nemá plochu.
      const pieces = '.play-shell > :not(.play-stage):not(.play-first-prompt):not(.play-hud), .play-hud > :not(.play-hud-goal):not(.play-sr-only), .play-honest';
      for (const el of document.querySelectorAll<HTMLElement>(pieces)) {
        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
        found.push({ name: el.className, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
      return { boxes: found, height: window.innerHeight, width: window.innerWidth };
    });

    const bands = boxes.filter((b) => b.right - b.left > width / 2);
    const sides = boxes.filter((b) => b.right - b.left <= width / 2);
    const top = Math.max(0, ...bands.filter((b) => b.top + b.bottom < height).map((b) => b.bottom));
    const bottom = Math.min(height, ...bands.filter((b) => b.top + b.bottom >= height).map((b) => b.top));
    const shown = boxes.map((b) => `${b.name} ${Math.round(b.left)}–${Math.round(b.right)} × ${Math.round(b.top)}–${Math.round(b.bottom)}`).join(', ');
    expect(bottom - top, `play height ${Math.round(bottom - top)} of ${height}: ${shown}`).toBeGreaterThanOrEqual(BAND_SHARE * height);
    // Časovač s pauzou (P34 T5, dřív sloupec akcí) je vidět v pravém horním rohu.
    expect(sides.some((b) => b.name.includes('play-hud-corner') && b.right >= width - 16 && b.top <= 24), shown).toBe(true);
    const sideArea = sides.reduce((sum, b) => sum + (b.right - b.left) * (b.bottom - b.top), 0);
    expect(sideArea, `side overlays cover ${Math.round((100 * sideArea) / (width * height))} % of the screen: ${shown}`).toBeLessThanOrEqual(SIDE_AREA * width * height);

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
    // Od P34 T5 je štítek sám kusem vrstvy HUD kitu; ta je přes celou scénu, takže se měří její kusy.
    // Výsledek (P34 T6) leží přes celou scénu taky – měří se jeho list a odznak, ne celá vrstva.
    for (const el of document.querySelectorAll<HTMLElement>('.play-hud > :not([data-testid="upgrade-state"]):not(.play-sr-only), .play-targets, .play-outcome, .play-result-sheet, .play-result-badge')) {
      const r = el.getBoundingClientRect();
      // Skrytý kus (řádek cíle po konci běhu) štítek nezakryje – jako u měření pruhů výš.
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
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
