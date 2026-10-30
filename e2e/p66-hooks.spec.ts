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
 * - výsledek ukáže nálezy podle vzácnosti;
 * - střílečka `genre.v6` (P66 T10) nabídne karty mezi vlnami sama a karty neleží přes tlačítko střelby ani dolní
 *   řadu HUD.
 *
 * Do nabídky a kola dohraje sonda vrstvy háčků (`__playHooks.playUntil`) záznam robota ověřovače „rukou“, pak hraje
 * hráč. Snímky pro oko do `D:/caches/p66/hooks/` (`P66_HOOKS_SHOTS` cestu přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p66-hooks-spec.json');
/** Sběr arény `genre.v6` s `hookRarity`: věci dostanou vzácnost, výsledek ukáže nálezy. */
const RARITY_FIXTURE = join(process.cwd(), 'e2e/fixtures/p66-rarity-spec.json');
const SHOTS = process.env.P66_HOOKS_SHOTS ?? 'D:/caches/p66/hooks';
/** Karta, kterou hráč vezme: ne výchozí 0, ať je vidět, že volba hru změnila. */
const CARD = 2;

/** Arkádová sonda `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
type ArcadeProbe = { readonly handPlay: (until: 'score' | 'end') => { readonly runState: string; readonly tick: number } };

async function publishFixture(request: APIRequestContext, fixture = FIXTURE): Promise<string> {
  const spec = JSON.parse(readFileSync(fixture, 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const playUntil = (page: Page, kind: HookEffect['kind']): Promise<number | null> => page.evaluate((wanted) => window.__playHooks!.playUntil(wanted), kind);
const lastOf = (page: Page, kind: HookEffect['kind']): Promise<HookEffect | null> => page.evaluate((wanted) => window.__playHooks!.last(wanted), kind);
const picksSeen = (page: Page): Promise<number> => page.evaluate(() => window.__playHooks!.seen().upgrade_pick ?? 0);
/**
 * Karty doskočí (`sp-pop-in` s překmitem), takže se měří až po nástupu. P66 T10: kontrola rohů dřív občas hlásila
 * zakrytý roh (1–3 ze 4 běhů, s nástupem dohraným ani jednou); nejspíš ho uprostřed nástupu přesahovala sousední karta.
 */
const cardsSettled = (page: Page): Promise<void> =>
  page.evaluate(() => Promise.all(Array.from(document.querySelectorAll('[data-testid^="upgrade-card-"]')).flatMap((card) => card.getAnimations().map((animation) => animation.finished))).then(() => undefined));

test('hooks: round banner, upgrade cards in the thumb zone, the pick changes the game (P66 T4)', async ({ page, request }, info) => {
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
  await cardsSettled(page);
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
    // Nic (tlačítko akce, HUD) neleží přes rohy karty: klepnutí kamkoli na kartu je volba.
    const covered = await element.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const corners: Array<readonly [number, number]> = [
        [rect.left + 6, rect.top + 6],
        [rect.right - 6, rect.top + 6],
        [rect.left + 6, rect.bottom - 6],
        [rect.right - 6, rect.bottom - 6],
      ];
      return corners.filter(([x, y]) => !node.contains(document.elementFromPoint(x, y))).length;
    });
    expect(covered, `karta ${card} má zakrytý roh`).toBe(0);
  }
  // Tlačítka akcí na dobu nabídky zmizí (průsvitnou kartou by prosvítala a nabídka má jedinou volbu).
  await expect(page.locator('.play-stage .play-fire:visible')).toHaveCount(0);
  await shot('cards');

  // Volba: klepnutí na telefonu, klávesa na desktopu – jádro vezme tutéž kartu, ne výchozí.
  const picks = await picksSeen(page);
  if (touch) await page.getByTestId(`upgrade-card-${CARD}`).tap();
  else await page.keyboard.press(String(CARD + 1));
  await expect.poll(() => picksSeen(page)).toBeGreaterThan(picks);
  expect(await lastOf(page, 'upgrade_pick')).toEqual({ kind: 'upgrade_pick', card: CARD, upgrade: offer.offer[CARD] });
  await expect(cards).toBeHidden();
  await shot('picked');

  // Souboj nemá co sebrat, takže výsledek žádné nálezy neukáže.
  await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).handPlay('end'));
  await expect(page.getByTestId('play-outcome')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-found')).toHaveCount(0);
});

