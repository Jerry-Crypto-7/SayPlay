import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import type { HookEffect } from '../src/play/arcade/hooks/contract';

/**
 * Háčky na obrazovce (P66 T4) na hře z ručního specu `genre.v6` s koly a vylepšením (`e2e/fixtures/p66-hooks-spec.json`,
 * bez klasifikátoru), na desktopu (`chromium`) i telefonu (`pixel7-touch`):
 * - banner kola „Round N of M“ na začátku kola;
 * - karty vylepšení na nabídku, na telefonu celé v dolních 45 % výšky a každá aspoň 44 px (`--sp-size-touch-min`);
 * - volba změní hru: jádro vezme kartu, na kterou hráč klepl (telefon) nebo kterou vybral klávesou (desktop), ne
 *   výchozí kartu 0 – `upgrade_pick` nese tutéž kartu a její vylepšení;
 * - výsledek ukáže nálezy podle vzácnosti.
 *
 * Do nabídky a kola dohraje sonda vrstvy háčků (`__playHooks.playUntil`) záznam robota ověřovače „rukou“, pak hraje
 * hráč. Snímky pro oko do `D:/caches/p66/hooks/` (`P66_HOOKS_SHOTS` cestu přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p66-hooks-spec.json');
const SHOTS = process.env.P66_HOOKS_SHOTS ?? 'D:/caches/p66/hooks';
/** Karta, kterou hráč vezme: ne výchozí 0, ať je vidět, že volba hru změnila. */
const CARD = 2;

/** Arkádová sonda `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
type ArcadeProbe = { readonly handPlay: (until: 'score' | 'end') => { readonly runState: string; readonly tick: number } };

async function publishFixture(request: APIRequestContext): Promise<string> {
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const playUntil = (page: Page, kind: HookEffect['kind']): Promise<number | null> => page.evaluate((wanted) => window.__playHooks!.playUntil(wanted), kind);
const lastOf = (page: Page, kind: HookEffect['kind']): Promise<HookEffect | null> => page.evaluate((wanted) => window.__playHooks!.last(wanted), kind);
const picksSeen = (page: Page): Promise<number> => page.evaluate(() => window.__playHooks!.seen().upgrade_pick ?? 0);

test('hooks: round banner, upgrade cards in the thumb zone, the pick changes the game, rarities on the result (P66 T4)', async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const touch = info.project.name === 'pixel7-touch';
  mkdirSync(SHOTS, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });

  await page.goto(await publishFixture(request));
  await expect(page.getByTestId('arcade-stage')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => window.__playHooks !== undefined && window.__playShell !== undefined, null, { timeout: 60_000 });

  // Banner kola: začátek prvního kola hry s koly.
  expect(await playUntil(page, 'round_start'), 'hra z fixture nezačala kolo').not.toBeNull();
  const banner = page.getByTestId('hook-round-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText(/^Round 1 of [2-5]$/);
  await shot('round');

  // Karty na nabídku vylepšení, na telefonu v zóně palce.
  expect(await playUntil(page, 'upgrade_offer'), 'hra z fixture nenabídla vylepšení').not.toBeNull();
  const offer = (await lastOf(page, 'upgrade_offer')) as Extract<HookEffect, { kind: 'upgrade_offer' }>;
  const cards = page.getByTestId('upgrade-pick');
  await expect(cards).toBeVisible();
  const viewport = page.viewportSize()!;
  for (const [card, upgrade] of offer.offer.entries()) {
    const element = page.getByTestId(`upgrade-card-${card}`);
    await expect(element).toHaveAttribute('data-upgrade', upgrade);
    const box = (await element.boundingBox())!;
    expect(Math.min(box.width, box.height), `karta ${card} menší než dotykový cíl`).toBeGreaterThanOrEqual(44);
    if (touch) {
      expect(box.y, `karta ${card} nad dolními 45 % výšky`).toBeGreaterThanOrEqual(viewport.height * 0.55);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
  }
  await shot('cards');

  // Volba: klepnutí na telefonu, klávesa na desktopu – jádro vezme tutéž kartu, ne výchozí.
  const picks = await picksSeen(page);
  if (touch) await page.getByTestId(`upgrade-card-${CARD}`).tap();
  else await page.keyboard.press(String(CARD + 1));
  await expect.poll(() => picksSeen(page)).toBeGreaterThan(picks);
  expect(await lastOf(page, 'upgrade_pick')).toEqual({ kind: 'upgrade_pick', card: CARD, upgrade: offer.offer[CARD] });
  await expect(cards).toBeHidden();
  await shot('picked');

  // Výsledek: nálezy podle vzácnosti.
  await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).handPlay('end'));
  const found = page.getByTestId('play-found');
  await expect(found).toBeVisible({ timeout: 30_000 });
  await expect(found).toContainText(/\d+ common \d+ rare \d+ epic/);
  await shot('result');
});