/**
 * Střílečka `genre.v6` (P66 T10): buňka `shooter` z `evals/play/p58a/framing-cells.json`, jen přeložená jako `genre.v6` –
 * výběr vylepšení mezi vlnami dostane sama, bez klíčů v `tuning`.
 */
function shooterV6(): unknown {
  const framing = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p58a/framing-cells.json'), 'utf8')) as { shooter: { spec: { genre: object } } };
  const { spec } = framing.shooter;
  return { ...spec, genre: { ...spec.genre, compilerVersion: 'genre.v6' } };
}

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('hooks: the shooter offers upgrades between waves, clear of the fire button and the bottom HUD row (P66 T10)', async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const touch = info.project.name === 'pixel7-touch';
  mkdirSync(SHOTS, { recursive: true });
  const response = await request.post('/api/play/games', { data: { spec: shooterV6() } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  await page.goto(((await response.json()) as { url: string }).url);
  await expect(page.getByTestId('arcade-stage')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => window.__playHooks !== undefined && window.__playShell !== undefined, null, { timeout: 60_000 });

  // Střílečka bez háčků v `tuning` začne kolem a mezi vlnami nabídne karty.
  expect(await playUntil(page, 'round_start'), 'střílečka nezačala kolo').not.toBeNull();
  await expect(page.getByTestId('hook-round-banner')).toHaveText(/^Round 1 of 3$/);
  expect(await playUntil(page, 'upgrade_offer'), 'střílečka nenabídla vylepšení').not.toBeNull();
  const offer = (await lastOf(page, 'upgrade_offer')) as Extract<HookEffect, { kind: 'upgrade_offer' }>;
  await expect(page.getByTestId('upgrade-pick')).toBeVisible();
  await cardsSettled(page);

  // Karty nepřekrývají tlačítko střelby ani dolní řadu HUD: tlačítka akcí na dobu nabídky zmizí (T4), dolní řada zůstane.
  await expect(page.locator('.play-stage .play-fire:visible')).toHaveCount(0);
  const blockers: Box[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.play-fire, .play-hud-bottom'))
      .filter((node) => getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none')
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })),
  );
  expect(blockers.length, 'dolní řada HUD chybí – kontrola by nic neměřila').toBeGreaterThan(0);
  const viewport = page.viewportSize()!;
  for (const [card, upgrade] of offer.offer.entries()) {
    const element = page.getByTestId(`upgrade-card-${card}`);
    await expect(element).toHaveAttribute('data-upgrade', upgrade);
    const box = (await element.boundingBox())!;
    for (const blocker of blockers) expect(overlaps(box, blocker), `karta ${card} leží přes tlačítko nebo dolní řadu HUD`).toBe(false);
    if (touch) expect(box.y, `karta ${card} nad dolními 45 % výšky`).toBeGreaterThanOrEqual(viewport.height * 0.55);
  }
  await page.screenshot({ path: join(SHOTS, `${info.project.name}-shooter-cards.png`) });

  // Volba změní hru i tady: jádro vezme kartu, kterou hráč vybral.
  const picks = await picksSeen(page);
  if (touch) await page.getByTestId(`upgrade-card-${CARD}`).tap();
  else await page.keyboard.press(String(CARD + 1));
  await expect.poll(() => picksSeen(page)).toBeGreaterThan(picks);
  expect(await lastOf(page, 'upgrade_pick')).toEqual({ kind: 'upgrade_pick', card: CARD, upgrade: offer.offer[CARD] });
  await expect(page.getByTestId('upgrade-pick')).toBeHidden();
});

test('hooks: a collecting game with rarity shows the finds by rarity on the result (P66 T4)', async ({ page, request }, info) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.goto(await publishFixture(request, RARITY_FIXTURE));
  await expect(page.getByTestId('arcade-stage')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => window.__playShell !== undefined, null, { timeout: 60_000 });

  await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).handPlay('end'));
  const found = page.getByTestId('play-found');
  await expect(found).toBeVisible({ timeout: 30_000 });
  await expect(found).toContainText(/\d+ common \d+ rare \d+ epic/);
  await page.screenshot({ path: join(SHOTS, `${info.project.name}-result.png`) });
});
